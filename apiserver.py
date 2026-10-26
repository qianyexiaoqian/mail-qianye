"""本地 HTTP API：給其他程序 / 腳本讀取郵箱數據（只讀）。

默認關閉，在「設置 → API 接口」裡打開。每個請求都要帶 Token：
  Authorization: Bearer <token>   或   X-API-Token: <token>   或   ?token=<token>
軟件鎖定時返回 423（數據是加密的，解鎖後才能讀）。默認只監聽 127.0.0.1。
"""

import hashlib
import hmac
import json
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

ENDPOINTS = [
    {"path": "/api/accounts", "desc": "郵箱列表。參數：sheet、group、family、status、email（多個用逗號）、search、fields、limit、offset、format=txt、sep"},
    {"path": "/api/account", "desc": "單個郵箱的全部信息。參數：email 或 id"},
    {"path": "/api/2fa", "desc": "當前 2FA 驗證碼。參數：email（多個用逗號）或 secret"},
    {"path": "/api/groups", "desc": "分組列表和每個分組的郵箱數"},
    {"path": "/api/sheets", "desc": "列表（表格）和郵箱數"},
    {"path": "/api/families", "desc": "家庭組：組長和成員"},
    {"path": "/api/health", "desc": "服務狀態、是否鎖定"},
]


def token_hash(token):
    return hashlib.sha256((token or "").encode()).hexdigest()


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class ApiServer:
    """在後台線程裡跑 ThreadingHTTPServer；數據通過 provider（backend.Api）讀取。"""

    def __init__(self, provider):
        self.provider = provider
        self.httpd = None
        self.thread = None
        self.host = ""
        self.port = 0
        self.error = ""
        self.log = deque(maxlen=50)
        self._lock = threading.Lock()

    # ---------- 生命週期 ----------
    def start(self, host, port):
        with self._lock:
            self._stop()
            self.error = ""
            try:
                httpd = ThreadingHTTPServer((host, int(port)), self._handler())
            except OSError as e:
                self.error = f"{type(e).__name__}: {e}"
                return False
            httpd.daemon_threads = True
            self.httpd, self.host, self.port = httpd, host, int(port)
            self.thread = threading.Thread(target=httpd.serve_forever, name="mail-api", daemon=True)
            self.thread.start()
            return True

    def stop(self):
        with self._lock:
            self._stop()
            self.error = ""

    def _stop(self):
        if self.httpd is not None:
            self.httpd.shutdown()
            self.httpd.server_close()
        self.httpd = self.thread = None

    def status(self):
        running = self.httpd is not None
        shown = "127.0.0.1" if self.host in ("0.0.0.0", "") else self.host
        return {"running": running, "host": self.host if running else "", "port": self.port if running else 0,
                "url": f"http://{shown}:{self.port}" if running else "", "error": self.error}

    # ---------- 請求處理 ----------
    def _handler(self):
        server = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "MailManagerAPI/1.0"
            sys_version = ""

            def do_GET(self):
                server._serve(self)

            def do_POST(self):
                self._reply(405, {"error": "method not allowed: this API is read-only"})

            def _reply(self, status, body, text=False):
                data = (body if text else json.dumps(body, ensure_ascii=False, indent=None)).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", ("text/plain" if text else "application/json") + "; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass

        return Handler

    def _check_token(self, req, query):
        auth = req.headers.get("Authorization") or ""
        token = (auth[7:].strip() if auth.lower().startswith("bearer ") else "") or req.headers.get("X-API-Token") \
            or (query.get("token") or [""])[0]
        want = self.provider._api_token_hash()
        if not token or not want or not hmac.compare_digest(token_hash(token), want):
            time.sleep(0.3)  # 減慢猜測
            raise ApiError(401, "invalid or missing token")

    def _serve(self, req):
        url = urlparse(req.path)
        query = parse_qs(url.query, keep_blank_values=True)
        path, text = url.path.rstrip("/") or "/", False
        try:
            self._check_token(req, query)
            params = {k: v[-1] for k, v in query.items() if k != "token"}
            body, text = self.provider._api_handle(path, params)
            status = 200
        except ApiError as e:
            status, body = e.status, {"error": str(e)}
        except PermissionError:
            status, body = 423, {"error": "locked: unlock the app to read data"}
        except Exception as e:  # noqa: BLE001
            status, body = 500, {"error": f"{type(e).__name__}: {e}"}
        shown_q = urlencode({k: v[-1] for k, v in query.items() if k != "token"})  # 記錄裡不保存 Token
        self.log.appendleft({"time": time.strftime("%Y-%m-%d %H:%M:%S"), "ip": req.client_address[0],
                             "path": url.path + (f"?{shown_q}" if shown_q else ""), "status": status})
        req._reply(status, body, text)
