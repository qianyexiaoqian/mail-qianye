"""郵箱管理 - 數據層與前端 API。

所有給前端調用的方法都在 Api 類裡，pywebview 通過 js_api 暴露，
開發模式下 devserver.py 通過 HTTP 暴露同一個類。
"""
import functools
import json
import os
import re
import sqlite3
import sys
import threading
import time
import uuid

import pyotp

try:
    # 用 Windows 系統的證書驗證代替 Python 自帶的：新裝的系統證書庫不全時（根證書按需下載），
    # Python 會報 CERTIFICATE_VERIFY_FAILED；公司代理裝的根證書也能被信任
    import truststore

    truststore.inject_into_ssl()
except ImportError:
    pass

import aifix
import billionmail
import mailfetch
import vault

STATUSES = ["正常", "待驗證", "異常", "封禁", "停用"]
FIELDS = ["email", "password", "totp_secret", "recovery_email", "recovery_password",
          "oauth_client_id", "oauth_token", "phone", "notes"]
SECRET_FIELDS = ("password", "totp_secret", "recovery_password", "oauth_token")  # 加密存儲的字段
# 微軟 OAuth2（帶令牌）的輔助郵箱：oauth_client_id = 應用 ClientID，oauth_token = refresh token


def app_dir():
    """數據文件放在 exe 旁邊（便攜），源碼運行時放在腳本旁邊。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def resource_dir():
    """打包後的靜態資源目錄。"""
    return getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))


SCHEMA = """
CREATE TABLE IF NOT EXISTS sheets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    columns TEXT NOT NULL DEFAULT '[]',
    sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#4f7cff',
    sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sheet_id INTEGER NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    password TEXT NOT NULL DEFAULT '',
    totp_secret TEXT NOT NULL DEFAULT '',
    recovery_email TEXT NOT NULL DEFAULT '',
    recovery_password TEXT NOT NULL DEFAULT '',
    oauth_client_id TEXT NOT NULL DEFAULT '',
    oauth_token TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    group_id INTEGER,
    status TEXT NOT NULL DEFAULT '正常',
    notes TEXT NOT NULL DEFAULT '',
    extra TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_sheet ON accounts(sheet_id);
CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_mode ON chats(mode, updated_at);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def clean_secret(secret):
    secret = (secret or "").strip()
    if secret.lower().startswith("otpauth://"):
        from urllib.parse import parse_qs, urlparse

        secret = (parse_qs(urlparse(secret).query).get("secret") or [""])[0]
    return re.sub(r"[\s-]", "", secret).upper()


def totp_now(secret):
    s = clean_secret(secret)
    if not s:
        return ""
    try:
        return pyotp.TOTP(s).now()
    except Exception:
        return "密鑰無效"


class Store:
    def __init__(self, path):
        self.lock = threading.Lock()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self._migrate()
        if not self.conn.execute("SELECT 1 FROM sheets LIMIT 1").fetchone():
            self.conn.execute("INSERT INTO sheets(name) VALUES ('默認列表')")
        self.conn.commit()

    def _migrate(self):
        """為舊版數據庫補上新增的列。"""
        cols = {r["name"] for r in self.conn.execute("PRAGMA table_info(accounts)")}
        for col in ("oauth_client_id", "oauth_token"):
            if col not in cols:
                self.conn.execute(f"ALTER TABLE accounts ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")
        # 列表類型：'' = 普通列表，'selfmail' = 自建郵箱管理窗口用的列表（和 BillionMail 後台同步）
        if "kind" not in {r["name"] for r in self.conn.execute("PRAGMA table_info(sheets)")}:
            self.conn.execute("ALTER TABLE sheets ADD COLUMN kind TEXT NOT NULL DEFAULT ''")
        self.conn.commit()

    def query(self, sql, args=()):
        with self.lock:
            return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    def execute(self, sql, args=()):
        with self.lock:
            cur = self.conn.execute(sql, args)
            self.conn.commit()
            return cur.lastrowid

    def executemany(self, sql, rows):
        with self.lock:
            self.conn.executemany(sql, rows)
            self.conn.commit()

    def get_setting(self, key):
        rows = self.query("SELECT value FROM settings WHERE key=?", (key,))
        return rows[0]["value"] if rows else None


def need_unlock(fn):
    @functools.wraps(fn)
    def wrapper(self, *args, **kwargs):
        if self._cipher is None:
            raise PermissionError("err.locked")
        return fn(self, *args, **kwargs)

    return wrapper


COLUMN_TYPES = ("text", "color", "country", "emoji", "image")


def normalize_column(col):
    """舊版列只是名字，extra 以名字為 key，所以 id 就用名字。"""
    if isinstance(col, str):
        return {"id": col, "name": col.strip(), "type": "text"}
    name = (col.get("name") or "").strip()
    return {
        "id": col.get("id") or name,
        "name": name,
        "type": col.get("type") if col.get("type") in COLUMN_TYPES else "text",
    }


class Api:
    def __init__(self, db_path=None):
        self.db_path = db_path or os.path.join(app_dir(), "mail_data.db")
        self._store = Store(self.db_path)
        self._window = None  # 由 main.py 注入，用於文件對話框
        self._self_window = None  # 自建郵箱管理窗口（第二個窗口）
        self._cipher = None  # 解鎖後才有
        self._admin = None  # BillionMail 後台客戶端（登錄一次後復用）
        self._pw_cache = {}  # 管理員模式下解析到的郵箱密碼緩存（內存，鎖定即清）
        self._ai_jobs = {}  # AI 糾錯任務：job_id -> {"text", "done", "error", "stop"}
        self._progress = {}  # 長任務進度：progress_id -> {"done", "total", "current"}，前端輪詢 get_progress
        self._selfmail_lock = threading.RLock()  # 自建郵箱的新建 / 同步不能交錯進行

    # ---------- 主密碼 ----------
    def get_lock_state(self):
        return {"has_password": self._store.get_setting("verifier") is not None, "unlocked": self._cipher is not None}

    def setup_password(self, password):
        """首次設置主密碼，並把已有的明文數據加密。"""
        if self._store.get_setting("verifier") is not None:
            raise ValueError("err.already_set")
        self._rekey(None, password)

    def unlock(self, password):
        salt = self._store.get_setting("kdf_salt")
        if salt is None:
            raise ValueError("err.not_set")
        n = int(self._store.get_setting("kdf_n") or vault.SCRYPT_N)
        cipher = vault.Cipher(vault.derive_key(password or "", salt, n))
        if not cipher.check(self._store.get_setting("verifier")):
            time.sleep(0.5)  # 減慢暴力嘗試
            raise vault.WrongPassword("err.wrong_password")
        self._cipher = cipher

    def lock(self):
        self._cipher = None
        self._admin = None
        self._pw_cache = {}
        for job in self._ai_jobs.values():
            job["stop"] = True
        self._ai_jobs = {}

    @need_unlock
    def change_password(self, old_password, new_password):
        old = self._cipher
        self.unlock(old_password)  # 校驗舊密碼
        self._rekey(old, new_password)

    def _rekey(self, old, password):
        """用新主密碼重新加密所有敏感字段，在一個事務裡完成。old 為 None 表示現有數據是明文。"""
        if len(password or "") < 4:
            raise ValueError("err.pw_short")
        salt = vault.new_salt()
        cipher = vault.Cipher(vault.derive_key(password, salt))
        settings = {"kdf_salt": salt, "kdf_n": str(vault.SCRYPT_N), "verifier": cipher.encrypt(vault.VERIFIER)}
        for name, keys in (("mail_config", self._MAIL_SECRETS), ("ai_config", self._AI_SECRETS)):
            cfg = json.loads(self._store.get_setting(name) or "{}")
            changed = False
            for key in keys:  # 配置裡的密碼 / Key 也跟著換密鑰
                if cfg.get(key):
                    plain = old.decrypt(cfg[key]) if old else cfg[key]
                    cfg[key] = cipher.encrypt(plain)
                    changed = True
            if changed:
                settings[name] = json.dumps(cfg, ensure_ascii=False)
        st = self._store
        with st.lock:
            conn = st.conn
            rows = conn.execute(f"SELECT id, {', '.join(SECRET_FIELDS)} FROM accounts").fetchall()
            updates = []
            for r in rows:
                plain = [old.decrypt(r[f]) if old else r[f] for f in SECRET_FIELDS]
                updates.append([cipher.encrypt(v) for v in plain] + [r["id"]])
            sets = ", ".join(f"{f}=?" for f in SECRET_FIELDS)
            chats = []
            for r in conn.execute("SELECT id, title, data FROM chats").fetchall():
                plain = [old.decrypt(r[f]) if old else r[f] for f in ("title", "data")]
                chats.append([cipher.encrypt(v) for v in plain] + [r["id"]])
            try:
                conn.executemany("UPDATE chats SET title=?, data=? WHERE id=?", chats)
                conn.executemany(f"UPDATE accounts SET {sets} WHERE id=?", updates)
                conn.executemany("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)", list(settings.items()))
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        self._cipher = cipher

    def _encrypt_row(self, values):
        for f in SECRET_FIELDS:
            values[f] = self._cipher.encrypt(values.get(f, ""))
        return values

    def _decrypt_row(self, row):
        for f in SECRET_FIELDS:
            row[f] = self._cipher.decrypt(row[f])
        return row

    # ---------- 界面偏好（不需要解鎖，鎖屏也要用主題和語言） ----------
    # mode：'' = 主窗口，'selfmail' = 自建郵箱管理窗口（各自記住列寬、篩選等）
    def get_prefs(self, mode=""):
        return json.loads(self._store.get_setting("ui_prefs" + (f"_{mode}" if mode else "")) or "{}")

    def set_prefs(self, prefs, mode=""):
        self._store.execute(
            "INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)",
            ("ui_prefs" + (f"_{mode}" if mode else ""), json.dumps(prefs, ensure_ascii=False)),
        )

    def set_window_title(self, title, mode=""):
        window = self._self_window if mode == "selfmail" else self._window
        if window is not None:
            window.title = title

    def open_selfmail_window(self, title="自建郵箱管理"):
        """打開（或切換到）自建郵箱管理窗口。開發模式（瀏覽器）沒有窗口，返回 None 由前端打開新標籤頁。"""
        if self._window is None:
            return None
        import webview

        if self._self_window is not None:
            try:
                self._self_window.restore()
                self._self_window.show()
                return True
            except Exception:
                self._self_window = None
        url = (self._window.real_url or "").split("?")[0] + "?mode=selfmail"
        win = webview.create_window(title, url, js_api=self, width=1360, height=840, min_size=(1000, 600))

        def on_closed():
            self._self_window = None

        win.events.closed += on_closed
        self._self_window = win
        return True

    # ---------- 基礎 ----------
    def get_meta(self):
        return {
            "statuses": STATUSES,
            "fields": FIELDS,
            "db_path": self.db_path,
        }

    @need_unlock
    def get_state(self):
        sheets = self._store.query(
            "SELECT s.*, (SELECT COUNT(*) FROM accounts a WHERE a.sheet_id = s.id) AS count "
            "FROM sheets s ORDER BY sort, id"
        )
        for s in sheets:
            s["columns"] = [normalize_column(c) for c in json.loads(s["columns"] or "[]")]
        groups = self._store.query(
            "SELECT g.*, (SELECT COUNT(*) FROM accounts a WHERE a.group_id = g.id) AS count "
            "FROM groups g ORDER BY sort, id"
        )
        return {"sheets": sheets, "groups": groups}

    # ---------- 列表（表格） ----------
    @need_unlock
    def add_sheet(self, name):
        name = (name or "").strip() or "新列表"
        return self._store.execute(
            "INSERT INTO sheets(name, sort) VALUES (?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM sheets))", (name,))

    @need_unlock
    def rename_sheet(self, sheet_id, name):
        self._store.execute("UPDATE sheets SET name=? WHERE id=?", (name.strip(), sheet_id))

    @need_unlock
    def set_sheet_columns(self, sheet_id, columns):
        cols = [normalize_column(c) for c in columns]
        cols = [c for c in cols if c["name"]]
        self._store.execute("UPDATE sheets SET columns=? WHERE id=?", (json.dumps(cols, ensure_ascii=False), sheet_id))

    @need_unlock
    def delete_sheet(self, sheet_id):
        if len(self._store.query("SELECT id FROM sheets")) <= 1:
            raise ValueError("err.keep_one_sheet")
        self._store.execute("DELETE FROM accounts WHERE sheet_id=?", (sheet_id,))
        self._store.execute("DELETE FROM sheets WHERE id=?", (sheet_id,))

    # ---------- 分組 ----------
    @need_unlock
    def add_group(self, name, color="#4f7cff"):
        name = (name or "").strip() or "新分組"
        return self._store.execute(
            "INSERT INTO groups(name, color, sort) VALUES (?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM groups))", (name, color))

    @need_unlock
    def update_group(self, group_id, name, color):
        self._store.execute("UPDATE groups SET name=?, color=? WHERE id=?", (name.strip(), color, group_id))

    @need_unlock
    def reorder(self, kind, ids):
        """按給出的 id 順序排列分組（kind="groups"）或列表（kind="sheets"），沒給出的排在後面。"""
        table = {"groups": "groups", "sheets": "sheets"}[kind]
        ids = [int(i) for i in ids or []]
        rest = [r["id"] for r in self._store.query(f"SELECT id FROM {table} ORDER BY sort, id") if r["id"] not in ids]
        self._store.executemany(f"UPDATE {table} SET sort=? WHERE id=?", [(i, gid) for i, gid in enumerate(ids + rest)])

    @need_unlock
    def delete_group(self, group_id):
        self._store.execute("UPDATE accounts SET group_id=NULL WHERE group_id=?", (group_id,))
        self._store.execute("DELETE FROM groups WHERE id=?", (group_id,))

    # ---------- 賬號 ----------
    @need_unlock
    def list_accounts(self, sheet_id):
        rows = self._store.query("SELECT * FROM accounts WHERE sheet_id=? ORDER BY id DESC", (sheet_id,))
        for r in rows:
            r["extra"] = json.loads(r["extra"] or "{}")
            self._decrypt_row(r)
        return rows

    @need_unlock
    def save_account(self, data):
        now = int(time.time())
        values = {f: (data.get(f) or "").strip() for f in FIELDS}
        values["notes"] = (data.get("notes") or "").rstrip()
        values["totp_secret"] = clean_secret(values["totp_secret"])
        self._encrypt_row(values)
        status = data.get("status") or "正常"
        group_id = data.get("group_id") or None
        extra = json.dumps(data.get("extra") or {}, ensure_ascii=False)
        if data.get("id"):
            self._selfmail_check_updates([(data["id"], {"email": data.get("email"), "password": data.get("password") or ""})])
            self._selfmail_status([data["id"]], status)
            sets = ", ".join(f"{f}=?" for f in FIELDS)
            self._store.execute(
                f"UPDATE accounts SET {sets}, status=?, group_id=?, extra=?, updated_at=? WHERE id=?",
                [values[f] for f in FIELDS] + [status, group_id, extra, now, data["id"]],
            )
            return data["id"]
        cols = ", ".join(FIELDS)
        marks = ", ".join("?" for _ in FIELDS)
        return self._store.execute(
            f"INSERT INTO accounts(sheet_id, {cols}, status, group_id, extra, created_at, updated_at) "
            f"VALUES (?, {marks}, ?, ?, ?, ?, ?)",
            [data["sheet_id"]] + [values[f] for f in FIELDS] + [status, group_id, extra, now, now],
        )

    @need_unlock
    def delete_accounts(self, ids):
        rows = self._selfmail_ids(ids)
        if rows:  # 自建郵箱：先在後台刪除，成功了再刪本地
            self._admin_client(self._admin_cfg()).delete_mailboxes([r["email"] for r in rows.values()])
        self._bulk("DELETE FROM accounts WHERE id IN ({})", ids)

    @need_unlock
    def set_group(self, ids, group_id):
        self._bulk("UPDATE accounts SET group_id=? WHERE id IN ({})", ids, [group_id or None])

    @need_unlock
    def set_status(self, ids, status):
        self._selfmail_status(ids, status)
        self._bulk("UPDATE accounts SET status=? WHERE id IN ({})", ids, [status])

    @need_unlock
    def move_accounts(self, ids, sheet_id):
        self._bulk("UPDATE accounts SET sheet_id=? WHERE id IN ({})", ids, [sheet_id])

    @need_unlock
    def update_fields(self, updates):
        """批量改字段：updates = [{"id": 1, "fields": {"notes": "...", "phone": "..."}}]，只改給出的字段。"""
        now = int(time.time())
        self._selfmail_check_updates([(u["id"], u.get("fields") or {}) for u in updates or []])
        st = self._store
        with st.lock:
            for u in updates or []:
                fields = {k: str(v if v is not None else "").strip() for k, v in (u.get("fields") or {}).items() if k in FIELDS}
                if not fields:
                    continue
                if "totp_secret" in fields:
                    fields["totp_secret"] = clean_secret(fields["totp_secret"])
                for k in fields:
                    if k in SECRET_FIELDS:
                        fields[k] = self._cipher.encrypt(fields[k])
                sets = ", ".join(f"{k}=?" for k in fields)
                st.conn.execute(f"UPDATE accounts SET {sets}, updated_at=? WHERE id=?", [*fields.values(), now, int(u["id"])])
            st.conn.commit()

    @need_unlock
    def set_extra(self, ids, key, value):
        ids = [int(i) for i in ids]
        if not ids:
            return
        now = int(time.time())
        st = self._store
        with st.lock:
            rows = st.conn.execute(f"SELECT id, extra FROM accounts WHERE id IN ({','.join('?' for _ in ids)})", ids).fetchall()
            updates = []
            for r in rows:
                extra = json.loads(r["extra"] or "{}")
                if value in (None, ""):
                    extra.pop(key, None)
                else:
                    extra[key] = value
                updates.append((json.dumps(extra, ensure_ascii=False), now, r["id"]))
            st.conn.executemany("UPDATE accounts SET extra=?, updated_at=? WHERE id=?", updates)
            st.conn.commit()

    def _bulk(self, sql, ids, head=()):
        ids = [int(i) for i in ids]
        if not ids:
            return
        self._store.execute(sql.format(",".join("?" for _ in ids)), list(head) + ids)

    # ---------- 自建郵箱（BillionMail 後台管理員） ----------
    # 只需要填後台地址和管理員賬號：域名列表、每個郵箱的密碼、收信服務器都自動獲取
    _MAIL_DEFAULTS = {"panel_url": "", "safe_path": "", "admin_user": "", "admin_verify_cert": False, "limit": 15}
    _MAIL_SECRETS = ("admin_password",)

    def _mail_config(self, with_secret=False):
        saved = json.loads(self._store.get_setting("mail_config") or "{}")
        cfg = {**self._MAIL_DEFAULTS, **{k: v for k, v in saved.items() if k in self._MAIL_DEFAULTS}}
        cfg["legacy_host"] = saved.get("host") or ""  # 舊版手填的收信服務器，作為候選之一
        for key in self._MAIL_SECRETS:
            enc = saved.get(key, "")
            cfg["has_" + key] = bool(enc)
            if with_secret:
                cfg[key] = self._cipher.decrypt(enc) if enc else ""
        cfg["configured"] = bool(cfg["panel_url"] and cfg["admin_user"] and cfg["has_admin_password"])
        return cfg

    @need_unlock
    def get_mail_config(self):
        return self._mail_config()

    @need_unlock
    def set_mail_config(self, cfg):
        """密碼字段：None / 不傳 = 保持原值，"" = 清除。"""
        old = json.loads(self._store.get_setting("mail_config") or "{}")
        new = {k: cfg.get(k, v) for k, v in self._MAIL_DEFAULTS.items()}
        new["panel_url"] = (new["panel_url"] or "").strip().rstrip("/")
        if new["panel_url"] and not new["panel_url"].lower().startswith(("http://", "https://")):
            new["panel_url"] = "https://" + new["panel_url"]
        new["safe_path"] = (new["safe_path"] or "").strip()
        new["admin_user"] = (new["admin_user"] or "").strip()
        if old.get("host"):
            new["host"] = old["host"]
        for key in self._MAIL_SECRETS:
            pw = cfg.get(key)
            if pw is None:
                new[key] = old.get(key, "")
            else:
                new[key] = self._cipher.encrypt(pw) if pw else ""
        self._store.execute(
            "INSERT OR REPLACE INTO settings(key, value) VALUES ('mail_config', ?)", (json.dumps(new, ensure_ascii=False),)
        )
        self._admin = None  # 配置變了，重建後台連接
        self._pw_cache = {}

    def _admin_client(self, cfg, fresh=False):
        if fresh or self._admin is None:
            self._admin = billionmail.BillionMailAdmin(
                cfg.get("panel_url"), cfg.get("safe_path"), cfg.get("admin_user"),
                cfg.get("admin_password"), cfg.get("admin_verify_cert"))
        return self._admin

    def _resolve_password(self, cfg, address, fresh=False):
        """從 BillionMail 後台取回該郵箱的登錄密碼（帶緩存）。"""
        if address in self._pw_cache and not fresh:
            return self._pw_cache[address]
        pw = self._admin_client(cfg).get_password(address)
        if not pw:
            raise ValueError("err.admin_no_mailbox")
        self._pw_cache[address] = pw
        return pw

    @need_unlock
    def test_billionmail_admin(self, cfg=None):
        """測試後台登錄，返回郵箱數量和域名列表（順便刷新域名緩存）。"""
        full = {**self._mail_config(with_secret=True), **(cfg or {})}
        if cfg is not None and cfg.get("admin_password") in (None, ""):
            # 測試時未重新輸入密碼 → 用已保存的
            full["admin_password"] = self._mail_config(with_secret=True).get("admin_password", "")
        client = billionmail.BillionMailAdmin(
            full.get("panel_url"), full.get("safe_path"), full.get("admin_user"),
            full.get("admin_password"), full.get("admin_verify_cert"))
        total = client.list_mailboxes()
        domains = client.list_domains()
        self._save_domain_cache(domains)
        return {"total": total, "domains": [d["domain"] for d in domains]}

    def _admin_cfg(self):
        cfg = self._mail_config(with_secret=True)
        if not cfg.get("panel_url"):
            raise ValueError("err.admin_required")
        return cfg

    # 域名緩存（存數據庫）：後台暫時連不上時域名下拉框、收信入口照樣可用
    def _domain_cache(self):
        return json.loads(self._store.get_setting("selfmail_cache") or "{}")

    def _save_domain_cache(self, domains=None, good_host=None):
        cache = self._domain_cache()
        if domains is not None:
            cache["domains"] = domains
        if good_host:
            cache.setdefault("hosts", {}).update(good_host)
        self._store.execute("INSERT OR REPLACE INTO settings(key, value) VALUES ('selfmail_cache', ?)",
                            (json.dumps(cache, ensure_ascii=False),))

    @need_unlock
    def selfmail_domains(self, refresh=True):
        """自建郵箱的域名列表（來自 BillionMail 後台）。refresh=False 只返回緩存，不連後台。"""
        cfg = self._mail_config(with_secret=True)
        error = ""
        if refresh and cfg.get("panel_url"):
            try:
                self._save_domain_cache(self._admin_client(cfg).list_domains())
            except Exception as e:  # 後台連不上就用上次的緩存
                error = str(e)
        domains = [d["domain"] for d in self._domain_cache().get("domains", [])]
        return {"domains": domains if cfg.get("panel_url") else [], "configured": cfg["configured"], "error": error}

    def _imap_hosts(self, cfg, domain):
        """收信服務器候選：上次成功的 → 舊版手填的 → 後台域名的郵件服務器（A 記錄）→ 後台地址的主機 → mail.域名。"""
        from urllib.parse import urlparse

        cache = self._domain_cache()
        a_record = next((d.get("a_record") for d in cache.get("domains", []) if d.get("domain") == domain), "")
        hosts = [cache.get("hosts", {}).get(domain), cache.get("mx", {}).get(domain), cfg.get("legacy_host"), a_record,
                 urlparse(cfg.get("panel_url") or "").hostname, f"mail.{domain}"]
        out = []
        for h in hosts:
            h = (h or "").strip().lower()
            if h and h not in out:
                out.append(h)
        return out

    @staticmethod
    def _local_part(address):
        """主郵箱 john.doe+x@gmail.com → johndoe（BillionMail 只允許字母數字 _ -）。"""
        local = (address or "").split("@")[0].split("+")[0].lower()
        return re.sub(r"[^a-z0-9_-]", "", local)

    def _create_self_mailbox(self, cfg, main_email, domain):
        domain = (domain or "").strip().lower().lstrip("@")
        base = self._local_part(main_email)
        if not domain or not base:
            raise ValueError("err.selfmail_bad_input")
        client = self._admin_client(cfg)
        # 同名郵箱已存在時加數字後綴
        for i in range(0, 20):
            local = base if i == 0 else f"{base}{i + 1}"
            address = f"{local}@{domain}"
            if client.get_password(address) is None:
                break
        else:
            raise RuntimeError("err.selfmail_exists")
        password = vault.random_password(14)
        client.create_mailbox(domain, local, password)
        self._pw_cache[address] = password
        return {"address": address, "password": password}

    @need_unlock
    def create_self_mailbox(self, main_email, domain):
        """以主郵箱的用戶名在自建域名下創建郵箱，返回 {address, password}，由前端填進輔助郵箱。"""
        return self._create_self_mailbox(self._admin_cfg(), main_email, domain)

    @need_unlock
    def get_progress(self, progress_id):
        return self._progress.get(progress_id)

    def _set_progress(self, progress_id, **kw):
        if progress_id:
            self._progress.setdefault(progress_id, {"done": 0, "total": 0, "current": ""}).update(kw)

    @need_unlock
    def create_recovery_mailboxes(self, ids, domain, overwrite=False, progress_id=""):
        """批量：給這些賬號創建自建輔助郵箱並保存。已有輔助郵箱的默認跳過。"""
        cfg = self._admin_cfg()
        ids = [int(i) for i in ids or []]
        if not ids:
            return {"created": [], "skipped": 0, "failed": []}
        rows = self._store.query(f"SELECT * FROM accounts WHERE id IN ({','.join('?' for _ in ids)})", ids)
        created, failed, skipped = [], [], 0
        self._set_progress(progress_id, total=len(rows), done=0)
        for i, r in enumerate(rows):
            a = self._decrypt_row(r)
            self._set_progress(progress_id, done=i, current=a["email"])
            if a["recovery_email"] and not overwrite:
                skipped += 1
                continue
            try:
                box = self._create_self_mailbox(cfg, a["email"], domain)
            except Exception as e:
                failed.append({"email": a["email"], "error": str(e)})
                continue
            self._store.execute(
                "UPDATE accounts SET recovery_email=?, recovery_password=?, updated_at=? WHERE id=?",
                (box["address"], self._cipher.encrypt(box["password"]), int(time.time()), a["id"]),
            )
            created.append({"email": a["email"], "recovery_email": box["address"]})
        self._progress.pop(progress_id, None)
        return {"created": created, "skipped": skipped, "failed": failed}

    # ---------- 自建郵箱管理窗口：本地列表和 BillionMail 後台同步 ----------
    # 第二個窗口用一個 kind='selfmail' 的列表，表格、分組、篩選、收信、AI 助手都和主窗口一樣；
    # 新建 / 刪除 / 改密碼 / 停用直接寫到後台，「同步」把後台的郵箱拉下來（多的新增，少的刪除，密碼更新）。
    @need_unlock
    def selfmail_sheet(self):
        rows = self._store.query("SELECT id FROM sheets WHERE kind='selfmail' ORDER BY id LIMIT 1")
        if rows:
            return rows[0]["id"]
        return self._store.execute(
            "INSERT INTO sheets(name, kind, sort) VALUES ('自建郵箱', 'selfmail', (SELECT COALESCE(MAX(sort), 0) + 1 FROM sheets))")

    def _selfmail_ids(self, ids):
        """ids 裡屬於自建郵箱列表的行：{id: 解密後的行}"""
        ids = [int(i) for i in ids or []]
        if not ids:
            return {}
        marks = ",".join("?" for _ in ids)
        rows = self._store.query(
            f"SELECT a.* FROM accounts a JOIN sheets s ON s.id = a.sheet_id WHERE s.kind='selfmail' AND a.id IN ({marks})", ids)
        return {r["id"]: self._decrypt_row(r) for r in rows}

    @need_unlock
    def selfmail_sync(self):
        with self._selfmail_lock:  # 正在新建時等它完成，避免把還沒寫分組的郵箱先拉進來
            return self._selfmail_sync()

    def _selfmail_sync(self):
        cfg = self._admin_cfg()
        boxes = self._admin_client(cfg).all_mailboxes()
        sid = self.selfmail_sheet()
        local = {r["email"].lower(): r for r in
                 self._store.query("SELECT id, email, password, status FROM accounts WHERE sheet_id=?", (sid,))}
        now = int(time.time())
        added = updated = removed = 0
        seen, mx = set(), {}
        cols = ", ".join(FIELDS)
        marks = ", ".join("?" for _ in FIELDS)
        st = self._store
        with st.lock:
            for b in boxes:
                email = (b.get("username") or "").strip()
                if not email:
                    continue
                key = email.lower()
                seen.add(key)
                pw = b.get("password") or ""
                active = str(b.get("active", 1)) not in ("0", "False", "false")
                if b.get("mx"):
                    mx[key.split("@")[-1]] = b["mx"]
                if pw:
                    self._pw_cache[email] = pw
                r = local.get(key)
                if r is None:
                    values = {f: "" for f in FIELDS}
                    values.update(email=email, password=pw)
                    self._encrypt_row(values)
                    st.conn.execute(
                        f"INSERT INTO accounts(sheet_id, {cols}, status, group_id, extra, created_at, updated_at) "
                        f"VALUES (?, {marks}, ?, NULL, ?, ?, ?)",
                        [sid] + [values[f] for f in FIELDS] + [STATUSES[0] if active else "停用", "{}", now, now])
                    added += 1
                    continue
                sets, args = [], []
                if pw and self._cipher.decrypt(r["password"]) != pw:
                    sets.append("password=?")
                    args.append(self._cipher.encrypt(pw))
                if not active and r["status"] != "停用":
                    sets.append("status=?")
                    args.append("停用")
                elif active and r["status"] == "停用":
                    sets.append("status=?")
                    args.append(STATUSES[0])
                if sets:
                    st.conn.execute(f"UPDATE accounts SET {', '.join(sets)}, updated_at=? WHERE id=?", args + [now, r["id"]])
                    updated += 1
            for key, r in local.items():
                if key not in seen:  # 後台已經沒有了
                    st.conn.execute("DELETE FROM accounts WHERE id=?", (r["id"],))
                    removed += 1
            st.conn.commit()
        if mx:  # 每個域名的郵件服務器，收信時優先嘗試
            cache = self._domain_cache()
            cache.setdefault("mx", {}).update(mx)
            st.execute("INSERT OR REPLACE INTO settings(key, value) VALUES ('selfmail_cache', ?)",
                       (json.dumps(cache, ensure_ascii=False),))
        return {"total": len(seen), "added": added, "updated": updated, "removed": removed}

    @need_unlock
    def selfmail_create(self, domain="", names=None, count=0, prefix="", password="", group_id=None, status=None,
                        progress_id=""):
        """批量新建自建郵箱：names = 用戶名或完整地址列表，或者 count 個「prefix + 6 位隨機字符」。
        password 留空 = 每個隨機密碼（也可以寫 {random}）。建好後直接加進自建郵箱列表。"""
        import secrets
        import string

        cfg = self._admin_cfg()
        client = self._admin_client(cfg)
        domain = (domain or "").strip().lower().lstrip("@")
        targets = []
        for n in names or []:
            n = str(n).strip()
            if not n:
                continue
            local, _, dom = n.partition("@")
            targets.append((re.sub(r"[^a-z0-9_-]", "", local.lower()), (dom or domain).strip().lower()))
        prefix = re.sub(r"[^a-z0-9_-]", "", (prefix or "").lower())
        for _ in range(max(0, min(int(count or 0), 500))):
            rand = "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(6))
            targets.append((prefix + rand, domain))
        if not targets:
            raise ValueError("err.selfmail_no_names")
        if password and "{random}" not in password and len(password) < 8:
            raise ValueError("err.selfmail_pw_short")
        sid = self.selfmail_sheet()
        created, failed = [], []
        self._set_progress(progress_id, total=len(targets), done=0, current="")
        try:
            with self._selfmail_lock:
                existing = {(m.get("username") or "").lower() for m in client.all_mailboxes()}  # 一次取完，不用逐個查
                for i, (local, dom) in enumerate(targets):
                    address = f"{local}@{dom}"
                    self._set_progress(progress_id, done=i, current=address)
                    if not local or not dom:
                        failed.append({"email": address, "error": "err.selfmail_bad_input"})
                        continue
                    try:
                        if address in existing:
                            raise RuntimeError("err.selfmail_exists")
                        pw = (password or "{random}").replace("{random}", vault.random_password(14))
                        client.create_mailbox(dom, local, pw)
                    except Exception as e:
                        failed.append({"email": address, "error": str(e)})
                        continue
                    existing.add(address)
                    self._pw_cache[address] = pw
                    # 建好一個就寫進本地一個：中途中斷或者別處同步過，分組也不會丟
                    self._selfmail_upsert(sid, address, pw, group_id, status or STATUSES[0])
                    created.append({"email": address, "password": pw})
        finally:
            self._progress.pop(progress_id, None)
        return {"created": created, "failed": failed}

    def _selfmail_upsert(self, sid, email, password, group_id, status):
        """自建郵箱列表裡加一行；已經有了（例如被同步拉進來過）就更新密碼、分組、狀態。"""
        now = int(time.time())
        row = self._store.query("SELECT id FROM accounts WHERE sheet_id=? AND lower(email)=?", (sid, email.lower()))
        enc = self._cipher.encrypt(password)
        if row:
            sets, args = ["password=?", "status=?"], [enc, status]
            if group_id:
                sets.append("group_id=?")
                args.append(group_id)
            self._store.execute(f"UPDATE accounts SET {', '.join(sets)}, updated_at=? WHERE id=?", args + [now, row[0]["id"]])
            return row[0]["id"]
        values = {f: "" for f in FIELDS}
        values.update(email=email, password=password)
        self._encrypt_row(values)
        return self._store.execute(
            f"INSERT INTO accounts(sheet_id, {', '.join(FIELDS)}, status, group_id, extra, created_at, updated_at) "
            f"VALUES (?, {', '.join('?' for _ in FIELDS)}, ?, ?, '{{}}', ?, ?)",
            [sid] + [values[f] for f in FIELDS] + [status, group_id or None, now, now])

    def _selfmail_push(self, row, password=None, active=None):
        """把改動寫到 BillionMail 後台（改密碼 / 停用 / 啟用）。"""
        client = self._admin_client(self._admin_cfg())
        m = client.get_mailbox(row["email"])
        if m is None:
            raise ValueError("err.admin_no_mailbox")
        client.update_mailbox(m, password=password, active=active)
        if password:
            self._pw_cache[row["email"]] = password

    def _selfmail_check_updates(self, updates):
        """自建郵箱列表的行：郵箱地址不能改；改了密碼就同步到後台。updates = [(id, {字段: 新值})]"""
        rows = self._selfmail_ids([i for i, _ in updates])
        for i, fields in updates:
            r = rows.get(int(i))
            if r is None:
                continue
            if "email" in fields and (fields["email"] or "").strip().lower() != r["email"].lower():
                raise ValueError("err.selfmail_email_readonly")
            new_pw = (fields.get("password") or "").strip()
            if "password" in fields and new_pw != r["password"]:
                if len(new_pw) < 8:
                    raise ValueError("err.selfmail_pw_short")
                self._selfmail_push(r, password=new_pw)

    def _selfmail_status(self, ids, status):
        """自建郵箱：狀態改成 / 改離「停用」時，在後台停用 / 啟用郵箱。"""
        for r in self._selfmail_ids(ids).values():
            if (status == "停用") != (r["status"] == "停用"):
                self._selfmail_push(r, active=0 if status == "停用" else 1)

    @need_unlock
    def fetch_mail(self, account_id, which="recovery", limit=None):
        """讀取某個賬號的輔助郵箱（which="recovery"）或主郵箱（which="email"）的最新郵件。
        limit：取最新多少封（INBOX + Junk 合計），0 = 全部；返回 total = 兩個文件夾的郵件總數。"""
        rows = self._store.query("SELECT * FROM accounts WHERE id=?", (int(account_id),))
        if not rows:
            raise ValueError("not found")
        a = self._decrypt_row(rows[0])
        if which == "email":
            address, password = a["email"], a["password"]
        else:
            address, password = a["recovery_email"], a["recovery_password"]
        cfg = self._mail_config(with_secret=True)
        limit = int(cfg.get("limit") or 15) if limit is None else int(limit)
        limit = mailfetch.MAX_MESSAGES if limit <= 0 else min(limit, mailfetch.MAX_MESSAGES)
        if mailfetch.is_microsoft(address):
            box = mailfetch.build_mailbox(cfg, address, password, a.get("oauth_client_id", ""), a.get("oauth_token", ""))
            return {"address": address, "provider": "microsoft", **mailfetch.fetch(box, limit)}
        result, used = self._fetch_self(cfg, address, password, limit)
        if used != password:  # 保存的密碼不對或沒有：把後台取回的正確密碼存下來，下次不會先登錄失敗（避免觸發 fail2ban）
            field = "password" if which == "email" else "recovery_password"
            self.update_fields([{"id": a["id"], "fields": {field: used}}])
        return {"address": address, "provider": "self", **result}

    def _fetch_self(self, cfg, address, saved_password, limit):
        """自建郵箱收信：密碼優先用保存的，沒有或登錄失敗就用管理員從後台取回的；
        收信服務器依次嘗試候選地址，成功的記下來下次直接用。"""
        if not cfg.get("panel_url"):
            raise ValueError("err.admin_required")
        domain = address.rsplit("@", 1)[-1].lower()
        password = saved_password or self._resolve_password(cfg, address)
        last_error = None
        for host in self._imap_hosts(cfg, domain):
            box = {"host": host, "port": 993, "ssl": True, "verify_cert": False, "address": address,
                   "auth": "basic", "user": address, "password": password}
            try:
                try:
                    result = mailfetch.fetch(box, limit)
                except PermissionError:
                    # 保存的密碼不對（或後台改過密碼）：用管理員重新取回的再試一次
                    fresh = self._resolve_password(cfg, address, fresh=True)
                    if fresh == password:
                        raise
                    password = box["password"] = fresh
                    result = mailfetch.fetch(box, limit)
            except ConnectionError as e:  # 這台服務器連不上：換下一個候選
                last_error = e
                continue
            self._save_domain_cache(good_host={domain: host})
            return result, password
        raise last_error or ConnectionError("err.mail_connect")

    # ---------- AI 助手的對話記錄（標題和內容都用主密碼加密，每個窗口最多保留 CHAT_LIMIT 個） ----------
    CHAT_LIMIT = 99

    @need_unlock
    def list_chats(self, mode=""):
        rows = self._store.query("SELECT id, title, created_at, updated_at FROM chats WHERE mode=? ORDER BY updated_at DESC, id DESC",
                                 (mode,))
        for r in rows:
            r["title"] = self._cipher.decrypt(r["title"])
        return rows

    @need_unlock
    def get_chat(self, chat_id):
        rows = self._store.query("SELECT * FROM chats WHERE id=?", (int(chat_id),))
        if not rows:
            return None
        r = rows[0]
        return {"id": r["id"], "title": self._cipher.decrypt(r["title"]), "updated_at": r["updated_at"],
                "data": json.loads(self._cipher.decrypt(r["data"]) or "{}")}

    @need_unlock
    def save_chat(self, chat_id, mode, title, data):
        """保存（chat_id 為空 = 新建），返回 id。超過 CHAT_LIMIT 個時刪掉最早的。時間用毫秒，連續保存也能排對順序。"""
        now = int(time.time() * 1000)
        enc_title = self._cipher.encrypt((title or "").strip()[:80])
        enc_data = self._cipher.encrypt(json.dumps(data or {}, ensure_ascii=False))
        st = self._store
        with st.lock:
            exists = chat_id and st.conn.execute("SELECT 1 FROM chats WHERE id=?", (int(chat_id),)).fetchone()
            if exists:
                st.conn.execute("UPDATE chats SET title=?, data=?, updated_at=? WHERE id=?", (enc_title, enc_data, now, int(chat_id)))
                cid = int(chat_id)
            else:
                cid = st.conn.execute("INSERT INTO chats(mode, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                                      (mode or "", enc_title, enc_data, now, now)).lastrowid
            st.conn.execute(
                "DELETE FROM chats WHERE mode=? AND id NOT IN "
                "(SELECT id FROM chats WHERE mode=? ORDER BY updated_at DESC, id DESC LIMIT ?)",
                (mode or "", mode or "", self.CHAT_LIMIT))
            st.conn.commit()
        return cid

    @need_unlock
    def rename_chat(self, chat_id, title):
        self._store.execute("UPDATE chats SET title=? WHERE id=?", (self._cipher.encrypt((title or "").strip()[:80]), int(chat_id)))

    @need_unlock
    def delete_chat(self, chat_id):
        self._store.execute("DELETE FROM chats WHERE id=?", (int(chat_id),))

    # ---------- AI 糾錯（OpenAI 兼容接口） ----------
    _AI_DEFAULTS = {"base_url": aifix.DEFAULT_BASE_URL, "model": aifix.DEFAULT_MODEL, "prompt": ""}
    _AI_SECRETS = ("api_key",)

    def _ai_config(self, with_secret=False):
        cfg = {**self._AI_DEFAULTS, **json.loads(self._store.get_setting("ai_config") or "{}")}
        cfg["prompt"] = cfg.get("prompt") or aifix.DEFAULT_PROMPT
        cfg["default_prompt"] = aifix.DEFAULT_PROMPT
        for key in self._AI_SECRETS:
            enc = cfg.pop(key, "")
            cfg["has_" + key] = bool(enc)
            if with_secret:
                cfg[key] = self._cipher.decrypt(enc) if enc else ""
        return cfg

    @need_unlock
    def get_ai_config(self):
        return self._ai_config()

    @need_unlock
    def set_ai_config(self, cfg):
        """Key：None / 不傳 = 保持原值，"" = 清除。提示詞和默認一樣時不保存，以後默認提示詞更新能自動生效。"""
        old = json.loads(self._store.get_setting("ai_config") or "{}")
        new = {k: (cfg.get(k, v) or "").strip() for k, v in self._AI_DEFAULTS.items()}
        if new["prompt"] == aifix.DEFAULT_PROMPT.strip():
            new["prompt"] = ""
        for key in self._AI_SECRETS:
            val = cfg.get(key)
            if val is None:
                new[key] = old.get(key, "")
            else:
                new[key] = self._cipher.encrypt(val.strip()) if val.strip() else ""
        self._store.execute(
            "INSERT OR REPLACE INTO settings(key, value) VALUES ('ai_config', ?)", (json.dumps(new, ensure_ascii=False),)
        )

    def _ai_full_config(self, cfg=None):
        """已保存的配置 + 界面上未保存的修改（Key 沒重新輸入時用已保存的）。"""
        full = self._ai_config(with_secret=True)
        for k, v in (cfg or {}).items():
            if k in self._AI_SECRETS and v in (None, ""):
                continue
            full[k] = v
        return full

    @need_unlock
    def test_ai(self, cfg=None):
        return {"reply": aifix.test(self._ai_full_config(cfg))}

    @need_unlock
    def ai_fix_start(self, lines):
        """後台線程流式請求，前端用 ai_fix_poll 輪詢增量文本。"""
        lines = [str(x) for x in (lines or []) if str(x).strip()]
        if not lines:
            raise ValueError("err.ai_no_lines")
        cfg = self._ai_full_config()
        return self._start_ai_job(cfg, aifix.fix_messages(cfg.get("prompt"), lines))

    @need_unlock
    def ai_chat_start(self, messages, tools=None):
        """AI 助手：前端維護對話和執行工具，這裡只負責一輪流式請求。結束時 poll 返回 tool_calls。"""
        return self._start_ai_job(self._ai_full_config(), messages, tools)

    def _start_ai_job(self, cfg, messages, tools=None):
        job_id = uuid.uuid4().hex
        job = {"text": "", "done": False, "error": "", "stop": False, "tool_calls": [], "tool": "", "tool_chars": 0}
        self._ai_jobs[job_id] = job

        def run():
            def on_delta(piece):
                job["text"] += piece

            def on_tool(calls):  # 模型正在生成工具調用：記下工具名和參數長度，前端顯示「正在準備…」
                if calls:
                    job["tool"] = calls[-1]["function"]["name"]
                    job["tool_chars"] = sum(len(c["function"]["arguments"]) for c in calls)

            try:
                job["tool_calls"] = aifix.stream_chat(cfg, messages, on_delta, lambda: job["stop"], tools, on_tool)
            except Exception as e:  # 錯誤帶回前端
                job["error"] = str(e)
            finally:
                job["done"] = True

        threading.Thread(target=run, daemon=True).start()
        return job_id

    @need_unlock
    def ai_fix_poll(self, job_id, offset=0):
        """offset 用上次返回的值（Python 字符下標，和 JS 字符串長度不一定相同）。"""
        offset = int(offset or 0)
        job = self._ai_jobs.get(job_id)
        if job is None:
            return {"delta": "", "offset": offset, "done": True, "error": "", "tool_calls": []}
        done = job["done"]  # 先讀 done 再讀文本，保證結束前的最後一段不會漏
        text = job["text"]
        if done:
            self._ai_jobs.pop(job_id, None)
        return {"delta": text[offset:], "offset": len(text), "done": done, "error": job["error"],
                "tool_calls": job["tool_calls"] if done else [], "tool": job["tool"], "tool_chars": job["tool_chars"]}

    def ai_fix_stop(self, job_id):
        job = self._ai_jobs.pop(job_id, None)
        if job:
            job["stop"] = True

    # ---------- 2FA ----------
    def totp_codes(self, secrets):
        """批量生成驗證碼，返回 {secret: code}。"""
        return {s: totp_now(s) for s in set(secrets) if s}

    # ---------- 導入 / 導出 ----------
    @need_unlock
    def import_rows(self, sheet_id, rows, group_id=None, status="正常", skip_dup=True, extra=None, _selfmail=False):
        """rows：前端已解析好的行（字段見 FIELDS，可帶每行自己的 extra，例如國家）。
        extra：所有導入行共用的自定義列值，例如顏色標記、國家；行自己的值優先。"""
        if not _selfmail and self._store.query("SELECT 1 FROM sheets WHERE id=? AND kind='selfmail'", (sheet_id,)):
            raise ValueError("err.selfmail_use_create")  # 自建郵箱列表只能用「新建郵箱」，保證和後台一致
        common = {k: v for k, v in (extra or {}).items() if v}
        existing = set()
        if skip_dup:
            existing = {r["email"].lower() for r in self._store.query("SELECT email FROM accounts WHERE sheet_id=?", (sheet_id,))}
        now = int(time.time())
        batch = []
        skipped = 0
        for r in rows or []:
            values = {f: str(r.get(f) or "").strip() for f in FIELDS}
            key = values["email"].lower()
            if not key:
                continue
            if key in existing:
                skipped += 1
                continue
            existing.add(key)
            values["totp_secret"] = clean_secret(values["totp_secret"])
            row_extra = {**common, **{k: v for k, v in (r.get("extra") or {}).items() if v}}
            self._encrypt_row(values)
            batch.append([sheet_id] + [values[f] for f in FIELDS]
                         + [status, group_id or None, json.dumps(row_extra, ensure_ascii=False), now, now])
        cols = ", ".join(FIELDS)
        marks = ", ".join("?" for _ in FIELDS)
        sql = (f"INSERT INTO accounts(sheet_id, {cols}, status, group_id, extra, created_at, updated_at) "
               f"VALUES (?, {marks}, ?, ?, ?, ?, ?)")
        ids = []
        st = self._store
        with st.lock:  # 逐條插入以拿到新 id（AI 助手撤銷用），一次提交
            for row in batch:
                ids.append(st.conn.execute(sql, row).lastrowid)
            st.conn.commit()
        return {"added": len(batch), "skipped": skipped, "ids": ids}

    @need_unlock
    def restore_accounts(self, rows):
        """撤銷用：按 id 把賬號恢復成給定的完整內容（已刪除的按原 id 重新插入）。"""
        now = int(time.time())
        cols = FIELDS + ["sheet_id", "status", "group_id", "extra", "created_at", "updated_at"]
        sql = f"INSERT OR REPLACE INTO accounts(id, {', '.join(cols)}) VALUES ({', '.join('?' for _ in range(len(cols) + 1))})"
        st = self._store
        with st.lock:
            for r in rows or []:
                values = {f: str(r.get(f) or "") for f in FIELDS}
                self._encrypt_row(values)
                st.conn.execute(sql, [int(r["id"])] + [values[f] for f in FIELDS] + [
                    int(r["sheet_id"]), r.get("status") or STATUSES[0], r.get("group_id") or None,
                    json.dumps(r.get("extra") or {}, ensure_ascii=False), int(r.get("created_at") or now), now])
            st.conn.commit()

    @need_unlock
    def save_export(self, filename, content):
        """彈出保存對話框寫文件。沒有窗口（開發模式）時返回 None，由前端走瀏覽器下載。"""
        if self._window is None:
            return None
        import webview

        ext = os.path.splitext(filename)[1].lstrip(".") or "txt"
        save = getattr(getattr(webview, "FileDialog", None), "SAVE", None) or webview.SAVE_DIALOG
        result = self._window.create_file_dialog(save, save_filename=filename, file_types=(f"{ext.upper()} (*.{ext})",))
        if not result:
            return {"cancelled": True}
        path = result if isinstance(result, str) else result[0]
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(content)
        return {"path": path}
