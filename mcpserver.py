"""MCP（Model Context Protocol）接口：讓 Claude Code、Cursor、Cherry Studio 等 AI 工具直接查詢郵箱。

傳輸方式是 Streamable HTTP：掛在本地 API 服務的 /mcp 上，客戶端用 POST 發 JSON-RPC 消息，這裡直接返回 JSON
（規範允許不開 SSE 流；GET /mcp 返回 405）。認證和普通 API 一樣用 API 密鑰，工具全部只讀，
數據通過 call_api(path, params) 走普通 API 的同一套邏輯（篩選、鎖定時可讀等都一致）。
"""

import json

SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]
SERVER_INFO = {"name": "mail-manager", "title": "郵箱管理", "version": "1.0.0"}
INSTRUCTIONS = ("這是用戶本機「郵箱管理」軟件的只讀接口：可以查詢郵箱賬號、密碼、2FA 驗證碼和密鑰、輔助郵箱、分組、列表、家庭組。"
                "先用 list_groups / list_sheets 了解有哪些分組和列表，再用 list_accounts 按條件查詢。"
                "密碼和 2FA 是敏感信息，只在用戶需要時讀取，不要發給第三方。")

_FILTERS = {
    "sheet": {"type": "string", "description": "列表名或 id（不填 = 所有列表）"},
    "group": {"type": "string", "description": "分組名或 id，多個用逗號分隔；none = 未分組"},
    "family": {"type": "string", "description": "家庭組名"},
    "role": {"type": "string", "enum": ["owner", "member"], "description": "家庭組角色：owner 組長 / member 成員"},
    "status": {"type": "string", "description": "狀態，例如 正常、待驗證、異常、封禁、停用"},
    "email": {"type": "string", "description": "郵箱地址，多個用逗號分隔（不分大小寫）"},
    "search": {"type": "string", "description": "在郵箱、輔助郵箱、手機、備註裡搜索"},
    "has_2fa": {"type": "boolean", "description": "true = 只要有 2FA 密鑰的，false = 只要沒有的"},
}
_FIELDS = {"type": "array", "items": {"type": "string"},
           "description": "只返回這些字段：email, password, totp_code（2FA 驗證碼）, totp_secret（2FA 密鑰）, totp_remaining, recovery_email, "
                          "recovery_password, phone, status, notes, sheet, groups, families, backup_codes, oauth_client_id, oauth_token, columns，或自定義列名"}
_READ_ONLY = {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}


def _tool(name, title, description, properties=None, path="", fixed=None, default_limit=None):
    return {"name": name, "title": title, "description": description,
            "inputSchema": {"type": "object", "properties": properties or {}},
            "annotations": {"title": title, **_READ_ONLY},
            "_path": path, "_fixed": fixed or {}, "_default_limit": default_limit}


TOOLS = [
    _tool("list_accounts", "查詢郵箱列表",
          "查詢郵箱（含密碼、2FA 驗證碼 totp_code 和密鑰 totp_secret、輔助郵箱、分組、家庭組、備用碼、自定義列）。"
          "不帶條件返回全部郵箱，默認最多 50 個，用 offset 翻頁；total 是符合條件的總數。用 fields 只取需要的字段可以減少返回內容。",
          {**_FILTERS, "fields": _FIELDS, "limit": {"type": "integer", "description": "最多返回多少個，默認 50，最多 1000"},
           "offset": {"type": "integer", "description": "跳過前面多少個（翻頁）"}},
          "/api/accounts", default_limit=50),
    _tool("get_account", "獲取單個郵箱", "按郵箱地址或 id 獲取一個郵箱的全部信息。",
          {"email": {"type": "string", "description": "郵箱地址"}, "id": {"type": "integer", "description": "郵箱 id"}}, "/api/account"),
    _tool("get_2fa_code", "獲取 2FA 驗證碼",
          "獲取郵箱當前的 6 位 2FA 驗證碼和剩餘有效秒數（每 30 秒變化）。也可以直接傳 secret 計算任意 2FA 密鑰的驗證碼。",
          {"email": {"type": "string", "description": "郵箱地址，多個用逗號分隔"},
           "secret": {"type": "string", "description": "2FA 密鑰（Base32 或 otpauth:// 鏈接）"}}, "/api/2fa"),
    _tool("export_accounts_text", "導出為文本",
          "把郵箱導出成純文本，一行一個，按 fields 的順序用 sep 連接（默認 email,password,totp_secret 和 ----），適合給用戶複製或導入其他軟件。",
          {**_FILTERS, "fields": _FIELDS, "sep": {"type": "string", "description": "分隔符，默認 ----"},
           "limit": {"type": "integer", "description": "最多多少行，默認 1000"}},
          "/api/accounts", fixed={"format": "txt"}),
    _tool("list_groups", "分組列表", "列出所有分組和每個分組裡的郵箱數量（一個郵箱可以在多個分組）。", path="/api/groups"),
    _tool("list_sheets", "列表", "列出所有列表（表格）、郵箱數量和自定義列名。", path="/api/sheets"),
    _tool("list_families", "家庭組", "列出所有家庭組：類型、人數上限、組長和成員。", path="/api/families"),
]


def tool_list():
    return [{k: v for k, v in t.items() if not k.startswith("_")} for t in TOOLS]


class RpcError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _params(tool, args):
    """工具參數 → 普通 API 的查詢參數（布爾值轉 1/0，數組用逗號連接）。"""
    props = tool["inputSchema"]["properties"]
    p = dict(tool["_fixed"])
    for k, v in (args or {}).items():
        if k not in props or v is None or v == "" or v == []:
            continue
        if isinstance(v, bool):
            v = "1" if v else "0"
        elif isinstance(v, (list, tuple)):
            v = ",".join(map(str, v))
        p[k] = str(v)
    if tool["_default_limit"] and "limit" not in p:
        p["limit"] = str(tool["_default_limit"])
    return p


def call_tool(params, call_api):
    name = (params or {}).get("name")
    tool = next((t for t in TOOLS if t["name"] == name), None)
    if tool is None:
        raise RpcError(-32602, f"Unknown tool: {name}")
    args = (params or {}).get("arguments") or {}
    if not isinstance(args, dict):
        raise RpcError(-32602, "arguments must be an object")
    try:
        body, text = call_api(tool["_path"], _params(tool, args))
    except PermissionError:
        return {"content": [{"type": "text", "text": "郵箱管理軟件已鎖定，且沒有打開「鎖定時也能讀取」，請用戶解鎖軟件後再試。"}], "isError": True}
    except Exception as e:  # noqa: BLE001  參數錯誤、找不到郵箱等：作為工具結果返回，讓 AI 自己調整
        return {"content": [{"type": "text", "text": str(e)}], "isError": True}
    out = body if text else json.dumps(body, ensure_ascii=False)
    return {"content": [{"type": "text", "text": out or "(empty)"}], "isError": False}


def handle(message, call_api):
    """處理一條 JSON-RPC 消息。返回響應；通知（沒有 id）和客戶端發來的響應返回 None。"""
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}}
    method = message.get("method")
    if method is None:  # 客戶端對我們請求的響應（我們不發請求），忽略
        return None
    notify = "id" not in message
    mid = message.get("id")
    params = message.get("params") or {}
    try:
        if method == "initialize":
            want = params.get("protocolVersion")
            result = {"protocolVersion": want if want in SUPPORTED_VERSIONS else SUPPORTED_VERSIONS[0],
                      "capabilities": {"tools": {"listChanged": False}},
                      "serverInfo": SERVER_INFO, "instructions": INSTRUCTIONS}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": tool_list()}
        elif method == "tools/call":
            result = call_tool(params, call_api)
        elif method == "resources/list":
            result = {"resources": []}
        elif method == "resources/templates/list":
            result = {"resourceTemplates": []}
        elif method == "prompts/list":
            result = {"prompts": []}
        elif method.startswith("notifications/"):
            return None
        else:
            raise RpcError(-32601, f"Method not found: {method}")
    except RpcError as e:
        return None if notify else {"jsonrpc": "2.0", "id": mid, "error": {"code": e.code, "message": str(e)}}
    return None if notify else {"jsonrpc": "2.0", "id": mid, "result": result}


def describe(message):
    """請求記錄裡顯示的摘要：方法名，工具調用帶上工具名。"""
    msgs = message if isinstance(message, list) else [message]
    parts = []
    for m in msgs:
        if isinstance(m, dict) and m.get("method"):
            name = (m.get("params") or {}).get("name") if m["method"] == "tools/call" else ""
            parts.append(m["method"] + (f" {name}" if name else ""))
    return ", ".join(parts) or "(response)"
