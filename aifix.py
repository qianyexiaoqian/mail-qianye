"""調用 OpenAI 兼容協議的 /chat/completions（流式，支持工具調用）。
用於：批量導入時 AI 糾錯無法識別的行；AI 助手對話。"""
import json
import urllib.error
import urllib.request

DEFAULT_BASE_URL = "https://api.deepseek.com/v1"
DEFAULT_MODEL = "deepseek-chat"

DEFAULT_PROMPT = """你是郵箱賬號數據整理助手。用戶會給你若干行程序無法自動識別的賬號數據，每行格式為「行號<Tab>原始內容」。
原始內容可能包含：郵箱、密碼、輔助郵箱、輔助郵箱密碼、2FA 密鑰（Base32 字符串或 otpauth:// 鏈接）、手機號、國家/地區、微軟 ClientID（UUID）、微軟 refresh token、備註等；
分隔符可能是 ---- / | , ; : 空格 Tab 等任意符號，也可能缺少分隔符、有多餘空格、全角符號或錯別字。

請逐行識別並修正，每個輸入行輸出一個 JSON 對象，一行一個（JSON Lines）。不要輸出任何解釋，不要使用 Markdown 代碼塊。對象格式：
{"line": 行號, "email": "", "password": "", "recovery_email": "", "recovery_password": "", "totp_secret": "", "phone": "", "country": "", "oauth_client_id": "", "oauth_token": "", "notes": "", "ok": true, "reason": ""}

規則：
1. email（主郵箱）必填；同一行裡第二個郵箱地址通常是輔助郵箱 recovery_email。
2. 只修正郵箱地址裡明顯的錯誤：全角＠和全角點、多餘空格、常見域名拼寫錯誤（gmial.com→gmail.com、outlok.com→outlook.com、hotmial.com→hotmail.com）、缺少 .com 等。不要臆造原文裡沒有的內容。
3. 密碼、輔助郵箱密碼、令牌必須與原文逐字一致，不要修改、補全或「糾正」。
4. totp_secret 是 16 位以上的 Base32 字符串（A-Z、2-7），去掉空格後輸出大寫；otpauth:// 鏈接原樣輸出。
5. country 輸出 ISO 3166-1 二位大寫代碼（us→US，uk→GB，日本→JP），無法確定就留空。
6. 無法歸類的內容放進 notes。
7. 實在找不到郵箱的行，輸出 "ok": false，並在 reason 裡用簡短中文說明原因。
8. 每個輸入行必須輸出且只輸出一個對象，line 與輸入的行號一致。"""


def endpoint(base_url):
    url = (base_url or "").strip().rstrip("/")
    if not url:
        raise ValueError("err.ai_no_url")
    if not url.lower().startswith(("http://", "https://")):
        url = "https://" + url
    if url.endswith("/chat/completions"):
        return url
    return url + "/chat/completions"


def _open(cfg, messages, stream, max_tokens=None, tools=None):
    if not (cfg.get("model") or "").strip():
        raise ValueError("err.ai_no_model")
    body = {"model": cfg["model"].strip(), "messages": messages, "stream": stream, "temperature": 0}
    if max_tokens:
        body["max_tokens"] = max_tokens
    if tools:
        body["tools"] = tools
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream" if stream else "application/json"}
    if cfg.get("api_key"):
        headers["Authorization"] = "Bearer " + cfg["api_key"].strip()
    req = urllib.request.Request(endpoint(cfg.get("base_url")), data=json.dumps(body).encode("utf-8"), headers=headers)
    try:
        return urllib.request.urlopen(req, timeout=int(cfg.get("timeout") or 120))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"err.ai_http|{e.code} {_error_detail(e.read())}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"err.ai_connect|{e.reason}") from None
    except TimeoutError:
        raise RuntimeError("err.ai_connect|timeout") from None


def _error_detail(raw):
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
    try:
        err = json.loads(text).get("error")
        if isinstance(err, dict):
            return err.get("message") or text[:300]
        if err:
            return str(err)
    except (ValueError, AttributeError):
        pass
    return text[:300]


def _message_text(data):
    choices = data.get("choices") or []
    if not choices:
        return ""
    msg = choices[0].get("message") or choices[0].get("delta") or {}
    return msg.get("content") or ""


def _merge_tool_calls(calls, deltas):
    """流式返回的 tool_calls 是按 index 分段的，拼成完整的調用。"""
    for d in deltas or []:
        i = d.get("index", len(calls))
        call = calls.setdefault(i, {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
        if d.get("id"):
            call["id"] = d["id"]
        fn = d.get("function") or {}
        call["function"]["name"] += fn.get("name") or ""
        call["function"]["arguments"] += fn.get("arguments") or ""


def stream_chat(cfg, messages, on_delta, should_stop=lambda: False, tools=None, on_tool=None):
    """流式請求，每收到一段文本調用 on_delta(text)，返回模型要調用的工具列表。
    服務不支持流式時退回一次性返回。"""
    resp = _open(cfg, messages, True, tools=tools)
    calls = {}
    with resp:
        if "event-stream" not in (resp.headers.get("Content-Type") or ""):
            data = json.loads(resp.read().decode("utf-8", "replace"))
            if data.get("error"):
                raise RuntimeError("err.ai_http|" + _error_detail(json.dumps(data)))
            on_delta(_message_text(data))
            msg = ((data.get("choices") or [{}])[0].get("message") or {})
            return msg.get("tool_calls") or []
        for raw in resp:
            if should_stop():
                break
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            try:
                chunk = json.loads(payload)
            except ValueError:
                continue
            if chunk.get("error"):
                raise RuntimeError("err.ai_http|" + _error_detail(payload))
            for choice in chunk.get("choices") or []:
                delta = choice.get("delta") or {}
                if delta.get("content"):
                    on_delta(delta["content"])
                if delta.get("tool_calls"):
                    _merge_tool_calls(calls, delta["tool_calls"])
                    if on_tool:
                        on_tool([calls[i] for i in sorted(calls)])
    result = [calls[i] for i in sorted(calls)]
    for i, c in enumerate(result):
        c["id"] = c["id"] or f"call_{i}"
    return result


def test(cfg):
    """發一條很短的請求，返回模型的回覆。"""
    with _open(cfg, [{"role": "user", "content": "Reply with the single word: OK"}], False, max_tokens=8) as resp:
        data = json.loads(resp.read().decode("utf-8", "replace"))
    if data.get("error"):
        raise RuntimeError("err.ai_http|" + _error_detail(json.dumps(data)))
    return _message_text(data).strip()[:60]


def fix_messages(prompt, lines):
    numbered = "\n".join(f"{i}\t{line}" for i, line in enumerate(lines, 1))
    return [{"role": "system", "content": prompt or DEFAULT_PROMPT}, {"role": "user", "content": numbered}]
