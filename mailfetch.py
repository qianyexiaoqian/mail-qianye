"""通過 IMAP 讀取自建郵箱（BillionMail / Dovecot）的最新郵件，並提取驗證碼。"""
import email
import html
import imaplib
import re
import socket
import ssl
from email.header import decode_header, make_header
from email.utils import parseaddr, parsedate_to_datetime

TIMEOUT = 12
MAX_TEXT = 20000
MAX_HTML = 300000
FOLDERS = ("INBOX", "Junk")  # 驗證碼郵件經常進垃圾箱

CODE_KEYWORDS = (
    r"code|verif|otp|pin|passcode|security|confirm|token|"
    r"驗證碼|验证码|校驗碼|校验码|動態碼|动态码|確認碼|确认码|安全碼|安全码|代碼|代码|"
    r"認証|認證|確認コード|認証コード|ワンタイム|코드|인증"
)
# 關鍵詞後 80 個字符內第一個「含數字」的 4–10 位詞，例如 "Your code is 123456"、"驗證碼：G-482913"
NEAR_CODE = re.compile(rf"(?:{CODE_KEYWORDS})[^\n]{{0,80}}?(?<![\w-])((?=[A-Z-]*\d)[A-Z0-9][A-Z0-9-]{{3,9}})(?![\w-])", re.I)
DIGITS = re.compile(r"(?<![\w.:/-])(\d{4,8})(?![\w.:/-])")


def _decode(value):
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def _html_to_text(raw):
    raw = re.sub(r"(?is)<(script|style|head)[^>]*>.*?</\1>", " ", raw)
    raw = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>|</h\d>|</li>", "\n", raw)
    raw = re.sub(r"(?s)<[^>]+>", " ", raw)
    raw = html.unescape(raw)
    raw = re.sub(r"[ \t\r\f\v ]+", " ", raw)
    return re.sub(r"\n\s*\n+", "\n\n", raw).strip()


def _bodies(msg):
    text, htm = "", ""
    for part in msg.walk() if msg.is_multipart() else [msg]:
        if part.get_content_maintype() == "multipart" or part.get_filename():
            continue
        ctype = part.get_content_type()
        if ctype not in ("text/plain", "text/html"):
            continue
        try:
            payload = part.get_payload(decode=True) or b""
            content = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        except (LookupError, AssertionError):
            content = (part.get_payload(decode=True) or b"").decode("utf-8", errors="replace")
        if ctype == "text/plain" and not text:
            text = content
        elif ctype == "text/html" and not htm:
            htm = content
    if not text and htm:
        text = _html_to_text(htm)
    return text.strip(), htm


def extract_codes(subject, text):
    """按可信度排序返回最多 3 個疑似驗證碼。"""
    found = []

    def add(code):
        code = code.strip("-")
        if re.fullmatch(r"\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2}-\d{4}", code):  # 日期
            return
        if code and code not in found and any(ch.isdigit() for ch in code):
            found.append(code)

    for source in (subject, text[:5000]):
        for m in NEAR_CODE.finditer(source or ""):
            add(m.group(1))
    if not found:
        digits = DIGITS.findall(f"{subject}\n{text[:5000]}")
        # 6 位數字最常見；4 位的排除像年份的
        for d in sorted(digits, key=lambda d: (len(d) != 6, digits.index(d))):
            if len(d) == 4 and d[:2] in ("19", "20"):
                continue
            add(d)
    return found[:3]


def _connect(cfg):
    host, port = cfg["host"].strip(), int(cfg.get("port") or 993)
    if cfg.get("ssl", True):
        ctx = ssl.create_default_context()
        if not cfg.get("verify_cert"):  # BillionMail 默認是自簽證書
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        return imaplib.IMAP4_SSL(host, port, ssl_context=ctx, timeout=TIMEOUT)
    conn = imaplib.IMAP4(host, port, timeout=TIMEOUT)
    if cfg.get("starttls"):
        conn.starttls()
    return conn


def test_server(cfg):
    conn = _connect(cfg)
    try:
        return {"greeting": conn.welcome.decode(errors="replace"), "capabilities": list(conn.capabilities)}
    finally:
        try:
            conn.logout()
        except Exception:
            pass


# 微軟個人郵箱常見域名，走 Outlook（outlook.office365.com）
MS_DOMAINS = {
    "outlook.com", "hotmail.com", "live.com", "msn.com", "hotmail.co.uk", "live.co.uk",
    "outlook.jp", "hotmail.fr", "live.fr", "outlook.fr", "hotmail.de", "outlook.de",
    "live.cn", "hotmail.com.br", "outlook.es", "passport.com",
}
MS_HOST = "outlook.office365.com"
MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
MS_SCOPE = "https://outlook.office.com/IMAP.AccessAsUser.All offline_access"


def is_microsoft(address):
    domain = (address or "").rsplit("@", 1)[-1].lower()
    return domain in MS_DOMAINS or domain.endswith(".onmicrosoft.com")


def build_mailbox(cfg, address, password, client_id="", token=""):
    """根據地址域名決定去哪台服務器、用哪種方式登錄。"""
    if is_microsoft(address):
        box = {"host": MS_HOST, "port": 993, "ssl": True, "verify_cert": True, "address": address}
        if token:  # 帶令牌（OAuth2）
            box.update(auth="xoauth2", client_id=client_id, refresh_token=token)
        else:  # 僅郵箱+密碼（微軟多數賬號已禁用，作兜底）
            box.update(auth="basic", user=address, password=password)
        return box
    # 自建郵箱（BillionMail / Dovecot）
    if not cfg.get("host"):
        raise ValueError("err.mail_no_host")
    box = {"host": cfg["host"], "port": int(cfg.get("port") or 993), "ssl": cfg.get("ssl", True),
           "verify_cert": cfg.get("verify_cert", False), "address": address, "auth": "basic",
           "user": address, "password": password}
    return box


def _ms_access_token(client_id, refresh_token):
    import json as _json
    import urllib.error
    import urllib.parse
    import urllib.request

    data = urllib.parse.urlencode({
        "client_id": client_id, "grant_type": "refresh_token",
        "refresh_token": refresh_token, "scope": MS_SCOPE,
    }).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(MS_TOKEN_URL, data=data), timeout=TIMEOUT) as resp:
            tok = _json.load(resp).get("access_token")
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = _json.load(e).get("error", "")
        except Exception:
            pass
        raise PermissionError(f"err.mail_token|{detail or e}")
    except (OSError, ValueError) as e:
        raise ConnectionError(f"err.mail_connect|{e}")
    if not tok:
        raise PermissionError("err.mail_token|no access_token")
    return tok


def _xoauth2(user, token):
    import base64
    return base64.b64encode(f"user={user}\x01auth=Bearer {token}\x01\x01".encode()).decode()


def _read_messages(conn, limit):
    messages = []
    for folder in FOLDERS:
        typ, _ = conn.select(folder, readonly=True)
        if typ != "OK":
            continue
        typ, data = conn.uid("search", None, "ALL")
        uids = data[0].split()[-limit:] if typ == "OK" and data and data[0] else []
        if not uids:
            continue
        typ, data = conn.uid("fetch", b",".join(uids), "(BODY.PEEK[])")
        for item in data or []:
            if not isinstance(item, tuple):
                continue
            uid = re.search(rb"UID (\d+)", item[0])
            msg = email.message_from_bytes(item[1])
            text, htm = _bodies(msg)
            subject = _decode(msg.get("Subject"))
            name, addr = parseaddr(_decode(msg.get("From")))
            try:
                ts = int(parsedate_to_datetime(msg.get("Date")).timestamp())
            except Exception:
                ts = 0
            messages.append({
                "id": f"{folder}:{uid.group(1).decode() if uid else len(messages)}",
                "folder": folder, "from_name": name, "from_addr": addr, "subject": subject, "date": ts,
                "codes": extract_codes(subject, text), "text": text[:MAX_TEXT], "html": htm[:MAX_HTML],
            })
    messages.sort(key=lambda m: m["date"], reverse=True)
    return messages[:limit]


def fetch(box, limit=15):
    """box 由 build_mailbox 生成，返回最新郵件列表（新的在前）。"""
    if box["auth"] == "xoauth2":
        token = _ms_access_token(box["client_id"], box["refresh_token"])
    elif not box.get("password"):
        raise ValueError("err.mail_no_password")
    try:
        conn = _connect(box)
    except (OSError, socket.timeout, ssl.SSLError) as e:
        raise ConnectionError(f"err.mail_connect|{e}")
    try:
        try:
            if box["auth"] == "xoauth2":
                conn.authenticate("XOAUTH2", lambda _: _xoauth2(box["address"], token).encode())
            else:
                conn.login(box["user"], box["password"])
        except imaplib.IMAP4.error as e:
            raise PermissionError(f"err.mail_login|{e}")
        return _read_messages(conn, limit)
    finally:
        try:
            conn.logout()
        except Exception:
            pass
