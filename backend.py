"""郵箱管理 - 數據層與前端 API。

所有給前端調用的方法都在 Api 類裡，pywebview 通過 js_api 暴露，
開發模式下 devserver.py 通過 HTTP 暴露同一個類。
"""
import base64
import functools
import hashlib
import json
import os
import re
import secrets
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
import apiserver
import mcpserver
import billionmail
import fsagent
import mailfetch
import vault

STATUSES = ["正常", "待驗證", "異常", "封禁", "停用"]
FIELDS = ["email", "password", "totp_secret", "backup_codes", "recovery_email", "recovery_password",
          "oauth_client_id", "oauth_token", "phone", "notes"]
SECRET_FIELDS = ("password", "totp_secret", "backup_codes", "recovery_password", "oauth_token")  # 加密存儲的字段
# backup_codes：一次性備用碼（例如 Google 的 10 個），一行一個，已用過的前面加「~」
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
    backup_codes TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    group_id INTEGER,
    status TEXT NOT NULL DEFAULT '正常',
    notes TEXT NOT NULL DEFAULT '',
    extra TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_sheet ON accounts(sheet_id);
CREATE TABLE IF NOT EXISTS account_groups (
    account_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    PRIMARY KEY (account_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_account_groups_group ON account_groups(group_id);
CREATE TABLE IF NOT EXISTS families (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT '',
    max_members INTEGER NOT NULL DEFAULT 6,
    notes TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#f5a524',
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS family_members (
    family_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    PRIMARY KEY (family_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_family_members_account ON family_members(account_id);
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


# 可選的編號「1.」+ 可選的已用標記「~」+ 8 位數字（中間可有空格或橫線）
BACKUP_CODE_RE = re.compile(r"(?:(?<!\d)(\d{1,2})[.)、]\s*)?(~?)(?<!\d)(\d{4})[ -]?(\d{4})(?!\d)")


def normalize_backup_codes(text):
    """把粘貼進來的備用碼整理成「一行一個」：Google 的 8 位數字碼（1234 5678）直接從整段文字裡提取，
    其他服務的碼按換行 / 逗號 / 空格拆開（去掉 1. 2. 這樣的編號）。已用的「~」標記保留，重複的去掉。"""
    text = (text or "").strip()
    if not text:
        return ""
    found = BACKUP_CODE_RE.findall(text)
    if found:
        if all(num for num, *_ in found):  # Google 文件是兩欄排版，按編號 1-10 排序
            found = sorted(found, key=lambda x: int(x[0]))
        items = [(u == "~", f"{a} {b}") for _, u, a, b in found]
    else:
        items = []
        for part in re.split(r"[\r\n,;，；|]+", text):
            part = part.strip()
            used = part.startswith("~")
            part = re.sub(r"^~?\s*\d{1,2}[.)、:]\s+", "", part.lstrip("~")).strip()
            tokens = part.split()
            # 一行裡多個碼（空格分開）就拆開；否則整行是一個碼
            if len(tokens) > 1 and all(len(t) >= 6 and any(c.isdigit() for c in t) for t in tokens):
                items.extend((used, t) for t in tokens)
            elif part:
                items.append((used, part))
    out, seen = [], {}
    for used, code in items:
        key = code.replace(" ", "").lower()
        if key in seen:
            if used:  # 任何一處標了已用就算已用
                out[seen[key]] = "~" + out[seen[key]].lstrip("~")
            continue
        seen[key] = len(out)
        out.append(("~" if used else "") + code)
    return "\n".join(out)


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
        for col in ("oauth_client_id", "oauth_token", "backup_codes"):
            if col not in cols:
                self.conn.execute(f"ALTER TABLE accounts ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")
        # 列表類型：'' = 普通列表，'selfmail' = 自建郵箱管理窗口用的列表（和 BillionMail 後台同步）
        if "kind" not in {r["name"] for r in self.conn.execute("PRAGMA table_info(sheets)")}:
            self.conn.execute("ALTER TABLE sheets ADD COLUMN kind TEXT NOT NULL DEFAULT ''")
        # 分組改成多對多：把舊的單個分組搬進 account_groups（只做一次）
        if not self.conn.execute("SELECT 1 FROM settings WHERE key='multi_group'").fetchone():
            self.conn.execute("INSERT OR IGNORE INTO account_groups(account_id, group_id) "
                              "SELECT id, group_id FROM accounts WHERE group_id IS NOT NULL")
            self.conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES ('multi_group', '1')")
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
        self._http_api = apiserver.ApiServer(self)  # 本地 HTTP API（默認關閉，main.py 啟動時按配置打開）

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
        self._api_ensure_wrapped()

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
        for name, keys in (("mail_config", self._MAIL_SECRETS), ("ai_config", self._AI_SECRETS), ("api_config", self._API_SECRETS)):
            cfg = json.loads(self._store.get_setting(name) or "{}")
            changed = False
            for key in keys:  # 配置裡的密碼 / Key 也跟著換密鑰
                if cfg.get(key):
                    plain = old.decrypt(cfg[key]) if old else cfg[key]
                    cfg[key] = cipher.encrypt(plain)
                    changed = True
            if changed:
                settings[name] = json.dumps(cfg, ensure_ascii=False)
        api = json.loads(settings.get("api_config") or self._store.get_setting("api_config") or "{}")
        if api.get("wrapped_key") and api.get("token"):  # 鎖定時也能讀的 API：數據密鑰換了，用 Token 重新包裝
            api["wrapped_key"] = self._api_wrap(cipher.key, cipher.decrypt(api["token"]))
            settings["api_config"] = json.dumps(api)
        kb = self._store.get_setting("agent_kb")  # AI 助手的技能和經驗（整塊加密）
        if kb:
            settings["agent_kb"] = cipher.encrypt(old.decrypt(kb) if old else kb)
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

    def _decrypt_row(self, row, cipher=None):
        cipher = cipher or self._cipher
        for f in SECRET_FIELDS:
            row[f] = cipher.decrypt(row[f])
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
            "SELECT g.*, (SELECT COUNT(*) FROM account_groups ag WHERE ag.group_id = g.id) AS count "
            "FROM groups g ORDER BY sort, id"
        )
        return {"sheets": sheets, "groups": groups, "families": self._families()}

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
        self._store.execute("DELETE FROM account_groups WHERE account_id IN (SELECT id FROM accounts WHERE sheet_id=?)", (sheet_id,))
        self._store.execute("DELETE FROM family_members WHERE account_id IN (SELECT id FROM accounts WHERE sheet_id=?)", (sheet_id,))
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
        table = {"groups": "groups", "sheets": "sheets", "families": "families"}[kind]
        ids = [int(i) for i in ids or []]
        rest = [r["id"] for r in self._store.query(f"SELECT id FROM {table} ORDER BY sort, id") if r["id"] not in ids]
        self._store.executemany(f"UPDATE {table} SET sort=? WHERE id=?", [(i, gid) for i, gid in enumerate(ids + rest)])

    @need_unlock
    def delete_group(self, group_id):
        st = self._store
        with st.lock:
            ids = [r["account_id"] for r in st.conn.execute("SELECT account_id FROM account_groups WHERE group_id=?", (group_id,))]
            st.conn.execute("DELETE FROM account_groups WHERE group_id=?", (group_id,))
            st.conn.execute("DELETE FROM groups WHERE id=?", (group_id,))
            self._sync_primary(st.conn, ids)
            st.conn.commit()

    # ---------- 分組成員（一個郵箱可以同時在多個分組；accounts.group_id 保留為「第一個分組」兼容舊代碼） ----------
    @staticmethod
    def _gids(value):
        """None / 單個 id / id 列表 → 去重後的 id 列表"""
        if value in (None, "", 0):
            return []
        vals = value if isinstance(value, (list, tuple)) else [value]
        out = []
        for v in vals:
            try:
                v = int(v)
            except (TypeError, ValueError):
                continue
            if v and v not in out:
                out.append(v)
        return out

    @staticmethod
    def _sync_primary(conn, ids):
        ids = [int(i) for i in ids or []]
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            conn.execute(
                f"UPDATE accounts SET group_id=(SELECT group_id FROM account_groups ag WHERE ag.account_id=accounts.id "
                f"ORDER BY rowid LIMIT 1) WHERE id IN ({','.join('?' for _ in chunk)})", chunk)

    def _change_groups(self, ids, mode, group_ids):
        """mode：set = 只在這些分組；add = 加入；remove = 移出。"""
        ids = [int(i) for i in ids or []]
        gids = self._gids(group_ids)
        if not ids:
            return
        st = self._store
        with st.lock:
            marks = ",".join("?" for _ in ids)
            if mode == "set":
                st.conn.execute(f"DELETE FROM account_groups WHERE account_id IN ({marks})", ids)
            if mode in ("set", "add"):
                st.conn.executemany("INSERT OR IGNORE INTO account_groups(account_id, group_id) VALUES (?, ?)",
                                    [(a, g) for a in ids for g in gids])
            elif mode == "remove" and gids:
                st.conn.execute(f"DELETE FROM account_groups WHERE account_id IN ({marks}) AND group_id IN "
                                f"({','.join('?' for _ in gids)})", ids + gids)
            st.conn.execute(f"UPDATE accounts SET updated_at=? WHERE id IN ({marks})", [int(time.time())] + ids)
            self._sync_primary(st.conn, ids)
            st.conn.commit()

    @need_unlock
    def set_groups(self, ids, group_ids):
        self._change_groups(ids, "set", group_ids)

    @need_unlock
    def add_to_group(self, ids, group_id):
        self._change_groups(ids, "add", group_id)

    @need_unlock
    def remove_from_group(self, ids, group_id):
        self._change_groups(ids, "remove", group_id)

    # ---------- 家庭組（關係）：一個組長 + 若干成員，成員可以在不同列表；一個郵箱可以在多個家庭組 ----------
    def _families(self):
        fams = self._store.query("SELECT * FROM families ORDER BY sort, id")
        members = {}
        for m in self._store.query(
                "SELECT fm.family_id, fm.account_id, fm.role, a.email, a.sheet_id, a.status FROM family_members fm "
                "JOIN accounts a ON a.id = fm.account_id ORDER BY fm.role='owner' DESC, fm.rowid"):
            members.setdefault(m.pop("family_id"), []).append(m)
        for f in fams:
            f["members"] = members.get(f["id"], [])
        return fams

    @staticmethod
    def _family_values(data, partial=False):
        out = {}
        if not partial or "name" in data:
            out["name"] = (data.get("name") or "").strip() or "家庭組"
        if not partial or "kind" in data:
            out["kind"] = (data.get("kind") or "").strip()
        if not partial or "notes" in data:
            out["notes"] = (data.get("notes") or "").rstrip()
        if not partial or "max_members" in data:
            try:
                out["max_members"] = max(0, int(data.get("max_members") if data.get("max_members") not in (None, "") else 6))
            except (TypeError, ValueError):
                out["max_members"] = 6
        if data.get("color"):
            out["color"] = data["color"]
        return out

    @need_unlock
    def add_family(self, data=None, owner_id=None, member_ids=None):
        """新建家庭組：data = {name, kind, max_members（0 = 不限，含組長）, notes, color}；可同時指定組長和成員。"""
        vals = self._family_values(data or {})
        cols = list(vals)
        fid = self._store.execute(
            f"INSERT INTO families({', '.join(cols)}, sort, created_at) VALUES ({', '.join('?' for _ in cols)}, "
            f"(SELECT COALESCE(MAX(sort), 0) + 1 FROM families), ?)", [vals[c] for c in cols] + [int(time.time())])
        if member_ids:
            self.family_add(fid, member_ids)
        if owner_id:
            self.family_set_owner(fid, owner_id)
        return fid

    @need_unlock
    def update_family(self, family_id, data):
        vals = self._family_values(data or {}, partial=True)
        if vals:
            self._store.execute(f"UPDATE families SET {', '.join(f'{k}=?' for k in vals)} WHERE id=?", [*vals.values(), int(family_id)])

    @need_unlock
    def delete_family(self, family_id):
        st = self._store
        with st.lock:
            st.conn.execute("DELETE FROM family_members WHERE family_id=?", (int(family_id),))
            st.conn.execute("DELETE FROM families WHERE id=?", (int(family_id),))
            st.conn.commit()

    @need_unlock
    def family_add(self, family_id, ids, role="member"):
        """加入成員（已在組裡的保持原角色）。role="owner" 時等於設為組長（只取第一個）。"""
        ids = self._gids(ids)
        if role == "owner":
            return self.family_set_owner(family_id, ids[0]) if ids else None
        self._store.executemany("INSERT OR IGNORE INTO family_members(family_id, account_id, role) VALUES (?, ?, 'member')",
                                [(int(family_id), a) for a in ids])

    @need_unlock
    def family_remove(self, family_id, ids):
        ids = self._gids(ids)
        if ids:
            self._store.execute(f"DELETE FROM family_members WHERE family_id=? AND account_id IN ({','.join('?' for _ in ids)})",
                                [int(family_id)] + ids)

    @need_unlock
    def family_set_owner(self, family_id, account_id):
        """設為組長：原來的組長變成普通成員；account_id 為空 = 取消組長。"""
        st = self._store
        with st.lock:
            st.conn.execute("UPDATE family_members SET role='member' WHERE family_id=? AND role='owner'", (int(family_id),))
            if account_id:
                st.conn.execute("INSERT OR REPLACE INTO family_members(family_id, account_id, role) VALUES (?, ?, 'owner')",
                                (int(family_id), int(account_id)))
            st.conn.commit()

    @need_unlock
    def restore_family(self, fam):
        """撤銷用：按 id 把家庭組恢復成快照（_families() 返回的格式），已刪除的重新建立；已不存在的郵箱跳過。"""
        fid = int(fam["id"])
        vals = self._family_values(fam)
        st = self._store
        with st.lock:
            st.conn.execute(
                "INSERT OR REPLACE INTO families(id, name, kind, max_members, notes, color, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (fid, vals["name"], vals["kind"], vals["max_members"], vals["notes"], fam.get("color") or "#f5a524",
                 int(fam.get("sort") or 0), int(fam.get("created_at") or time.time())))
            st.conn.execute("DELETE FROM family_members WHERE family_id=?", (fid,))
            for m in fam.get("members") or []:
                if st.conn.execute("SELECT 1 FROM accounts WHERE id=?", (int(m["account_id"]),)).fetchone():
                    st.conn.execute("INSERT OR IGNORE INTO family_members(family_id, account_id, role) VALUES (?, ?, ?)",
                                    (fid, int(m["account_id"]), "owner" if m.get("role") == "owner" else "member"))
            st.conn.commit()

    @need_unlock
    def find_accounts(self, query, limit=30):
        """按郵箱在所有列表裡查找（家庭組添加成員用，成員可以在別的列表）。"""
        q = (query or "").strip().lower()
        if not q:
            return []
        rows = self._store.query(
            "SELECT a.id, a.email, a.sheet_id, a.status FROM accounts a JOIN sheets s ON s.id = a.sheet_id "
            "WHERE s.kind='' AND lower(a.email) LIKE ? ORDER BY (lower(a.email) = ?) DESC, (lower(a.email) LIKE ?) DESC, a.email LIMIT ?",
            (f"%{q}%", q, f"{q}%", int(limit)))
        fams = {}
        if rows:
            marks = ",".join("?" for _ in rows)
            for m in self._store.query(f"SELECT account_id, family_id, role FROM family_members WHERE account_id IN ({marks})",
                                       [r["id"] for r in rows]):
                fams.setdefault(m["account_id"], []).append({"id": m["family_id"], "role": m["role"]})
        for r in rows:
            r["families"] = fams.get(r["id"], [])
        return rows

    # ---------- 賬號 ----------
    @need_unlock
    def list_accounts(self, sheet_id):
        rows = self._store.query("SELECT * FROM accounts WHERE sheet_id=? ORDER BY id DESC", (sheet_id,))
        groups = {}
        for m in self._store.query("SELECT ag.account_id, ag.group_id FROM account_groups ag JOIN accounts a ON a.id = ag.account_id "
                                   "WHERE a.sheet_id=? ORDER BY ag.rowid", (sheet_id,)):
            groups.setdefault(m["account_id"], []).append(m["group_id"])
        fams = {}
        for m in self._store.query("SELECT fm.account_id, fm.family_id, fm.role FROM family_members fm JOIN accounts a ON a.id = fm.account_id "
                                   "WHERE a.sheet_id=? ORDER BY fm.rowid", (sheet_id,)):
            fams.setdefault(m["account_id"], []).append({"id": m["family_id"], "role": m["role"]})
        for r in rows:
            r["extra"] = json.loads(r["extra"] or "{}")
            r["group_ids"] = groups.get(r["id"], [])
            r["families"] = fams.get(r["id"], [])
            self._decrypt_row(r)
        return rows

    @need_unlock
    def save_account(self, data):
        now = int(time.time())
        values = {f: (data.get(f) or "").strip() for f in FIELDS}
        values["notes"] = (data.get("notes") or "").rstrip()
        values["totp_secret"] = clean_secret(values["totp_secret"])
        values["backup_codes"] = normalize_backup_codes(data.get("backup_codes"))
        self._encrypt_row(values)
        status = data.get("status") or "正常"
        gids = self._gids(data["group_ids"] if "group_ids" in data else data.get("group_id"))
        group_id = gids[0] if gids else None
        extra = json.dumps(data.get("extra") or {}, ensure_ascii=False)
        if data.get("id"):
            self._selfmail_check_updates([(data["id"], {"email": data.get("email"), "password": data.get("password") or ""})])
            self._selfmail_status([data["id"]], status)
            sets = ", ".join(f"{f}=?" for f in FIELDS)
            self._store.execute(
                f"UPDATE accounts SET {sets}, status=?, group_id=?, extra=?, updated_at=? WHERE id=?",
                [values[f] for f in FIELDS] + [status, group_id, extra, now, data["id"]],
            )
            self._change_groups([data["id"]], "set", gids)
            return data["id"]
        cols = ", ".join(FIELDS)
        marks = ", ".join("?" for _ in FIELDS)
        new_id = self._store.execute(
            f"INSERT INTO accounts(sheet_id, {cols}, status, group_id, extra, created_at, updated_at) "
            f"VALUES (?, {marks}, ?, ?, ?, ?, ?)",
            [data["sheet_id"]] + [values[f] for f in FIELDS] + [status, group_id, extra, now, now],
        )
        self._change_groups([new_id], "set", gids)
        return new_id

    @need_unlock
    def delete_accounts(self, ids):
        rows = self._selfmail_ids(ids)
        if rows:  # 自建郵箱：先在後台刪除，成功了再刪本地
            self._admin_client(self._admin_cfg()).delete_mailboxes([r["email"] for r in rows.values()])
        self._bulk("DELETE FROM account_groups WHERE account_id IN ({})", ids)
        self._bulk("DELETE FROM family_members WHERE account_id IN ({})", ids)
        self._bulk("DELETE FROM accounts WHERE id IN ({})", ids)

    @need_unlock
    def set_group(self, ids, group_id):
        self._change_groups(ids, "set", group_id)

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
                if "backup_codes" in fields:
                    fields["backup_codes"] = normalize_backup_codes(fields["backup_codes"])
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
        """自建郵箱列表裡加一行；已經有了（例如被同步拉進來過）就更新密碼、狀態並加入分組。group_id 可以是一個或多個。"""
        now = int(time.time())
        gids = self._gids(group_id)
        row = self._store.query("SELECT id FROM accounts WHERE sheet_id=? AND lower(email)=?", (sid, email.lower()))
        enc = self._cipher.encrypt(password)
        if row:
            self._store.execute("UPDATE accounts SET password=?, status=?, updated_at=? WHERE id=?", (enc, status, now, row[0]["id"]))
            if gids:
                self._change_groups([row[0]["id"]], "add", gids)
            return row[0]["id"]
        values = {f: "" for f in FIELDS}
        values.update(email=email, password=password)
        self._encrypt_row(values)
        new_id = self._store.execute(
            f"INSERT INTO accounts(sheet_id, {', '.join(FIELDS)}, status, group_id, extra, created_at, updated_at) "
            f"VALUES (?, {', '.join('?' for _ in FIELDS)}, ?, ?, '{{}}', ?, ?)",
            [sid] + [values[f] for f in FIELDS] + [status, gids[0] if gids else None, now, now])
        if gids:
            self._change_groups([new_id], "add", gids)
        return new_id

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

    # ---------- AI 助手的技能和經驗（{"skills": [...], "memories": [...]}，用主密碼加密，前端負責增刪改） ----------
    @need_unlock
    def get_agent_kb(self):
        raw = self._store.get_setting("agent_kb")
        kb = json.loads(self._cipher.decrypt(raw)) if raw else {}
        return {"skills": kb.get("skills") or [], "memories": kb.get("memories") or []}

    @need_unlock
    def save_agent_kb(self, kb):
        kb = {"skills": (kb or {}).get("skills") or [], "memories": (kb or {}).get("memories") or []}
        self._store.execute("INSERT OR REPLACE INTO settings(key, value) VALUES ('agent_kb', ?)",
                            (self._cipher.encrypt(json.dumps(kb, ensure_ascii=False)),))

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
    # AI 助手：攜帶最近多少輪對話、上下文最多多少字；自動學習（AI 可以記經驗、寫技能）；換對話時自動總結經驗
    # agent_computer：允許 AI 助手讀寫電腦上的文件、執行命令（寫入和命令每次都要用戶確認）
    _AGENT_DEFAULTS = {"agent_max_turns": 20, "agent_max_chars": 150000, "agent_learn": True, "agent_reflect": True,
                       "agent_computer": True}
    _AI_SECRETS = ("api_key",)

    def _ai_config(self, with_secret=False):
        cfg = {**self._AI_DEFAULTS, **self._AGENT_DEFAULTS, **json.loads(self._store.get_setting("ai_config") or "{}")}
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
        for k, v in self._AGENT_DEFAULTS.items():
            val = cfg.get(k, old.get(k, v))
            if isinstance(v, bool):
                new[k] = bool(val)
            else:
                try:
                    new[k] = max(1, int(val))
                except (TypeError, ValueError):
                    new[k] = v
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
        batch, row_groups = [], []
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
            values["backup_codes"] = normalize_backup_codes(r.get("backup_codes"))
            row_extra = {**common, **{k: v for k, v in (r.get("extra") or {}).items() if v}}
            self._encrypt_row(values)
            row_gids = self._gids(self._gids(group_id) + self._gids(r.get("group_ids")))
            row_groups.append(row_gids)
            batch.append([sheet_id] + [values[f] for f in FIELDS]
                         + [status, row_gids[0] if row_gids else None, json.dumps(row_extra, ensure_ascii=False), now, now])
        cols = ", ".join(FIELDS)
        marks = ", ".join("?" for _ in FIELDS)
        sql = (f"INSERT INTO accounts(sheet_id, {cols}, status, group_id, extra, created_at, updated_at) "
               f"VALUES (?, {marks}, ?, ?, ?, ?, ?)")
        ids = []
        st = self._store
        with st.lock:  # 逐條插入以拿到新 id（AI 助手撤銷用），一次提交
            for row, gids in zip(batch, row_groups):
                new_id = st.conn.execute(sql, row).lastrowid
                ids.append(new_id)
                st.conn.executemany("INSERT OR IGNORE INTO account_groups(account_id, group_id) VALUES (?, ?)",
                                    [(new_id, g) for g in gids])
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
                gids = self._gids(r["group_ids"] if "group_ids" in r else r.get("group_id"))
                st.conn.execute(sql, [int(r["id"])] + [values[f] for f in FIELDS] + [
                    int(r["sheet_id"]), r.get("status") or STATUSES[0], gids[0] if gids else None,
                    json.dumps(r.get("extra") or {}, ensure_ascii=False), int(r.get("created_at") or now), now])
                st.conn.execute("DELETE FROM account_groups WHERE account_id=?", (int(r["id"]),))
                st.conn.executemany("INSERT OR IGNORE INTO account_groups(account_id, group_id) VALUES (?, ?)",
                                    [(int(r["id"]), g) for g in gids])
                if "families" in r:  # 家庭組關係也恢復（家庭組已被刪除的跳過）
                    st.conn.execute("DELETE FROM family_members WHERE account_id=?", (int(r["id"]),))
                    for m in r["families"] or []:
                        fid = int(m["id"])
                        if not st.conn.execute("SELECT 1 FROM families WHERE id=?", (fid,)).fetchone():
                            continue
                        role = "owner" if m.get("role") == "owner" else "member"
                        if role == "owner":
                            st.conn.execute("UPDATE family_members SET role='member' WHERE family_id=? AND role='owner'", (fid,))
                        st.conn.execute("INSERT OR REPLACE INTO family_members(family_id, account_id, role) VALUES (?, ?, ?)",
                                        (fid, int(r["id"]), role))
            st.conn.commit()

    # ---------- AI 助手操作電腦（文件、命令），見 fsagent.py ----------
    def _computer(self, fn, *args):
        if not self._ai_config().get("agent_computer", True):
            raise PermissionError("err.computer_off")
        try:
            return fn(*args)
        except (OSError, ValueError, re.error) as e:
            return {"error": f"{type(e).__name__}: {e}"}

    @need_unlock
    def fs_info(self):
        return fsagent.computer_info()

    @need_unlock
    def fs_list(self, path, pattern="", recursive=False, limit=200):
        return self._computer(fsagent.list_dir, path, pattern, recursive, limit)

    @need_unlock
    def fs_read(self, path, offset=1, limit=200):
        return self._computer(fsagent.read_file, path, offset, limit)

    @need_unlock
    def fs_search(self, path, query, regex=False, pattern="", recursive=True):
        return self._computer(fsagent.search, path, query, regex, pattern, recursive)

    @need_unlock
    def fs_scan(self, path, pattern="", recursive=True):
        """統計文件裡的郵箱賬號，並標出每個郵箱已經在哪些列表裡。"""
        r = self._computer(fsagent.scan_accounts, path, pattern, recursive)
        if "emails" in r:
            where = {}
            for row in self._store.query("SELECT lower(email) AS e, sheet_id FROM accounts"):
                where.setdefault(row["e"], []).append(row["sheet_id"])
            r["sheets"] = {e: where[e] for e in r["emails"] if e in where}
        return r

    @need_unlock
    def fs_write(self, path, content, append=False, overwrite=False):
        return self._computer(fsagent.write_file, path, content, append, overwrite)

    @need_unlock
    def fs_move(self, src, dest, copy=False):
        return self._computer(fsagent.move, src, dest, copy)

    @need_unlock
    def fs_mkdir(self, path):
        return self._computer(fsagent.mkdir, path)

    @need_unlock
    def fs_reveal(self, path):
        return self._computer(fsagent.reveal, path)

    @need_unlock
    def run_command(self, command, cwd="", timeout=60):
        return self._computer(fsagent.run_command, command, cwd, timeout)

    # ---------- 本地 HTTP API（見 apiserver.py）：默認關閉；Token 只能隨機生成，校驗用哈希，明文加密保存 ----------
    # allow_locked：軟件鎖定（或剛啟動還沒解鎖）時也能讀取。做法是把數據密鑰用 Token 加密一份（wrapped_key），
    # 帶正確 Token 的請求才能解開；數據庫文件本身不含 Token 明文，所以不帶 Token 仍然讀不出數據
    _API_DEFAULTS = {"enabled": False, "port": 8686, "lan": False, "allow_locked": True}
    _API_SECRETS = ("token",)

    def _api_cfg(self):
        return {**self._API_DEFAULTS, **json.loads(self._store.get_setting("api_config") or "{}")}

    def _api_save(self, cfg):
        self._store.execute("INSERT OR REPLACE INTO settings(key, value) VALUES ('api_config', ?)", (json.dumps(cfg),))

    def _api_token_hash(self):
        return self._api_cfg().get("token_hash", "")

    def start_http_api(self):
        """程序啟動、改配置後調用：按保存的配置啟動或停止 API 服務。"""
        cfg = self._api_cfg()
        if cfg["enabled"] and cfg.get("token_hash"):
            self._http_api.start("0.0.0.0" if cfg["lan"] else "127.0.0.1", cfg["port"])
        else:
            self._http_api.stop()

    def _api_new_token(self, cfg):
        token = "mm_" + secrets.token_urlsafe(32)
        cfg["token"] = self._cipher.encrypt(token)
        cfg["token_hash"] = apiserver.token_hash(token)
        cfg.pop("wrapped_key", None)
        self._api_sync_wrap(cfg)

    @staticmethod
    def _api_token_cipher(token):
        return vault.Cipher(hashlib.sha256(b"mail-manager-api-key:" + token.encode()).digest())

    def _api_wrap(self, key, token):
        return self._api_token_cipher(token).encrypt(base64.b64encode(key).decode())

    def _api_sync_wrap(self, cfg):
        """按 allow_locked 生成或刪除 Token 包裝的數據密鑰（需要已解鎖）。"""
        if cfg.get("allow_locked") and cfg.get("token"):
            if not cfg.get("wrapped_key"):
                cfg["wrapped_key"] = self._api_wrap(self._cipher.key, self._cipher.decrypt(cfg["token"]))
        else:
            cfg.pop("wrapped_key", None)

    def _api_ensure_wrapped(self):
        cfg = self._api_cfg()
        had = cfg.get("wrapped_key")
        self._api_sync_wrap(cfg)
        if cfg.get("wrapped_key") != had:
            self._api_save(cfg)

    def _api_read_cipher(self, token):
        """API 讀數據用的密鑰：已解鎖就用當前的；鎖定時用 Token 解開包裝的數據密鑰。"""
        if self._cipher is not None:
            return self._cipher
        cfg = self._api_cfg()
        if not cfg.get("allow_locked") or not cfg.get("wrapped_key") or not token:
            raise PermissionError("locked")
        try:
            cipher = vault.Cipher(base64.b64decode(self._api_token_cipher(token).decrypt(cfg["wrapped_key"])))
        except (vault.WrongPassword, ValueError):
            raise PermissionError("locked")
        if not cipher.check(self._store.get_setting("verifier")):
            raise PermissionError("locked")
        return cipher

    def _api_public(self, cfg):
        return {"enabled": cfg["enabled"], "port": cfg["port"], "lan": cfg["lan"], "allow_locked": bool(cfg.get("allow_locked")),
                "token": self._cipher.decrypt(cfg["token"]) if cfg.get("token") else "",
                "status": self._http_api.status(), "log": list(self._http_api.log)[:30]}

    @need_unlock
    def get_api_config(self):
        return self._api_public(self._api_cfg())

    @need_unlock
    def set_api_config(self, cfg):
        cur = self._api_cfg()
        try:
            port = int(cfg.get("port", cur["port"]))
        except (TypeError, ValueError):
            port = 0
        if not 1 <= port <= 65535:
            raise ValueError("err.api_port")
        cur.update(enabled=bool(cfg.get("enabled")), port=port, lan=bool(cfg.get("lan")),
                   allow_locked=bool(cfg.get("allow_locked", cur.get("allow_locked", True))))
        if cur["enabled"] and not cur.get("token_hash"):  # 第一次打開自動生成 Token
            self._api_new_token(cur)
        self._api_sync_wrap(cur)
        self._api_save(cur)
        self.start_http_api()
        return self.get_api_config()

    @need_unlock
    def api_regen_token(self):
        """重新生成 Token，舊的立即失效。"""
        cfg = self._api_cfg()
        self._api_new_token(cfg)
        self._api_save(cfg)
        return self.get_api_config()

    @need_unlock
    def api_status(self):
        return {"status": self._http_api.status(), "log": list(self._http_api.log)[:30]}

    @need_unlock
    def api_try(self, path, params=None):
        """接口文檔裡的「發送請求」：真正向本機運行中的 API 發一個 GET 請求，返回狀態碼、耗時和內容。"""
        import urllib.error
        import urllib.parse
        import urllib.request

        st = self._http_api.status()
        if not st["running"]:
            raise ValueError("err.api_not_running")
        query = urllib.parse.urlencode({k: v for k, v in (params or {}).items() if str(v).strip() != ""})
        url = f"http://127.0.0.1:{st['port']}{path}" + (f"?{query}" if query else "")
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + self._cipher.decrypt(self._api_cfg()["token"])})
        started = time.time()
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                status, ctype, body = r.status, r.headers.get_content_type(), r.read()
        except urllib.error.HTTPError as e:
            status, ctype, body = e.code, e.headers.get_content_type(), e.read()
        text = body.decode("utf-8", "replace")
        if ctype == "application/json":
            try:
                text = json.dumps(json.loads(text), ensure_ascii=False, indent=2)
            except ValueError:
                pass
        return {"status": status, "ms": int((time.time() - started) * 1000), "url": url,
                "body": text[:50000], "truncated": len(text) > 50000}

    @need_unlock
    def api_mcp_tools(self):
        return mcpserver.tool_list()

    @need_unlock
    def api_mcp_try(self, method, params=None):
        """接口頁面的 MCP 調試：向本機 /mcp 發一條 JSON-RPC 請求（和 AI 工具發的一樣）。"""
        import urllib.error
        import urllib.request

        st = self._http_api.status()
        if not st["running"]:
            raise ValueError("err.api_not_running")
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{st['port']}/mcp", data=body, method="POST", headers={
            "Content-Type": "application/json", "Accept": "application/json, text/event-stream",
            "Authorization": "Bearer " + self._cipher.decrypt(self._api_cfg()["token"])})
        started = time.time()
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                status, raw = r.status, r.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        text = raw.decode("utf-8", "replace")
        try:
            data = json.loads(text)
            # 工具結果裡的 JSON 文本也展開，方便看
            for c in (data.get("result") or {}).get("content") or []:
                if c.get("type") == "text":
                    try:
                        c["text"] = json.loads(c["text"])
                    except ValueError:
                        pass
            text = json.dumps(data, ensure_ascii=False, indent=2)
        except ValueError:
            pass
        return {"status": status, "ms": int((time.time() - started) * 1000), "body": text[:50000]}

    # API 請求的數據（在 API 服務線程裡調用）。返回 (body, 是否純文本)
    def _api_handle(self, path, p, token=""):
        if path == "/api/health":
            cfg = self._api_cfg()
            return {"ok": True, "locked": self._cipher is None,
                    "readable": self._cipher is not None or bool(cfg.get("allow_locked") and cfg.get("wrapped_key")),
                    "time": int(time.time())}, False
        cipher = self._api_read_cipher(token)
        if path in ("/", "/api"):
            return {"endpoints": apiserver.ENDPOINTS}, False
        ctx = self._api_context()
        if path == "/api/sheets":
            counts = {r["sheet_id"]: r["n"] for r in self._store.query("SELECT sheet_id, COUNT(*) AS n FROM accounts GROUP BY sheet_id")}
            return {"sheets": [{"id": s["id"], "name": s["name"], "kind": s["kind"] or "normal", "count": counts.get(s["id"], 0),
                                "columns": list(ctx["cols"][s["id"]].values())} for s in ctx["sheets"].values()]}, False
        if path == "/api/groups":
            counts = {r["group_id"]: r["n"] for r in self._store.query("SELECT group_id, COUNT(*) AS n FROM account_groups GROUP BY group_id")}
            return {"groups": [{"id": g["id"], "name": g["name"], "color": g["color"], "count": counts.get(g["id"], 0)}
                               for g in self._store.query("SELECT * FROM groups ORDER BY sort, id")]}, False
        if path == "/api/families":
            return {"families": [{"id": f["id"], "name": f["name"], "kind": f["kind"], "max_members": f["max_members"], "notes": f["notes"],
                                  "owner": next((m["email"] for m in f["members"] if m["role"] == "owner"), ""),
                                  "members": [{"email": m["email"], "role": m["role"]} for m in f["members"]]}
                                 for f in self._families()]}, False
        if path == "/api/2fa":
            if p.get("secret"):
                code = totp_now(p["secret"])
                if code == "密鑰無效":
                    raise apiserver.ApiError(400, "invalid secret")
                return {"code": code, "remaining": 30 - int(time.time()) % 30}, False
            emails = {e.strip().lower() for e in (p.get("email") or "").split(",") if e.strip()}
            if not emails:
                raise apiserver.ApiError(400, "email or secret is required")
            rows = [self._api_account(r, ctx) for r in self._api_rows(cipher) if r["email"].lower() in emails]
            if not rows:
                raise apiserver.ApiError(404, "account not found")
            return {"codes": [{"email": a["email"], "code": a["totp_code"], "remaining": a["totp_remaining"],
                               **({"error": a["totp_error"]} if a.get("totp_error") else {})} for a in rows]}, False
        if path == "/api/account":
            email, aid = (p.get("email") or "").strip().lower(), p.get("id")
            for r in self._api_rows(cipher):
                if (aid and str(r["id"]) == str(aid)) or (email and r["email"].lower() == email):
                    return self._api_account(r, ctx), False
            raise apiserver.ApiError(404, "account not found")
        if path == "/api/accounts":
            return self._api_accounts(p, ctx, cipher)
        raise apiserver.ApiError(404, "unknown endpoint, see /api")

    def _api_context(self):
        sheets = {s["id"]: s for s in self._store.query("SELECT id, name, kind, columns FROM sheets ORDER BY sort, id")}
        cols = {sid: {c["id"]: c["name"] for c in (normalize_column(x) for x in json.loads(s["columns"] or "[]"))} for sid, s in sheets.items()}
        groups = {g["id"]: g["name"] for g in self._store.query("SELECT id, name FROM groups")}
        acc_groups = {}
        for m in self._store.query("SELECT account_id, group_id FROM account_groups ORDER BY rowid"):
            if m["group_id"] in groups:
                acc_groups.setdefault(m["account_id"], []).append(m["group_id"])
        fams = {f["id"]: f["name"] for f in self._store.query("SELECT id, name FROM families")}
        acc_fams = {}
        for m in self._store.query("SELECT account_id, family_id, role FROM family_members ORDER BY rowid"):
            if m["family_id"] in fams:
                acc_fams.setdefault(m["account_id"], []).append({"name": fams[m["family_id"]], "role": m["role"]})
        return {"sheets": sheets, "cols": cols, "groups": groups, "acc_groups": acc_groups, "acc_fams": acc_fams}

    def _api_rows(self, cipher):
        return [self._decrypt_row(r, cipher) for r in self._store.query("SELECT * FROM accounts ORDER BY sheet_id, id")]

    def _api_account(self, r, ctx):
        secret = r["totp_secret"]
        code = totp_now(secret) if secret else ""
        codes = [c.strip() for c in (r["backup_codes"] or "").splitlines() if c.strip()]
        extra = json.loads(r["extra"] or "{}")
        cols = ctx["cols"].get(r["sheet_id"], {})
        out = {
            "id": r["id"], "email": r["email"], "password": r["password"],
            "totp_secret": secret, "totp_code": "" if code == "密鑰無效" else code,
            "totp_remaining": 30 - int(time.time()) % 30 if secret else None,
            "recovery_email": r["recovery_email"], "recovery_password": r["recovery_password"], "phone": r["phone"],
            "status": r["status"], "notes": r["notes"],
            "sheet": ctx["sheets"].get(r["sheet_id"], {}).get("name", ""),
            "groups": [ctx["groups"][g] for g in ctx["acc_groups"].get(r["id"], [])],
            "families": ctx["acc_fams"].get(r["id"], []),
            "backup_codes": [c for c in codes if not c.startswith("~")], "backup_codes_used": sum(c.startswith("~") for c in codes),
            "oauth_client_id": r["oauth_client_id"], "oauth_token": r["oauth_token"],
            "columns": {cols.get(k, k): v for k, v in extra.items()},
            "created_at": r["created_at"], "updated_at": r["updated_at"],
        }
        if code == "密鑰無效":
            out["totp_error"] = "invalid secret"
        return out

    def _api_accounts(self, p, ctx, cipher):
        rows = self._api_rows(cipher)
        lower = lambda v: str(v or "").strip().lower()  # noqa: E731
        many = lambda v: [x.strip() for x in str(v or "").split(",") if x.strip()]  # noqa: E731
        if p.get("sheet"):
            want = {lower(x) for x in many(p["sheet"])}
            ids = {sid for sid, s in ctx["sheets"].items() if str(sid) in want or s["name"].lower() in want}
            if not ids:
                raise apiserver.ApiError(400, f"unknown sheet, available: {', '.join(s['name'] for s in ctx['sheets'].values())}")
            rows = [r for r in rows if r["sheet_id"] in ids]
        if p.get("group"):
            want = [lower(x) for x in many(p["group"])]
            gids = {gid for gid, name in ctx["groups"].items() if str(gid) in want or name.lower() in want}
            none = "none" in want
            if not gids and not none:
                raise apiserver.ApiError(400, f"unknown group, available: {', '.join(ctx['groups'].values())}")
            rows = [r for r in rows if (none and not ctx["acc_groups"].get(r["id"])) or gids & set(ctx["acc_groups"].get(r["id"], []))]
        if p.get("family"):
            want = {lower(x) for x in many(p["family"])}
            rows = [r for r in rows if any(f["name"].lower() in want for f in ctx["acc_fams"].get(r["id"], []))]
        if p.get("role"):
            rows = [r for r in rows if any(f["role"] == lower(p["role"]) for f in ctx["acc_fams"].get(r["id"], []))]
        if p.get("status"):
            want = {lower(x) for x in many(p["status"])}
            rows = [r for r in rows if r["status"].lower() in want]
        if p.get("email"):
            want = {lower(x) for x in many(p["email"])}
            rows = [r for r in rows if r["email"].lower() in want]
        if p.get("search"):
            q = lower(p["search"])
            rows = [r for r in rows if any(q in lower(r[f]) for f in ("email", "recovery_email", "phone", "notes"))]
        if p.get("has_2fa") in ("1", "true", "yes"):
            rows = [r for r in rows if r["totp_secret"]]
        elif p.get("has_2fa") in ("0", "false", "no"):
            rows = [r for r in rows if not r["totp_secret"]]
        total = len(rows)
        try:
            offset = max(0, int(p.get("offset") or 0))
            limit = max(1, min(int(p.get("limit") or 1000), 10000))
        except ValueError:
            raise apiserver.ApiError(400, "limit / offset must be numbers")
        accounts = [self._api_account(r, ctx) for r in rows[offset:offset + limit]]
        fields = many(p.get("fields"))
        if (p.get("format") or "").lower() in ("txt", "text"):
            fields = fields or ["email", "password", "totp_secret"]
            sep = p.get("sep") or "----"
            fmt = lambda v: ",".join(map(str, v)) if isinstance(v, list) else ("" if v is None else (json.dumps(v, ensure_ascii=False) if isinstance(v, dict) else str(v)))  # noqa: E731
            return "\n".join(sep.join(fmt(a.get(f, a["columns"].get(f, ""))) for f in fields) for a in accounts), True
        if fields:
            accounts = [{f: a.get(f, a["columns"].get(f)) for f in ["email", *[x for x in fields if x != "email"]]} for a in accounts]
        return {"total": total, "offset": offset, "limit": limit, "count": len(accounts), "accounts": accounts}, False

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
