"""開發用：在普通瀏覽器裡調試界面。

python devserver.py  ->  http://127.0.0.1:8765
前端檢測不到 window.pywebview 時，會改用 POST /api/<方法名> 調用同一個 Api。
"""
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from backend import Api

ROOT = os.path.dirname(os.path.abspath(__file__))
api = Api(os.path.join(ROOT, "dev_data.db"))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=os.path.join(ROOT, "web"), **kwargs)

    def do_POST(self):
        name = self.path.removeprefix("/api/")
        length = int(self.headers.get("Content-Length") or 0)
        args = json.loads(self.rfile.read(length) or b"[]")
        try:
            if name.startswith("_"):
                raise AttributeError(name)
            result = {"ok": True, "data": getattr(api, name)(*args)}
        except Exception as e:  # 把錯誤帶回前端
            result = {"ok": False, "error": str(e)}
        body = json.dumps(result, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"http://127.0.0.1:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
