"""本地 HTTP API：給其他程序 / 腳本讀取郵箱數據（只讀）。

默認關閉，在「設置 → API 接口」裡打開。每個請求都要帶 Token：
  Authorization: Bearer <token>   或   X-API-Token: <token>   或   ?token=<token>
軟件鎖定時：打開了「鎖定時也能讀取」（默認打開）就照常返回，否則返回 423。默認只監聽 127.0.0.1。
/mcp 是給 AI 工具用的 MCP 接口（Streamable HTTP，見 mcpserver.py），認證方式相同。
"""

import hashlib
import hmac
import json
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

import mcpserver

ENDPOINTS = [
    {"path": "/api/accounts", "desc": "郵箱列表。參數：sheet、group、family、status、email（多個用逗號）、search、fields、limit、offset、format=txt、sep"},
    {"path": "/api/account", "desc": "單個郵箱的全部信息。參數：email 或 id"},
    {"path": "/api/2fa", "desc": "當前 2FA 驗證碼。參數：email（多個用逗號）或 secret"},
    {"path": "/api/groups", "desc": "分組列表和每個分組的郵箱數"},
    {"path": "/api/sheets", "desc": "列表（表格）和郵箱數"},
    {"path": "/api/families", "desc": "家庭組：組長和成員"},
    {"path": "/api/health", "desc": "服務狀態、是否鎖定"},
    {"path": "/mcp", "desc": "MCP 接口（Streamable HTTP，POST JSON-RPC），給 AI 工具用"},
]
MCP_MAX_BODY = 1024 * 1024


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

            def _is_mcp(self):
                return urlparse(self.path).path.rstrip("/") == "/mcp"

            def do_GET(self):
                if self._is_mcp():  # 不提供服務器主動推送的 SSE 流，規範要求返回 405
                    return self._reply(405, {"error": "use POST for MCP"}, headers={"Allow": "POST"})
                server._serve(self)

            def do_POST(self):
                if self._is_mcp():
                    return server._serve_mcp(self)
                self._reply(405, {"error": "method not allowed: this API is read-only"})

            def do_DELETE(self):
                self._reply(405, {"error": "method not allowed"}, headers={"Allow": "POST" if self._is_mcp() else "GET"})

            def _reply(self, status, body, text=False, headers=None):
                data = b"" if body is None else (body if text else json.dumps(body, ensure_ascii=False, indent=None)).encode("utf-8")
                self.send_response(status)
                if body is not None:
                    self.send_header("Content-Type", ("text/plain" if text else "application/json") + "; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
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
        return token

    def _serve(self, req):
        url = urlparse(req.path)
        query = parse_qs(url.query, keep_blank_values=True)
        path, text = url.path.rstrip("/") or "/", False
        try:
            token = self._check_token(req, query)
            params = {k: v[-1] for k, v in query.items() if k != "token"}
            body, text = self.provider._api_handle(path, params, token)
            status = 200
        except ApiError as e:
            status, body = e.status, {"error": str(e)}
        except PermissionError:
            status, body = 423, {"error": "locked: unlock the app, or turn on \"readable while locked\" in the API settings"}
        except Exception as e:  # noqa: BLE001
            status, body = 500, {"error": f"{type(e).__name__}: {e}"}
        shown_q = urlencode({k: v[-1] for k, v in query.items() if k != "token"})  # 記錄裡不保存 Token
        self._log(req, url.path + (f"?{shown_q}" if shown_q else ""), status)
        req._reply(status, body, text)

    def _log(self, req, path, status):
        self.log.appendleft({"time": time.strftime("%Y-%m-%d %H:%M:%S"), "ip": req.client_address[0], "path": path, "status": status})

    # ---------- MCP（Streamable HTTP）：POST /mcp，請求體是一條或一批 JSON-RPC 消息 ----------
    def _serve_mcp(self, req):
        url = urlparse(req.path)
        query = parse_qs(url.query, keep_blank_values=True)
        rpc_error = lambda code, msg: {"jsonrpc": "2.0", "id": None, "error": {"code": code, "message": msg}}  # noqa: E731
        # 防 DNS 重綁定：瀏覽器發來的請求帶 Origin，只接受本機頁面（AI 工具等非瀏覽器客戶端不帶 Origin）
        origin = req.headers.get("Origin")
        if origin and origin != "null" and urlparse(origin).hostname not in ("localhost", "127.0.0.1", "::1"):
            self._log(req, "/mcp (origin rejected)", 403)
            return req._reply(403, rpc_error(-32000, "origin not allowed"))
        try:
            token = self._check_token(req, query)
        except ApiError as e:
            self._log(req, "/mcp", 401)
            return req._reply(401, rpc_error(-32001, str(e)), headers={"WWW-Authenticate": 'Bearer realm="mail-manager"'})
        length = int(req.headers.get("Content-Length") or 0)
        if length > MCP_MAX_BODY:
            self._log(req, "/mcp", 413)
            return req._reply(413, rpc_error(-32600, "request too large"))
        try:
            message = json.loads(req.rfile.read(length) or b"null")
        except ValueError:
            self._log(req, "/mcp", 400)
            return req._reply(400, rpc_error(-32700, "Parse error"))
        call_api = lambda path, params: self.provider._api_handle(path, params, token)  # noqa: E731
        if isinstance(message, list):
            out = [r for r in (mcpserver.handle(m, call_api) for m in message) if r is not None] or None
        else:
            out = mcpserver.handle(message, call_api)
        status = 202 if out is None else 200  # 只有通知 / 響應：202，沒有內容
        self._log(req, "/mcp " + mcpserver.describe(message), status)
        req._reply(status, out)
