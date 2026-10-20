"""BillionMail 後台管理客戶端：用管理員賬號登錄面板，按郵箱地址取回登錄密碼。

這樣用戶只需填一次管理員信息，不用給每個郵箱單獨保存密碼。
面板接口：POST /api/login 拿 JWT；GET /api/mailbox/list?keyword=<郵箱> 返回該郵箱的登錄密碼。
/api 受「安全入口」保護，所以先訪問一次安全入口路徑拿到 session cookie。
"""
import json
import ssl
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar

TIMEOUT = 10


def _conn_error(e):
    """連接錯誤。握手/讀取超時單獨提示：多半是服務器沒在正常響應（容器停了、被防火牆攔截）。"""
    reason = getattr(e, "reason", None) or e
    if isinstance(reason, TimeoutError) or "timed out" in str(reason):
        return ConnectionError("err.admin_timeout")
    return ConnectionError(f"err.admin_connect|{reason}")


class BillionMailAdmin:
    def __init__(self, panel_url, safe_path="", user="", password="", verify_cert=False):
        self.base = (panel_url or "").rstrip("/")
        sp = (safe_path or "").strip().strip("/")
        self.safe_path = "/" + sp if sp else ""
        self.user = user
        self.password = password
        ctx = ssl.create_default_context()
        if not verify_cert:  # BillionMail 默認自簽證書
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(CookieJar()),
            urllib.request.HTTPSHandler(context=ctx),
        )
        self.token = None

    def _call(self, method, path, body=None):
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with self._opener.open(req, timeout=TIMEOUT) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            try:
                return json.loads(e.read().decode("utf-8", "replace"))
            except Exception:
                raise PermissionError(f"err.admin_http|{e.code}")
        except (OSError, ValueError) as e:
            raise _conn_error(e) from None

    def login(self):
        if not self.base:
            raise ValueError("err.admin_no_url")
        if self.safe_path:  # 過安全入口，拿 session cookie
            try:
                self._opener.open(urllib.request.Request(self.base + self.safe_path), timeout=TIMEOUT)
            except urllib.error.HTTPError:
                pass  # 有響應就行
            except (OSError, ValueError) as e:  # 連不上就不用再試登錄了，直接報錯（避免多等一輪超時）
                raise _conn_error(e) from None
        j = self._call("POST", "/api/login", {"username": self.user, "password": self.password})
        self.token = (j.get("data") or {}).get("token")
        if not self.token:
            raise PermissionError(f"err.admin_login|{j.get('msg') or j.get('message') or j.get('code')}")
        return self.token

    def get_password(self, email):
        """返回該郵箱在 BillionMail 的登錄密碼；查不到返回 None。"""
        if not self.token:
            self.login()
        j = self._call("GET", "/api/mailbox/list?keyword=" + urllib.parse.quote(email))
        if j.get("code") not in (0, None) and not (j.get("data") or {}).get("list"):
            # token 可能過期，重登一次
            self.token = None
            self.login()
            j = self._call("GET", "/api/mailbox/list?keyword=" + urllib.parse.quote(email))
        lst = (j.get("data") or {}).get("list") or []
        for m in lst:
            if (m.get("username") or "").lower() == email.lower():
                return m.get("password") or ""
        return None

    def _authed(self, method, path, body=None):
        """帶登錄態調用；token 過期（code 非 0 且像是鑑權錯誤）時重登一次。"""
        if not self.token:
            self.login()
        j = self._call(method, path, body)
        if j.get("code") in (401, 403) or "token" in str(j.get("msg") or j.get("message") or "").lower():
            self.token = None
            self.login()
            j = self._call(method, path, body)
        return j

    def list_domains(self):
        """後台裡的所有郵件域名：[{"domain": "a.com", "a_record": "mail.a.com"}]（a_record 是該域名的郵件服務器）。"""
        j = self._authed("GET", "/api/domains/list?page=1&page_size=200")
        return [{"domain": d["domain"].lower(), "a_record": (d.get("a_record") or "").strip()}
                for d in ((j.get("data") or {}).get("list") or []) if d.get("domain")]

    def create_mailbox(self, domain, local_part, password, full_name=""):
        """新建郵箱，成功返回 True；失敗拋出帶後台提示的錯誤。"""
        body = {"domain": domain, "local_part": local_part, "password": password, "full_name": full_name or local_part,
                "active": 1, "isAdmin": 0, "quota": 5242880, "quota_active": 1}
        j = self._authed("POST", "/api/mailbox/create", body)
        if j.get("code") in (0, None) and j.get("success") is not False:
            return True
        raise RuntimeError(f"err.admin_create|{j.get('msg') or j.get('message') or j.get('code')}")

    def all_mailboxes(self):
        """後台裡的全部郵箱（分頁取完）：username / password / domain / local_part / full_name / quota / active / mx …"""
        out, page = [], 1
        while True:
            j = self._authed("GET", f"/api/mailbox/list?page={page}&page_size=100")
            data = j.get("data") or {}
            lst = data.get("list") or []
            out.extend(lst)
            if not lst or len(out) >= int(data.get("total") or 0) or page > 200:
                return out
            page += 1

    def get_mailbox(self, email):
        """按地址取一個郵箱的完整信息，查不到返回 None。"""
        j = self._authed("GET", "/api/mailbox/list?page=1&page_size=50&keyword=" + urllib.parse.quote(email))
        for m in (j.get("data") or {}).get("list") or []:
            if (m.get("username") or "").lower() == email.lower():
                return m
        return None

    def update_mailbox(self, m, password=None, active=None):
        """修改郵箱（密碼 / 啟用狀態），m 是 all_mailboxes 返回的一項，其餘字段保持原值。"""
        body = {"domain": m.get("domain"), "local_part": m.get("local_part") or m["username"].split("@")[0],
                "full_name": m.get("full_name") or m.get("local_part") or m["username"].split("@")[0],
                "password": password if password is not None else (m.get("password") or ""),
                "active": int(m.get("active", 1) if active is None else active), "isAdmin": int(m.get("is_admin") or 0),
                "quota": int(m.get("quota") or 5242880), "quota_active": int(m.get("quota_active", 1))}
        j = self._authed("POST", "/api/mailbox/update", body)
        if j.get("code") not in (0, None) or j.get("success") is False:
            raise RuntimeError(f"err.admin_update|{j.get('msg') or j.get('message') or j.get('code')}")

    def delete_mailboxes(self, emails):
        j = self._authed("POST", "/api/mailbox/delete", {"emails": list(emails)})
        if j.get("code") not in (0, None) or j.get("success") is False:
            raise RuntimeError(f"err.admin_delete|{j.get('msg') or j.get('message') or j.get('code')}")

    def list_mailboxes(self):
        """返回所有郵箱地址（測試連接用）。"""
        if not self.token:
            self.login()
        j = self._call("GET", "/api/mailbox/list?page=1&page_size=1")
        return int((j.get("data") or {}).get("total") or 0)
