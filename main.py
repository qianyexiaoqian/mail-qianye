"""郵箱管理 - 程序入口（桌面窗口）。"""
import os
import sys

# 打包成無控制台的 exe 時 stdout/stderr 是 None，pywebview 記錄 API 異常時會崩潰，
# 導致錯誤永遠傳不回前端（比如輸錯主密碼後界面一直卡在「請稍候」）
if sys.stderr is None or sys.stdout is None:
    sys.stdout = sys.stderr = open(os.devnull, "w", encoding="utf-8")

import webview  # noqa: E402

from backend import Api, resource_dir  # noqa: E402


def main():
    api = Api()
    window = webview.create_window(
        "郵箱管理",
        os.path.join(resource_dir(), "web", "index.html"),
        js_api=api,
        width=1440,
        height=880,
        min_size=(1000, 600),
    )
    api._window = window

    def on_main_closed():  # 主窗口關了，自建郵箱管理窗口也一起關
        if api._self_window is not None:
            try:
                api._self_window.destroy()
            except Exception:
                pass

    window.events.closed += on_main_closed
    webview.start()


if __name__ == "__main__":
    main()
