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
        self._cipher = None  # 解鎖後才有
        self._admin = None  # BillionMail 後台客戶端（登錄一次後復用）
        self._pw_cache = {}  # 管理員模式下解析到的郵箱密碼緩存（內存，鎖定即清）
        self._ai_jobs = {}  # AI 糾錯任務：job_id -> {"text", "done", "error", "stop"}

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
            try:
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
    def get_prefs(self):
        return json.loads(self._store.get_setting("ui_prefs") or "{}")

    def set_prefs(self, prefs):
        self._store.execute(
            "INSERT OR REPLACE INTO settings(key, value) VALUES ('ui_prefs', ?)", (json.dumps(prefs, ensure_ascii=False),)
        )

    def set_window_title(self, title):
        if self._window is not None:
            self._window.title = title

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
        return self._store.execute("INSERT INTO sheets(name) VALUES (?)", (name,))

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
        return self._store.execute("INSERT INTO groups(name, color) VALUES (?, ?)", (name, color))

    @need_unlock
    def update_group(self, group_id, name, color):
        self._store.execute("UPDATE groups SET name=?, color=? WHERE id=?", (name.strip(), color, group_id))

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
        self._bulk("DELETE FROM accounts WHERE id IN ({})", ids)

    @need_unlock
    def set_group(self, ids, group_id):
        self._bulk("UPDATE accounts SET group_id=? WHERE id IN ({})", ids, [group_id or None])

    @need_unlock
    def set_status(self, ids, status):
        self._bulk("UPDATE accounts SET status=? WHERE id IN ({})", ids, [status])

    @need_unlock
    def move_accounts(self, ids, sheet_id):
        self._bulk("UPDATE accounts SET sheet_id=? WHERE id IN ({})", ids, [sheet_id])

    @need_unlock
    def update_fields(self, updates):
        """批量改字段：updates = [{"id": 1, "fields": {"notes": "...", "phone": "..."}}]，只改給出的字段。"""
        now = int(time.time())
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
        hosts = [cache.get("hosts", {}).get(domain), cfg.get("legacy_host"), a_record,
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
    def create_recovery_mailboxes(self, ids, domain, overwrite=False):
        """批量：給這些賬號創建自建輔助郵箱並保存。已有輔助郵箱的默認跳過。"""
        cfg = self._admin_cfg()
        ids = [int(i) for i in ids or []]
        if not ids:
            return {"created": [], "skipped": 0, "failed": []}
        rows = self._store.query(f"SELECT * FROM accounts WHERE id IN ({','.join('?' for _ in ids)})", ids)
        created, failed, skipped = [], [], 0
        for r in rows:
            a = self._decrypt_row(r)
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
        return {"created": created, "skipped": skipped, "failed": failed}

    @need_unlock
    def fetch_mail(self, account_id, which="recovery"):
        """讀取某個賬號的輔助郵箱（which="recovery"）或主郵箱（which="email"）的最新郵件。"""
        rows = self._store.query("SELECT * FROM accounts WHERE id=?", (int(account_id),))
        if not rows:
            raise ValueError("not found")
        a = self._decrypt_row(rows[0])
        if which == "email":
            address, password = a["email"], a["password"]
        else:
            address, password = a["recovery_email"], a["recovery_password"]
        cfg = self._mail_config(with_secret=True)
        limit = int(cfg.get("limit") or 15)
        if mailfetch.is_microsoft(address):
            box = mailfetch.build_mailbox(cfg, address, password, a.get("oauth_client_id", ""), a.get("oauth_token", ""))
            return {"address": address, "provider": "microsoft", "messages": mailfetch.fetch(box, limit)}
        messages, used = self._fetch_self(cfg, address, password, limit)
        if used != password:  # 保存的密碼不對或沒有：把後台取回的正確密碼存下來，下次不會先登錄失敗（避免觸發 fail2ban）
            field = "password" if which == "email" else "recovery_password"
            self.update_fields([{"id": a["id"], "fields": {field: used}}])
        return {"address": address, "provider": "self", "messages": messages}

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
                    messages = mailfetch.fetch(box, limit)
                except PermissionError:
                    # 保存的密碼不對（或後台改過密碼）：用管理員重新取回的再試一次
                    fresh = self._resolve_password(cfg, address, fresh=True)
                    if fresh == password:
                        raise
                    password = box["password"] = fresh
                    messages = mailfetch.fetch(box, limit)
            except ConnectionError as e:  # 這台服務器連不上：換下一個候選
                last_error = e
                continue
            self._save_domain_cache(good_host={domain: host})
            return messages, password
        raise last_error or ConnectionError("err.mail_connect")

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
        job = {"text": "", "done": False, "error": "", "stop": False, "tool_calls": []}
        self._ai_jobs[job_id] = job

        def run():
            def on_delta(piece):
                job["text"] += piece

            try:
                job["tool_calls"] = aifix.stream_chat(cfg, messages, on_delta, lambda: job["stop"], tools)
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
                "tool_calls": job["tool_calls"] if done else []}

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
    def import_rows(self, sheet_id, rows, group_id=None, status="正常", skip_dup=True, extra=None):
        """rows：前端已解析好的行（字段見 FIELDS，可帶每行自己的 extra，例如國家）。
        extra：所有導入行共用的自定義列值，例如顏色標記、國家；行自己的值優先。"""
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
