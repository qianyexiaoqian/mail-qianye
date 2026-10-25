// 批量導入：拆分每行、識別字段（智能識別 / 按指定順序）。依賴 countries.js 的 countryIndex / countryScore。

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 導入時可選的字段：數據庫字段 + 國家/地區（寫入「國家/地區」類型的自定義列）
const IMPORT_EXTRA_FIELDS = ['country'];

// 只認精確的國家寫法：二位/三位代碼、別名、四種語言的完整名稱（us、USA、uk、日本、Japan）
function countryFromText(s) {
  const q = (s || '').trim().toLowerCase();
  if (!q || q.length > 30 || /\d/.test(q)) return '';
  let best = '', top = 0;
  for (const c of countryIndex()) {
    const score = countryScore(c, q);
    if (score > top) { top = score; best = c.code; }
  }
  return top >= 95 ? best : '';
}

function splitImportLine(line, sep) {
  const cut = s => line.split(s).map(p => p.trim());
  if (sep !== 'auto') return cut(sep);
  for (const s of ['----', '\t', '|']) if (line.includes(s)) return cut(s);
  // 郵箱/密碼/輔助郵箱/2FA/地區（避開 otpauth:// 鏈接裡的斜槓）
  if (line.includes('/') && !line.includes('://')) {
    const parts = cut('/');
    if (parts.some(p => EMAIL_RE.test(p))) return parts;
  }
  for (const s of [',', ';', '，', '；']) if (line.includes(s)) return cut(s);
  // 郵箱 密碼 …（空格分隔）
  const words = line.trim().split(/\s+/);
  if (words.length > 1 && EMAIL_RE.test(words[0])) return words;
  if (line.includes(':')) return cut(':');
  return [line.trim()];
}

function isTotpSecret(p) {
  if (/^otpauth:\/\//i.test(p)) return true;
  const s = p.replace(/\s/g, '').replace(/=+$/, '');
  if (s.length < 16 || s.length > 128) return false;
  // 全大寫，或者全小寫但帶數字（全小寫字母更可能是密碼）
  return /^[A-Z2-7]+$/.test(s) || (/^[a-z2-7]+$/.test(s) && /\d/.test(s));
}

function classifyPart(p) {
  if (!p) return 'empty';
  if (EMAIL_RE.test(p)) return 'email';
  if ((p.match(/(?<!\d)\d{4}[ -]?\d{4}(?!\d)/g) || []).length >= 2) return 'backup';  // 多個 8 位碼 = 備用碼
  if (isTotpSecret(p)) return 'totp';
  if (UUID_RE.test(p)) return 'client_id';
  if (p.length >= 80 && !/\s/.test(p)) return 'token';
  if (/^\+\d[\d\s-]{6,18}$/.test(p)) return 'phone';
  if (countryFromText(p)) return 'country';
  return 'text';
}

const SMART_KIND_FIELD = { backup: 'backup_codes', totp: 'totp_secret', client_id: 'oauth_client_id', token: 'oauth_token', phone: 'phone', country: 'country' };

/* 智能識別：不管順序，按內容判斷每一段是什麼。
   第一個郵箱 = 郵箱，第二個 = 輔助郵箱；緊跟郵箱的一段 = 密碼，緊跟輔助郵箱的普通文本 = 輔助郵箱密碼。
   2FA 密鑰、ClientID、令牌特徵明顯，不受位置影響。 */
function smartAssign(parts) {
  const row = {}, rest = [];
  let prev = '';
  for (const p of parts) {
    const kind = classifyPart(p);
    if (kind === 'empty') { prev = ''; continue; }
    const distinct = kind === 'totp' || kind === 'client_id' || kind === 'token' || kind === 'backup';
    let field = '';
    if (kind === 'email') field = !row.email ? 'email' : 'recovery_email';
    else if (prev === 'email' && !distinct) field = 'password';
    else if (prev === 'recovery_email' && kind === 'text') field = 'recovery_password';
    else if (kind === 'text') field = row.email && !row.password ? 'password' : '';
    else field = SMART_KIND_FIELD[kind];
    if (field && !row[field]) {
      row[field] = field === 'country' ? countryFromText(p) : p;
      prev = field;
    } else {
      rest.push(p);
      prev = '';
    }
  }
  return { row, rest };
}

function orderAssign(parts, order) {
  const row = {}, rest = [];
  order.forEach((field, i) => {
    const v = parts[i];
    if (field === 'skip' || !v) return;
    if (field === 'country') {
      const code = countryFromText(v);
      if (code) row.country = code; else rest.push(v);
    } else row[field] = v;
  });
  return { row, rest };
}

/* 解析整段文本。返回：
   rows   —— 完整識別的行
   failed —— 無法識別的行 { n: 行號, raw, reason: [i18n key, 參數], row: 有郵箱時的部分結果（多餘內容放進備註） } */
function parseImport(text, sep, mode, order) {
  const rows = [], failed = [];
  (text || '').split(/\r?\n/).forEach((line, idx) => {
    const raw = line.trim();
    if (!raw) return;
    const parts = splitImportLine(raw, sep);
    const { row, rest } = mode === 'manual' ? orderAssign(parts, order) : smartAssign(parts);
    const fail = reason => {
      const partial = row.email && EMAIL_RE.test(row.email)
        ? { ...row, notes: [row.notes, ...rest].filter(Boolean).join(' ') } : null;
      failed.push({ n: idx + 1, raw, reason, row: partial });
    };
    if (!row.email) return fail(['import.reason.noEmail']);
    if (!EMAIL_RE.test(row.email)) return fail(['import.reason.badEmail', { s: row.email }]);
    if (rest.length) return fail(['import.reason.extra', { s: rest.join(' | ') }]);
    rows.push(row);
  });
  return { rows, failed };
}

/* AI 流式輸出是 JSON Lines，邊收邊解析：返回已經完整的對象 */
function parseAiLines(text) {
  const out = [];
  for (let line of (text || '').split('\n')) {
    line = line.trim().replace(/^```(json)?/, '').replace(/,$/, '');
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try { out.push(JSON.parse(line)); } catch { /* 還沒收完的行 */ }
  }
  return out;
}

// AI 返回的一行 → 導入用的行
function aiRowToImport(obj) {
  const row = {};
  for (const f of ['email', 'password', 'totp_secret', 'backup_codes', 'recovery_email', 'recovery_password', 'oauth_client_id', 'oauth_token', 'phone', 'notes']) {
    const v = obj[f] == null ? '' : String(obj[f]).trim();
    if (v) row[f] = v;
  }
  const c = obj.country ? (countryFromText(String(obj.country)) || '') : '';
  if (c) row.country = c;
  else if (obj.country) row.notes = [row.notes, String(obj.country)].filter(Boolean).join(' ');
  return row;
}
