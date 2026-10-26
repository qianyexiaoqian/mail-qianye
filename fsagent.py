"""AI 助手操作電腦用的工具：瀏覽 / 讀取 / 搜索文件、從文件裡統計郵箱賬號、寫文件、移動、新建文件夾、
在資源管理器裡打開、執行命令。都是本機操作，由前端的 AI 助手調用（寫入類操作前端會先讓用戶確認）。"""

import fnmatch
import os
import re
import shutil
import subprocess
import sys
import time
import zipfile
from xml.etree import ElementTree

EMAIL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._%+\-]*@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,24}")
TEXT_EXTS = {".txt", ".csv", ".tsv", ".log", ".json", ".md", ".ini", ".conf", ".cfg", ".dat", ".yaml", ".yml", ".xml",
             ".html", ".htm", ".js", ".py", ".bat", ".ps1", ".sql", ".list", ".lst", ".text", ""}
DOC_EXTS = {".xlsx", ".docx"}
MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_SCAN_FILES = 3000
MAX_LIST = 500
MAX_OUTPUT = 20000


def normalize_path(path):
    """去掉引號；「E\\xxx」「E:xxx」補成「E:\\xxx」；~ 展開；統一分隔符。"""
    p = str(path or "").strip().strip('"').strip("'").strip()
    if not p:
        raise ValueError("path is empty")
    p = os.path.expandvars(os.path.expanduser(p))
    if os.name == "nt":
        p = p.replace("/", "\\")
        m = re.match(r"^([A-Za-z])(?::?)\\(.*)$", p) or re.match(r"^([A-Za-z]):(?!\\)(.*)$", p)
        if m and not re.match(r"^[A-Za-z]:\\", p):
            p = f"{m.group(1).upper()}:\\{m.group(2)}"
        elif re.match(r"^[A-Za-z]:$", p):
            p += "\\"
    return os.path.abspath(p)


def _missing(path):
    """路徑不存在：找到最近一級存在的上級目錄，列出名字相近的項，方便 AI 糾正（例如少打了一個字）。"""
    parent, want = os.path.dirname(path), os.path.basename(path)
    while parent and not os.path.isdir(parent):
        parent, want = os.path.dirname(parent), os.path.basename(parent)
        if parent == os.path.dirname(parent) and not os.path.isdir(parent):
            break
    out = {"error": f"path not found: {path}"}
    if os.path.isdir(parent):
        try:
            names = os.listdir(parent)
        except OSError:
            names = []
        w = want.lower()
        close = [n for n in names if w and (w in n.lower() or n.lower() in w or _similar(w, n.lower()))]
        out.update({"nearest_existing_dir": parent, "similar": close[:20], "entries": names[:60]})
    return out


def _similar(a, b):
    sa, sb = set(a), set(b)
    return bool(sa and sb) and len(sa & sb) / max(len(sa), len(sb)) >= 0.6


def _info(path):
    st = os.stat(path)
    return {"name": os.path.basename(path) or path, "path": path, "type": "dir" if os.path.isdir(path) else "file",
            "size": st.st_size if not os.path.isdir(path) else None,
            "modified": time.strftime("%Y-%m-%d %H:%M", time.localtime(st.st_mtime))}


def computer_info():
    home = os.path.expanduser("~")
    drives = []
    if os.name == "nt":
        drives = [f"{c}:\\" for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" if os.path.exists(f"{c}:\\")]
    desktop = os.path.join(home, "Desktop")
    return {"os": sys.platform, "home": home, "desktop": desktop if os.path.isdir(desktop) else "",
            "downloads": os.path.join(home, "Downloads"), "drives": drives}


def list_dir(path, pattern="", recursive=False, limit=200):
    path = normalize_path(path)
    if not os.path.exists(path):
        return _missing(path)
    if os.path.isfile(path):
        return {"path": path, "entries": [_info(path)], "total": 1}
    limit = max(1, min(int(limit or 200), MAX_LIST))
    pats = [p.strip() for p in re.split(r"[;,\s]+", pattern or "") if p.strip()]
    entries, total = [], 0
    for root, dirs, files in os.walk(path):
        dirs.sort()
        names = [(d, True) for d in dirs] + [(f, False) for f in sorted(files)]
        for name, is_dir in names:
            if pats and not is_dir and not any(fnmatch.fnmatch(name.lower(), p.lower()) for p in pats):
                continue
            total += 1
            if len(entries) < limit:
                full = os.path.join(root, name)
                try:
                    e = _info(full)
                except OSError:
                    continue
                e["path"] = os.path.relpath(full, path) if recursive else name
                entries.append(e)
        if not recursive:
            break
    return {"path": path, "entries": entries, "total": total, "truncated": total > len(entries)}


def _decode(data):
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8", "replace")
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16", "replace")
    for enc in ("utf-8", "gb18030", "big5"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", "replace")


def _xlsx_text(path):
    """不依賴 openpyxl 的簡易 xlsx 讀取：每行單元格用 Tab 連接，多個工作表依次輸出。"""
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            for si in ElementTree.fromstring(z.read("xl/sharedStrings.xml")).iter(ns + "si"):
                shared.append("".join(t.text or "" for t in si.iter(ns + "t")))
        sheets = sorted(n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n))
        lines = []
        for name in sheets:
            for row in ElementTree.fromstring(z.read(name)).iter(ns + "row"):
                cells = []
                for c in row.iter(ns + "c"):
                    v = c.find(ns + "v")
                    if c.get("t") == "s" and v is not None:
                        cells.append(shared[int(v.text)])
                    elif c.get("t") == "inlineStr":
                        cells.append("".join(t.text or "" for t in c.iter(ns + "t")))
                    else:
                        cells.append(v.text if v is not None and v.text else "")
                if any(cells):
                    lines.append("\t".join(cells))
        return "\n".join(lines)


def _docx_text(path):
    ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    with zipfile.ZipFile(path) as z:
        root = ElementTree.fromstring(z.read("word/document.xml"))
    return "\n".join("".join(t.text or "" for t in p.iter(ns + "t")) for p in root.iter(ns + "p"))


def read_text(path):
    """讀取文本類文件（自動識別編碼），xlsx / docx 轉成純文本；其他二進制文件返回 None。"""
    ext = os.path.splitext(path)[1].lower()
    if os.path.getsize(path) > MAX_FILE_BYTES:
        raise ValueError(f"file too large (> {MAX_FILE_BYTES // 1024 // 1024} MB)")
    if ext == ".xlsx":
        return _xlsx_text(path)
    if ext == ".docx":
        return _docx_text(path)
    with open(path, "rb") as f:
        data = f.read()
    if ext not in TEXT_EXTS and b"\x00" in data[:4096] and not data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return None
    return _decode(data)


def read_file(path, offset=1, limit=200, max_chars=12000):
    path = normalize_path(path)
    if not os.path.exists(path):
        return _missing(path)
    if os.path.isdir(path):
        return {"error": "this is a folder, use fs_list", "path": path}
    text = read_text(path)
    if text is None:
        return {"error": "binary file, cannot read as text", "path": path, "size": os.path.getsize(path)}
    lines = text.splitlines()
    start = max(1, int(offset or 1))
    limit = max(1, min(int(limit or 200), 2000))
    chunk, size = [], 0
    for i in range(start - 1, min(len(lines), start - 1 + limit)):
        line = lines[i]
        if size + len(line) > max_chars and chunk:
            break
        chunk.append(f"{i + 1}\t{line[:2000]}")
        size += len(line) + 8
    end = start + len(chunk) - 1
    return {"path": path, "total_lines": len(lines), "from": start, "to": end, "more": end < len(lines), "content": "\n".join(chunk)}


def _iter_files(path, pattern="", recursive=True):
    pats = [p.strip() for p in re.split(r"[;,\s]+", pattern or "") if p.strip()]
    if os.path.isfile(path):
        yield path
        return
    n = 0
    for root, dirs, files in os.walk(path):
        dirs.sort()
        for name in sorted(files):
            if pats and not any(fnmatch.fnmatch(name.lower(), p.lower()) for p in pats):
                continue
            ext = os.path.splitext(name)[1].lower()
            if not pats and ext not in TEXT_EXTS and ext not in DOC_EXTS:
                continue
            n += 1
            if n > MAX_SCAN_FILES:
                return
            yield os.path.join(root, name)
        if not recursive:
            return


def search(path, query, regex=False, pattern="", recursive=True, ignore_case=True, limit=100):
    path = normalize_path(path)
    if not os.path.exists(path):
        return _missing(path)
    flags = re.IGNORECASE if ignore_case else 0
    rx = re.compile(query if regex else re.escape(query), flags)
    hits, files_hit, total = [], set(), 0
    limit = max(1, min(int(limit or 100), 500))
    for f in _iter_files(path, pattern, recursive):
        try:
            text = read_text(f)
        except (OSError, ValueError, zipfile.BadZipFile, ElementTree.ParseError):
            continue
        if text is None:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            if rx.search(line):
                total += 1
                files_hit.add(f)
                if len(hits) < limit:
                    hits.append({"file": os.path.relpath(f, path) if os.path.isdir(path) else os.path.basename(f), "line": i, "text": line[:500]})
    return {"path": path, "matches": total, "files": len(files_hit), "hits": hits, "truncated": total > len(hits)}


def scan_accounts(path, pattern="", recursive=True):
    """統計文件 / 文件夾裡的郵箱賬號：每一行的第一個郵箱算一個賬號（同一行後面的郵箱一般是輔助郵箱）。
    返回每個文件的統計、去重後的郵箱、每個郵箱對應的原始行（導入時用）。"""
    path = normalize_path(path)
    if not os.path.exists(path):
        return _missing(path)
    files, order, lines, skipped = [], [], {}, []
    dup_in_files = 0
    all_emails = set()
    for f in _iter_files(path, pattern, recursive):
        rel = os.path.relpath(f, path) if os.path.isdir(path) else os.path.basename(f)
        try:
            text = read_text(f)
        except (OSError, ValueError, zipfile.BadZipFile, ElementTree.ParseError) as e:
            skipped.append({"file": rel, "reason": str(e)[:120]})
            continue
        if text is None:
            skipped.append({"file": rel, "reason": "binary"})
            continue
        n_lines, emails = 0, []
        for line in text.splitlines():
            found = EMAIL_RE.findall(line)
            if not found:
                continue
            n_lines += 1
            all_emails.update(x.lower() for x in found)
            e = found[0].lower()
            emails.append(e)
            if e in lines:
                dup_in_files += 1
            else:
                lines[e] = line.strip()
                order.append(e)
        if n_lines:
            files.append({"file": rel, "accounts": n_lines, "unique": len(set(emails))})
    return {"path": path, "is_dir": os.path.isdir(path), "files": files, "files_scanned": len(files) + len(skipped),
            "skipped": skipped[:30], "emails": order, "lines": lines, "duplicates": dup_in_files, "all_emails": len(all_emails)}


def write_file(path, content, append=False, overwrite=False):
    path = normalize_path(path)
    if os.path.isdir(path):
        return {"error": "path is a folder", "path": path}
    if os.path.exists(path) and not append and not overwrite:
        return {"error": "file already exists; pass overwrite=true to replace it or append=true to add to the end", "path": path}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a" if append else "w", encoding="utf-8", newline="") as f:
        f.write(content or "")
    return {"path": path, "size": os.path.getsize(path), "appended": bool(append)}


def move(src, dest, copy=False):
    src, dest = normalize_path(src), normalize_path(dest)
    if not os.path.exists(src):
        return _missing(src)
    if os.path.isdir(dest):
        dest = os.path.join(dest, os.path.basename(src))
    if os.path.exists(dest):
        return {"error": f"destination already exists: {dest}"}
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if copy:
        (shutil.copytree if os.path.isdir(src) else shutil.copy2)(src, dest)
    else:
        shutil.move(src, dest)
    return {"from": src, "to": dest, "copied": bool(copy)}


def mkdir(path):
    path = normalize_path(path)
    existed = os.path.isdir(path)
    os.makedirs(path, exist_ok=True)
    return {"path": path, "existed": existed}


def reveal(path):
    """在資源管理器裡打開文件夾，或打開文件所在的文件夾並選中它（不直接運行文件）。"""
    path = normalize_path(path)
    if not os.path.exists(path):
        return _missing(path)
    if os.name == "nt":
        if os.path.isdir(path):
            os.startfile(path)
        else:
            subprocess.Popen(["explorer", "/select,", path])
    else:
        subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", path if os.path.isdir(path) else os.path.dirname(path)])
    return {"opened": path}


def run_command(command, cwd="", timeout=60):
    """在 PowerShell（Windows）或 sh 裡執行一條命令，返回輸出（截斷到 2 萬字符）。"""
    timeout = max(1, min(int(timeout or 60), 600))
    cwd = normalize_path(cwd) if cwd else os.path.expanduser("~")
    if not os.path.isdir(cwd):
        return _missing(cwd)
    if os.name == "nt":
        args = ["powershell", "-NoProfile", "-NonInteractive", "-Command",
                "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; " + command]
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    else:
        args, flags = ["sh", "-c", command], 0
    started = time.time()
    try:
        r = subprocess.run(args, cwd=cwd, capture_output=True, timeout=timeout, creationflags=flags)
    except subprocess.TimeoutExpired as e:
        out = _decode(e.stdout or b"") + _decode(e.stderr or b"")
        return {"error": f"timed out after {timeout}s", "output": out[-MAX_OUTPUT:]}
    out, err = _decode(r.stdout or b""), _decode(r.stderr or b"")
    return {"exit_code": r.returncode, "cwd": cwd, "seconds": round(time.time() - started, 1),
            "stdout": out[-MAX_OUTPUT:], "stderr": err[-5000:], "truncated": len(out) > MAX_OUTPUT}
