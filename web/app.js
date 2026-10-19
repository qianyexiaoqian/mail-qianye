const { createApp, reactive, nextTick } = Vue;

// ---------- 後端調用：桌面版走 pywebview，開發模式 (?dev) 走 HTTP ----------
const DEV = new URLSearchParams(location.search).has('dev');
const apiReady = DEV ? Promise.resolve() : new Promise(resolve => {
  if (window.pywebview && window.pywebview.api && window.pywebview.api.get_state) return resolve();
  window.addEventListener('pywebviewready', () => resolve());
});

async function call(name, ...args) {
  await apiReady;
  if (!DEV) return window.pywebview.api[name](...args);
  const res = await fetch('/api/' + name, { method: 'POST', body: JSON.stringify(args) });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error);
  return json.data;
}

// ---------- 多語言 ----------
const ui = reactive({ lang: 'zh-Hant' });
function t(key, params) {
  let s = I18N[ui.lang]?.[key] ?? I18N['zh-Hant'][key] ?? key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] ?? m));
  return s;
}
// 後端拋出的錯誤是 err.xxx 形式的 key，可帶 "|詳情"
function errText(e) {
  const msg = (e && e.message) || String(e);
  const [key, ...rest] = msg.split('|');
  if (!I18N['zh-Hant'][key]) return msg;
  return t(key) + (rest.length ? `（${rest.join('|')}）` : '');
}

// ---------- AI（OpenAI 兼容接口，請求在後台線程流式進行） ----------
// 配置齊全：有地址、模型和 Key；本地模型（Ollama 等）可以不填 Key
function aiConfigured(cfg) {
  if (!cfg || !cfg.base_url || !cfg.model) return false;
  return !!cfg.has_api_key || /\/\/(localhost|127\.0\.0\.1)[:/]/.test(cfg.base_url);
}
// 輪詢後台 AI 任務直到結束：onDelta(新文本)，shouldStop() 為真時停止。返回 { tool_calls, stopped }，出錯拋異常
async function pollAiJob(job, onDelta, shouldStop = () => false) {
  let offset = 0;
  for (;;) {
    if (shouldStop()) {
      call('ai_fix_stop', job).catch(() => {});
      return { tool_calls: [], stopped: true };
    }
    const r = await call('ai_fix_poll', job, offset);
    offset = r.offset;
    if (r.delta) onDelta(r.delta);
    if (r.done) {
      if (r.error) throw new Error(r.error);
      return { tool_calls: r.tool_calls || [], stopped: false };
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

// 國家數據、countryName / flag / searchCountries / resolveCountries 在 countries.js

const COLOR_MARKS = ['#e5484d', '#f76b15', '#f5a524', '#30a46c', '#12a594', '#0ea5e9', '#4f7cff', '#8e4ec6', '#e93d82', '#8b5e3c', '#64748b', '#1f2937'];
const EMOJIS = ('⭐ 🔥 ✅ ❌ ⚠️ ❗ ❓ 💎 💰 🎯 📌 📧 🔒 🔑 🛡️ 🚫 ⏳ 🆕 👍 👎 👤 👥 🤖 💼 🏠 🎮 🛒 📱 💻 🌐 ' +
  '📞 ✉️ 🟢 🟡 🔴 🔵 🟣 🟠 ⚫ ⚪ ❤️ 💛 💚 💙 💜 🖤 🚀 🌟 🎁 🏆 💤 🧪 📝 🍎 🐱 🐶 🌸 ☁️ 🌙 ☀️').split(' ');
const COLUMN_TYPES = ['text', 'color', 'country', 'emoji', 'image'];
// 微軟個人郵箱域名（和後端 mailfetch.MS_DOMAINS 保持一致），用於前端判斷是否顯示收件箱
const MS_DOMAINS = new Set(['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'hotmail.co.uk', 'live.co.uk',
  'outlook.jp', 'hotmail.fr', 'live.fr', 'outlook.fr', 'hotmail.de', 'outlook.de', 'live.cn', 'hotmail.com.br', 'outlook.es', 'passport.com']);
function isMicrosoft(address) {
  const d = (address || '').split('@').pop().toLowerCase();
  return MS_DOMAINS.has(d) || d.endsWith('.onmicrosoft.com');
}

// 圖片縮成小縮略圖再存（data URL 存在數據庫裡）
function fileToThumb(file, max = 128) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        let url = canvas.toDataURL('image/webp', 0.85);
        if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/png');
        resolve(url);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

const BASE_COLUMNS = [
  { key: 'index' }, { key: 'email', sort: true }, { key: 'password' }, { key: 'totp' }, { key: 'recovery_email', sort: true },
  { key: 'recovery_password' }, { key: 'phone', sort: true }, { key: 'group', sort: true }, { key: 'status', sort: true },
  { key: 'notes', sort: true }, { key: 'updated', sort: true },
];
const DEFAULT_VISIBLE = { index: true, email: true, password: true, totp: true, recovery_email: true, recovery_password: false,
  phone: false, group: true, status: true, notes: true, updated: false };
// 默認列寬（px），拖動表頭右邊緣可調整，記在 prefs.colWidths
const DEFAULT_WIDTHS = { index: 56, email: 250, password: 140, totp: 110, recovery_email: 230, recovery_password: 140, phone: 140,
  group: 100, status: 80, notes: 240, updated: 140 };
const DEFAULT_CUSTOM_WIDTHS = { text: 140, color: 70, country: 90, emoji: 90, image: 70 };
const MIN_COL_WIDTH = 50;
const INBOX_PAGE = 15;  // 收件箱每次刷新取的數量，「加載更多」每次多取 50 封
const INBOX_MORE = 50;
const DEFAULT_FILTERS = { group: '', status: '', domain: '', twofa: '', recovery: '', country: '' };
const DEFAULT_PREFS = { theme: 'light', lang: 'zh-Hant', autoLock: 15, pageSize: 20, page: 1, scroll: 0, sheetId: null,
  filters: { ...DEFAULT_FILTERS }, sort: { key: '', dir: 1 }, visible: { ...DEFAULT_VISIBLE },
  colOrders: {}, colWidths: {},  // 列順序按列表分別記（自定義列每個列表不同），_default 是最近一次調整的順序
  importMode: 'smart', importOrder: ['email', 'password', 'totp_secret', 'recovery_email', 'skip', 'skip'],
  mailAuto: true, mailAutoCopy: false, agentAuto: false, agentSecrets: false };
// 常用的 OpenAI 兼容服務，設置裡一鍵填入
const AI_PRESETS = [
  { name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'OpenAI', base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: '通義千問', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: '硅基流動', base_url: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  { name: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  { name: 'Ollama', base_url: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
];

/* 按保存的順序排列列；保存的順序裡沒有的列（新加的自定義列等）放在默認順序裡它前一列的後面 */
function orderColumns(cols, order) {
  const byKey = Object.fromEntries(cols.map(c => [c.key, c]));
  const out = (order || []).filter(k => byKey[k]).map(k => byKey[k]);
  cols.forEach((c, i) => {
    if (out.includes(c)) return;
    const prev = cols.slice(0, i).reverse().find(p => out.includes(p));
    out.splice(prev ? out.indexOf(prev) + 1 : 0, 0, c);
  });
  return out;
}

// 搜索時忽略 . _ - 空格等符號：johndoe 能找到 john.doe@xxx
const normalize = s => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

const app = createApp({
  mixins: [AgentMixin],  // AI 助手，見 agent.js
  data() {
    return {
      ready: false,
      meta: { statuses: [], fields: [], db_path: '' },
      prefs: JSON.parse(JSON.stringify(DEFAULT_PREFS)),
      sheets: [], groups: [], accounts: [],
      sheetId: null,
      search: '',
      filters: { ...DEFAULT_FILTERS },
      sort: { key: '', dir: 1 },
      selected: {}, revealed: {},
      showPwd: false,
      page: 1, pageSize: 20,
      codes: {}, now: Math.floor(Date.now() / 1000), lastWindow: 0,
      edit: null, editCode: '', imp: null, groupEdit: null, colEdit: null, dialog: null, settings: null,
      pop: null, bulkCol: null, inbox: null, mailCfg: null,
      exportMenu: false, toasts: [], dragCol: '', dragOver: '', aiPresets: AI_PRESETS,
      selfDomains: [], recType: '', recBusy: false,
      lock: { has_password: false, unlocked: false },
      lockForm: { pw: '', pw2: '', err: '', busy: false },
      systemDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
      columnTypes: COLUMN_TYPES, languages: LANGUAGES,
    };
  },

  computed: {
    currentSheet() { return this.sheets.find(s => s.id === this.sheetId) || { columns: [], name: '' }; },
    dbName() { return (this.meta.db_path || '').split(/[\\/]/).pop(); },
    groupMap() { return Object.fromEntries(this.groups.map(g => [g.id, g])); },
    importFields() { return [...this.meta.fields, ...IMPORT_EXTRA_FIELDS, 'skip']; },
    importPresets() {
      return [
        { name: t('import.presetDefault'), order: ['email', 'password', 'totp_secret', 'recovery_email'] },
        { name: t('import.presetSlash'), order: ['email', 'password', 'recovery_email', 'totp_secret', 'country'] },
        { name: t('import.presetMs'), order: ['email', 'password'] },
        { name: t('import.presetMsToken'), order: ['email', 'password', 'oauth_client_id', 'oauth_token'] },
      ];
    },
    // 導入預覽在前端實時解析
    impParsed() {
      const i = this.imp;
      return i ? parseImport(i.text, i.sep, i.mode, i.order) : { rows: [], failed: [] };
    },
    // 當前仍然是「無法識別」的原始行，AI 結果只對這些行生效（文本改了就自動作廢）
    impFailedKey() { return this.impParsed.failed.map(f => f.raw).join('\n'); },
    // 當前仍然無法識別的行裡，AI 已經給出結果的（文本改了，不再出現的行自動作廢）
    impAiRows() {
      const ai = this.imp?.ai;
      return ai ? this.impParsed.failed.map(f => ai.results[f.raw]).filter(Boolean) : [];
    },
    impAiChecked() { return this.impAiRows.filter(r => r.checked && this.validEmail(r.row.email)); },
    // 最終要導入的行：識別成功的 + 勾選的 AI 糾錯結果 + （可選）原樣導入有郵箱的失敗行
    impRows() {
      const fixed = new Set(this.impAiChecked.map(r => r.raw));
      const rows = [...this.impParsed.rows, ...this.impAiChecked.map(r => r.row)];
      if (this.imp?.keepPartial) for (const f of this.impParsed.failed) if (f.row && !fixed.has(f.raw)) rows.push(f.row);
      return rows;
    },
    impPreviewFields() {
      const set = new Set(this.impRows.flatMap(r => Object.keys(r)));
      return [...this.meta.fields, 'country'].filter(f => set.has(f));
    },
    // AI 結果表格顯示的字段：郵箱、密碼必顯示，其他有值才顯示
    impAiFields() {
      const set = new Set(['email', 'password', ...this.impAiRows.flatMap(r => Object.keys(r.row))]);
      return [...this.meta.fields, 'country'].filter(f => set.has(f));
    },
    remaining() { return 30 - (this.now % 30); },
    isDark() { return this.prefs.theme === 'dark' || (this.prefs.theme === 'system' && this.systemDark); },

    // 所有列（含隱藏的）的默認順序
    defaultColumns() {
      const cols = BASE_COLUMNS.map(c => ({ ...c, label: t('col.' + c.key) }));
      const custom = this.currentSheet.columns.map(col => ({ key: 'x_' + col.id, label: col.name, custom: true, col, sort: col.type !== 'image' }));
      const i = cols.findIndex(c => c.key === 'notes');  // 自定義列放在備註前面
      if (i >= 0) cols.splice(i, 0, ...custom); else cols.push(...custom);
      return cols;
    },
    // 按保存的順序排列
    allColumns() {
      const orders = this.prefs.colOrders || {};
      return orderColumns(this.defaultColumns, orders[this.sheetId] || orders._default);
    },
    visibleColumns() { return this.allColumns.filter(c => this.isColumnVisible(c.key)); },
    // 表格寬度 = 各列寬度之和（超出窗口時出現橫向滾動條），不足時撐滿
    tableStyle() {
      const sum = this.visibleColumns.reduce((n, c) => n + this.colWidth(c), 0) + 34 + 96;
      return { width: `max(100%, ${sum}px)` };
    },

    groupCounts() {
      const m = { none: 0 };
      for (const a of this.accounts) {
        if (a.group_id && this.groupMap[a.group_id]) m[a.group_id] = (m[a.group_id] || 0) + 1; else m.none++;
      }
      return m;
    },
    statusCounts() {
      const m = {};
      for (const a of this.accounts) m[a.status] = (m[a.status] || 0) + 1;
      return m;
    },
    domains() {
      const m = {};
      for (const a of this.accounts) { const d = domainOf(a.email); if (d) m[d] = (m[d] || 0) + 1; }
      return Object.entries(m).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    },
    hasFilter() {
      const f = this.filters;
      return !!(f.group || f.status || f.domain || f.twofa || f.recovery || f.country || this.search);
    },
    countryColumns() { return this.currentSheet.columns.filter(c => c.type === 'country'); },
    colorColumns() { return this.currentSheet.columns.filter(c => c.type === 'color'); },
    countryFilterCodes() { return this.countryColumns.length ? resolveCountries(this.filters.country) : []; },

    filtered() {
      const f = this.filters;
      const match = this.searchMatcher(this.search);
      const countryOn = this.countryColumns.length && f.country.trim();
      const countrySet = new Set(this.countryFilterCodes);
      return this.accounts.filter(a => {
        if (countryOn && !this.countryColumns.some(c => countrySet.has(a.extra?.[c.id]))) return false;
        if (f.group === 'none' ? (a.group_id && this.groupMap[a.group_id]) : (f.group && a.group_id !== f.group)) return false;
        if (f.status && a.status !== f.status) return false;
        if (f.domain && domainOf(a.email) !== f.domain) return false;
        if (f.twofa && (f.twofa === 'yes') !== !!a.totp_secret) return false;
        if (f.recovery && (f.recovery === 'yes') !== !!a.recovery_email) return false;
        return match(a);
      });
    },

    sorted() { return this.sortList(this.filtered); },

    pageCount() { return Math.max(1, Math.ceil(this.sorted.length / this.pageSize)); },
    paged() { return this.sorted.slice((this.page - 1) * this.pageSize, this.page * this.pageSize); },
    pageInfo() {
      const total = this.sorted.length;
      if (!total) return t('filter.total', { n: 0 });
      return t('pager.info', { from: (this.page - 1) * this.pageSize + 1, to: Math.min(total, this.page * this.pageSize), total });
    },
    pageButtons() {
      const n = this.pageCount, p = this.page;
      if (n <= 9) return Array.from({ length: n }, (_, i) => i + 1);
      const set = new Set([1, n, p - 2, p - 1, p, p + 1, p + 2].filter(x => x >= 1 && x <= n));
      const list = [...set].sort((a, b) => a - b);
      const out = [];
      list.forEach((x, i) => { if (i && x - list[i - 1] > 1) out.push('…'); out.push(x); });
      return out;
    },
    // 只算當前篩選結果裡被勾選的，避免批量操作誤傷被篩選隱藏的行
    selectedIds() { return this.filtered.filter(a => this.selected[a.id]).map(a => a.id); },
    allPageSelected() { return this.paged.length > 0 && this.paged.every(a => this.selected[a.id]); },
    // 收件箱頂部顯示的「最新驗證碼」：最新一封帶驗證碼的郵件
    latestCode() {
      const msg = this.inbox?.messages.find(m => m.codes.length);
      return msg ? { msg, code: msg.codes[0] } : null;
    },
    exportScope() {
      return this.selectedIds.length ? t('export.scopeSelected', { n: this.selectedIds.length }) : t('export.scopeShown', { n: this.filtered.length });
    },
  },

  watch: {
    filters: { deep: true, handler(v) { this.page = 1; this.prefs.filters = { ...v }; } },
    search() { this.page = 1; },
    sort: { deep: true, handler(v) { this.prefs.sort = { ...v }; } },
    page(v) { this.prefs.page = v; },
    pageSize(v) { this.page = 1; this.prefs.pageSize = v; },
    pageCount(v) { if (this.page > v) this.page = v; },
    sheetId(v) { this.prefs.sheetId = v; },
    'edit.totp_secret'(v) { this.refreshEditCode(v); },
    impFailedKey(v) { if (v && this.imp?.ai.ready) this.scheduleAutoAi(); },
    'prefs.lang': { immediate: true, handler(v) {
      ui.lang = v;
      document.documentElement.lang = v;
      document.title = t('app.title');
      call('set_window_title', t('app.title')).catch(() => {});
    } },
    isDark: { immediate: true, handler(v) { document.documentElement.dataset.theme = v ? 'dark' : 'light'; } },
    prefs: { deep: true, handler() { this.savePrefs(); } },
  },

  async mounted() {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => { this.systemDark = e.matches; });
    this.meta = await call('get_meta');
    const saved = await call('get_prefs');
    this.prefs = { ...JSON.parse(JSON.stringify(DEFAULT_PREFS)), ...saved };
    this.prefs.visible = { ...DEFAULT_VISIBLE, ...this.prefs.visible };
    const p = this.prefs;
    this.pageSize = [20, 50, 100, 200].includes(p.pageSize) ? p.pageSize : 20;
    this.sheetId = p.sheetId;
    this.filters = { ...DEFAULT_FILTERS, ...p.filters };
    this.sort = { key: '', dir: 1, ...p.sort };
    this._restore = { page: p.page || 1, scroll: p.scroll || 0 };  // 解鎖後恢復上次的頁碼和滾動位置

    Object.assign(this.lock, await call('get_lock_state'));
    this.ready = true;
    if (this.lock.unlocked) await this.reload(); else this.focusLock();

    this._lastActive = Date.now();
    for (const ev of ['mousemove', 'mousedown', 'keydown', 'wheel']) window.addEventListener(ev, () => { this._lastActive = Date.now(); }, { passive: true });
    setInterval(() => {
      this.now = Math.floor(Date.now() / 1000);
      if (!this.lock.unlocked) return;
      if (this.prefs.autoLock && Date.now() - this._lastActive > this.prefs.autoLock * 60000) return this.lockNow();
      const w = Math.floor(this.now / 30);
      if (w !== this.lastWindow) { this.lastWindow = w; this.refreshCodes(); if (this.edit) this.refreshEditCode(this.edit.totp_secret); }
    }, 1000);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('mousedown', e => { if (this.pop && this.$refs.popEl && !this.$refs.popEl.contains(e.target)) this.pop = null; });
    window.addEventListener('resize', () => { this.pop = null; });
  },

  methods: {
    t, flag, countryName,

    // ---------- 偏好 ----------
    savePrefs() {
      clearTimeout(this._prefTimer);
      this._prefTimer = setTimeout(() => call('set_prefs', JSON.parse(JSON.stringify(this.prefs))).catch(() => {}), 400);
    },
    toggleTheme() { this.prefs.theme = this.isDark ? 'light' : 'dark'; },
    onTableScroll(e) {
      this.pop = null;
      clearTimeout(this._scrollTimer);
      const top = e.target.scrollTop;
      this._scrollTimer = setTimeout(() => { this.prefs.scroll = top; }, 300);
    },

    // ---------- 主密碼 / 鎖定 ----------
    focusLock() { nextTick(() => this.$refs.lockInput?.focus()); },
    async submitLock() {
      const f = this.lockForm;
      f.err = '';
      if (!this.lock.has_password) {
        if (f.pw.length < 4) return (f.err = t('err.pw_short'));
        if (f.pw !== f.pw2) return (f.err = t('err.pw_mismatch'));
      }
      f.busy = true;
      try {
        await call(this.lock.has_password ? 'unlock' : 'setup_password', f.pw);
      } catch (e) {
        f.err = errText(e);
        f.busy = false;
        return this.focusLock();
      }
      this.lockForm = { pw: '', pw2: '', err: '', busy: false };
      Object.assign(this.lock, { has_password: true, unlocked: true });
      this._lastActive = Date.now();
      await this.reload();
    },
    async lockNow() {
      this._restore = { page: this.page, scroll: this.$refs.tableWrap?.scrollTop || 0 };
      this.closeInbox();
      this.agentClear();  // 對話裡有郵箱數據
      this.agent.open = false;
      await call('lock');
      // 清掉內存裡的明文
      Object.assign(this, { accounts: [], codes: {}, selected: {}, revealed: {}, edit: null, editCode: '', imp: null,
        groupEdit: null, colEdit: null, settings: null, pop: null, bulkCol: null, exportMenu: false, search: '', mailCfg: null });
      if (this.dialog) this.dialog.resolve(null);
      this.lock.unlocked = false;
      this.focusLock();
    },
    async openSettings() {
      this.settings = { old: '', pw: '', pw2: '', err: '', busy: false, mail: null, ai: null,
        adminTesting: false, adminMsg: '', adminOk: false,
        aiTesting: false, aiMsg: '', aiOk: false };
      const [mail, ai] = await Promise.all([call('get_mail_config'), call('get_ai_config')]);
      if (!this.settings) return;
      this.settings.mail = { ...mail, admin_password: '' };
      this.settings.ai = { ...ai, api_key: '' };
    },
    aiConfigPayload() {
      const { has_api_key, default_prompt, ...cfg } = this.settings.ai;
      cfg.api_key = cfg.api_key ? cfg.api_key : (has_api_key ? null : '');  // 留空 = 保持原 Key
      return cfg;
    },
    applyAiPreset(p) { Object.assign(this.settings.ai, { base_url: p.base_url, model: p.model }); },
    async testAi() {
      const s = this.settings;
      s.aiTesting = true; s.aiMsg = '';
      try {
        const r = await call('test_ai', this.aiConfigPayload());
        s.aiOk = true; s.aiMsg = t('ai.testOk', { s: r.reply || '—' });
      } catch (e) { s.aiOk = false; s.aiMsg = errText(e); }
      s.aiTesting = false;
    },
    mailConfigPayload() {
      const m = this.settings.mail;
      const { has_admin_password, ...cfg } = m;
      // 密碼框為空：有舊密碼就保持（null），否則清除（''）
      cfg.admin_password = m.admin_password ? m.admin_password : (has_admin_password ? null : '');
      return cfg;
    },
    async testAdmin() {
      const s = this.settings;
      s.adminTesting = true; s.adminMsg = '';
      try {
        const r = await call('test_billionmail_admin', this.mailConfigPayload());
        s.adminOk = true; s.adminMsg = t('admin.testOk', { n: r.total, d: r.domains.join('、') || '—' });
      } catch (e) { s.adminOk = false; s.adminMsg = errText(e); }
      s.adminTesting = false;
    },
    async saveSettings() {
      const s = this.settings;
      s.err = '';
      if (s.mail) {
        await call('set_mail_config', this.mailConfigPayload());
        this.mailCfg = await call('get_mail_config');
        this.loadSelfDomains();
      }
      if (s.ai) await call('set_ai_config', this.aiConfigPayload());
      if (s.old || s.pw || s.pw2) {
        if (s.pw.length < 4) return (s.err = t('err.pw_short'));
        if (s.pw !== s.pw2) return (s.err = t('err.pw_mismatch'));
        s.busy = true;
        try { await call('change_password', s.old, s.pw); }
        catch (e) { s.busy = false; return (s.err = errText(e)); }
        this.toast(t('settings.pwChanged'));
      }
      this.settings = null;
    },

    // ---------- 自動創建自建郵箱（BillionMail 管理員模式） ----------
    // 自建域名（來自 BillionMail 後台）：先用上次緩存的立即顯示，再連後台刷新；後台連不上也不影響
    loadSelfDomains() {
      const cfg = this.mailCfg;
      if (!cfg?.panel_url) { this.selfDomains = []; return; }
      const apply = r => { if (this.mailCfg === cfg && r.domains.length) this.selfDomains = r.domains; };
      call('selfmail_domains', false).then(apply).catch(() => {});
      call('selfmail_domains', true).then(apply).catch(() => {});
    },
    // 編輯窗口：輔助郵箱類型選「自建 @域名」→ 用主郵箱的用戶名創建郵箱，隨機密碼，自動填入
    async onRecType() {
      const domain = this.recType;
      const edit = this.edit;
      if (!domain || !edit) return;
      if (!this.validEmail(edit.email)) {
        this.recType = '';
        return this.toast(t('selfmail.needEmail'), 'error');
      }
      this.recBusy = true;
      try {
        const r = await call('create_self_mailbox', edit.email.trim(), domain);
        edit.recovery_email = r.address;
        edit.recovery_password = r.password;
        // 已有的賬號立即保存，避免取消編輯後郵箱已建好但密碼沒記下
        if (edit.id) {
          await call('update_fields', [{ id: edit.id, fields: { recovery_email: r.address, recovery_password: r.password } }]);
          await this.loadAccounts();
        }
        this.toast(t('selfmail.created', { address: r.address }));
      } catch (e) {
        this.recType = '';
        this.toast(errText(e), 'error');
      }
      this.recBusy = false;
    },
    async bulkCreateRecovery(e) {
      const domain = e.target.value;
      e.target.value = '';
      if (!domain) return;
      const ids = this.selectedIds;
      const ok = await this.confirm(t('selfmail.bulkTitle'), t('selfmail.bulkConfirm', { n: ids.length, domain }), t('btn.ok'), false);
      if (!ok) return;
      this.toast(t('selfmail.creating'));
      try {
        const r = await call('create_recovery_mailboxes', ids, domain);
        await this.loadAccounts();
        this.toast(t('selfmail.bulkDone', { n: r.created.length, s: r.skipped, f: r.failed.length }), r.failed.length ? 'error' : 'ok');
      } catch (err) { this.toast(errText(err), 'error'); }
    },

    // ---------- 郵箱收件箱（自建 BillionMail / 微軟 Outlook） ----------
    mailEligible(a, which) {
      const address = which === 'email' ? a.email : a.recovery_email;
      if (!address) return false;
      const password = which === 'email' ? a.password : a.recovery_password;
      if (isMicrosoft(address)) return !!(a.oauth_token || password);  // 帶令牌或帶密碼都可嘗試
      // 自建郵箱：BillionMail 後台裡的域名才能收信（密碼由管理員自動取回）
      return !!this.mailCfg?.panel_url && this.selfDomains.includes(domainOf(address));
    },
    openInbox(a, which) {
      this.closeInbox();
      this.inbox = { account: a, which, address: which === 'email' ? a.email : a.recovery_email, messages: [], loading: false,
        error: '', updated: 0, open: {}, html: {}, fresh: {}, seen: null, total: 0, totals: {} };
      this.fetchInbox();
      this.restartInboxTimer();
    },
    loadMoreMail(all) { this.fetchInbox(all ? 0 : this.inbox.messages.length + INBOX_MORE); },
    restartInboxTimer() {
      clearInterval(this._inboxTimer);
      if (this.inbox && this.prefs.mailAuto) this._inboxTimer = setInterval(() => this.fetchInbox(), 5000);
    },
    closeInbox() {
      clearInterval(this._inboxTimer);
      this.inbox = null;
    },
    // limit 不傳：取最新的一批，合併進已加載的列表（自動刷新用）；傳了（加載更多 / 0 = 全部）：整個替換
    async fetchInbox(limit) {
      const box = this.inbox;
      if (!box || box.loading) return;
      box.loading = true;
      const more = limit !== undefined;
      try {
        const r = await call('fetch_mail', box.account.id, box.which, more ? limit : INBOX_PAGE);
        if (this.inbox !== box) return;
        // 自動刷新時發現新郵件：高亮，帶驗證碼的提示（可自動複製）。加載更早的郵件不算新郵件
        if (box.seen && !more) {
          const fresh = r.messages.filter(m => !box.seen.has(m.id));
          for (const m of fresh) box.fresh[m.id] = true;
          const withCode = fresh.find(m => m.codes.length);
          if (withCode) {
            if (this.prefs.mailAutoCopy) this.copy(withCode.codes[0], t('copy.code'));
            else this.toast(t('mail.newCode', { code: withCode.codes[0] }));
          }
        }
        box.seen = new Set([...(box.seen || []), ...r.messages.map(m => m.id)]);
        if (more) box.messages = r.messages;
        else {
          const byId = new Map(box.messages.map(m => [m.id, m]));
          for (const m of r.messages) byId.set(m.id, m);
          box.messages = [...byId.values()].sort((x, y) => y.date - x.date);
        }
        box.total = r.total ?? box.messages.length;
        box.totals = r.totals || {};
        box.error = '';
      } catch (e) {
        if (this.inbox === box) box.error = errText(e);
        // 出錯就停止自動刷新：反覆用錯誤密碼登錄會被 BillionMail 的 fail2ban 封 IP
        clearInterval(this._inboxTimer);
      } finally {
        box.loading = false;
        box.updated = Date.now();
      }
    },
    // 郵件 HTML 放進無腳本的沙箱 iframe，並禁止加載任何外部資源（防追蹤）
    safeHtml(raw) {
      return '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:">' +
        '<base target="_blank"><style>body{font:13px/1.5 sans-serif;margin:8px;color:#1c2230;background:#fff}</style>' + raw;
    },
    timeAgo(ts) {
      if (!ts) return '';
      const s = Math.floor(Date.now() / 1000) - ts;
      if (s < 60) return t('time.now');
      if (s < 3600) return t('time.min', { n: Math.floor(s / 60) });
      if (s < 86400) return t('time.hour', { n: Math.floor(s / 3600) });
      return this.fmtDate(ts);
    },
    fmtTime(ms) {
      const d = new Date(ms), p = n => String(n).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    },

    // ---------- 數據加載 ----------
    async reload() {
      call('get_mail_config').then(c => { this.mailCfg = c; this.loadSelfDomains(); }).catch(() => {});
      const st = await call('get_state');
      this.sheets = st.sheets;
      this.groups = st.groups;
      if (!this.sheets.some(s => s.id === this.sheetId)) this.sheetId = this.sheets[0]?.id;
      if (typeof this.filters.group === 'number' && !this.groupMap[this.filters.group]) this.filters.group = '';
      await this.loadAccounts();
      if (this._restore) {
        const r = this._restore;
        this._restore = null;
        await nextTick();  // 讓篩選條件的 watcher 先跑完（它會把頁碼重置為 1）
        this.page = Math.min(r.page, this.pageCount);
        await nextTick();
        if (this.$refs.tableWrap) this.$refs.tableWrap.scrollTop = r.scroll;
      }
    },
    async loadAccounts() {
      this.accounts = await call('list_accounts', this.sheetId);
      const ids = new Set(this.accounts.map(a => a.id));
      for (const k of Object.keys(this.selected)) if (!ids.has(+k)) delete this.selected[k];
      await this.refreshCodes();
    },
    async refreshState() {
      const st = await call('get_state');
      this.sheets = st.sheets;
      this.groups = st.groups;
    },
    async refreshCodes() {
      const secrets = [...new Set(this.accounts.map(a => a.totp_secret).filter(Boolean))];
      this.codes = secrets.length ? await call('totp_codes', secrets) : {};
    },
    refreshEditCode(secret) {
      clearTimeout(this._editTimer);
      if (!secret) { this.editCode = ''; return; }
      this._editTimer = setTimeout(async () => {
        const r = await call('totp_codes', [secret]);
        this.editCode = r[secret] || '';
      }, 250);
    },
    // 搜索框的匹配規則：忽略符號；全部是郵箱 → 批量查找（任意一個匹配）；否則所有關鍵詞都要匹配
    searchMatcher(search) {
      const tokens = (search || '').toLowerCase().split(/[\s,;，；]+/).filter(Boolean).map(raw => ({ raw, norm: normalize(raw) }));
      if (!tokens.length) return () => true;
      const bulk = tokens.length > 1 && tokens.every(tk => tk.raw.includes('@'));
      return a => {
        const fields = this.searchFields(a);
        const hay = fields.join('\n').toLowerCase();
        const normHay = fields.map(normalize).join('\n');
        const hit = tk => hay.includes(tk.raw) || (tk.norm && normHay.includes(tk.norm));
        return bulk ? tokens.some(hit) : tokens.every(hit);
      };
    },
    // 按表頭當前的排序規則排序
    sortList(list) {
      const { key, dir } = this.sort;
      if (!key) return list;
      const val = a => {
        if (key === 'group') return this.groupMap[a.group_id]?.name || '';
        if (key === 'updated') return a.updated_at;
        if (key === 'status') return this.statusIndex(a.status);
        if (key.startsWith('x_')) return String(a.extra[key.slice(2)] || '').toLowerCase();
        return (a[key] || '').toLowerCase();
      };
      return [...list].sort((x, y) => {
        const a = val(x), b = val(y);
        return (a < b ? -1 : a > b ? 1 : 0) * dir;
      });
    },
    searchFields(a) {
      const out = [a.email, a.recovery_email, a.phone, a.notes, this.groupMap[a.group_id]?.name || '', this.statusLabel(a.status)];
      for (const col of this.currentSheet.columns) {
        const v = a.extra?.[col.id];
        if (!v || col.type === 'image' || col.type === 'color') continue;
        if (col.type === 'country') out.push(v, COUNTRY_DATA.find(c => c.code === v)?.a3 || '', countryName(v), countryName(v, 'en'));
        else out.push(String(v));
      }
      return out;
    },

    // ---------- 顯示輔助 ----------
    sheetName(s) { return s.name === '默認列表' ? t('sheet.default') : s.name; },
    statusIndex(s) { return this.meta.statuses.indexOf(s); },
    statusLabel(s) { const i = this.statusIndex(s); return i >= 0 ? t('status.' + i) : s; },
    tagStyle(color) { return { color, background: color + '1f', borderColor: color + '55' }; },
    randomColor() { return COLOR_MARKS[Math.floor(Math.random() * COLOR_MARKS.length)]; },
    fmtCode(c) { return c && /^\d{6}$/.test(c) ? c.slice(0, 3) + ' ' + c.slice(3) : (c === '密鑰無效' ? '—' : (c || '…')); },
    fmtDate(ts) {
      if (!ts) return '';
      const d = new Date(ts * 1000), p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    },

    // ---------- 列表 ----------
    selectSheet(id) {
      if (id === this.sheetId) return;
      this.sheetId = id;
      this.selected = {};
      this.page = 1;
      this.pop = null;
      this.loadAccounts().then(() => { if (this.$refs.tableWrap) this.$refs.tableWrap.scrollTop = 0; });
    },
    async addSheet() {
      const name = await this.prompt(t('sheet.add'), t('sheet.namePrompt'), t('sheet.newName'));
      if (!name) return;
      const id = await call('add_sheet', name);
      await this.refreshState();
      this.selectSheet(id);
    },
    async renameSheet(s) {
      const name = await this.prompt(t('sheet.rename'), '', this.sheetName(s));
      if (!name || name === this.sheetName(s)) return;
      await call('rename_sheet', s.id, name);
      await this.refreshState();
    },
    async deleteSheet(s) {
      if (this.sheets.length <= 1) return this.toast(t('err.keep_one_sheet'), 'error');
      if (!(await this.confirm(t('sheet.delete'), t('sheet.deleteConfirm', { name: this.sheetName(s), n: s.count })))) return;
      await call('delete_sheet', s.id);
      await this.reload();
      this.toast(t('sheet.deleted'));
    },

    // ---------- 分組 ----------
    openGroups() { this.groupEdit = this.groups.map(g => ({ ...g })); this._removedGroups = []; },
    removeGroup(g) {
      if (g.id) this._removedGroups.push(g.id);
      this.groupEdit.splice(this.groupEdit.indexOf(g), 1);
    },
    async saveGroups() {
      for (const id of this._removedGroups) await call('delete_group', id);
      for (const g of this.groupEdit) {
        if (!g.name.trim()) continue;
        if (g.id) await call('update_group', g.id, g.name, g.color);
        else await call('add_group', g.name, g.color);
      }
      if (this._removedGroups.includes(this.filters.group)) this.filters.group = '';
      this.groupEdit = null;
      await this.refreshState();
      await this.loadAccounts();
      this.toast(t('group.saved'));
    },

    // ---------- 列設置 / 列順序 / 列寬 ----------
    // 自定義列默認顯示（visible 裡沒有記錄 = 顯示），郵箱列總是顯示
    isColumnVisible(key) {
      if (key === 'email') return true;
      return key.startsWith('x_') ? this.prefs.visible[key] !== false : !!this.prefs.visible[key];
    },
    colWidth(c) {
      const w = this.prefs.colWidths?.[c.key];
      if (w) return w;
      return c.custom ? (DEFAULT_CUSTOM_WIDTHS[c.col.type] || 120) : (DEFAULT_WIDTHS[c.key] || 120);
    },
    saveColumnOrder(keys) {
      this.prefs.colOrders = { ...this.prefs.colOrders, [this.sheetId]: keys, _default: keys };
    },
    startResize(c, e) {
      const th = e.target.closest('th');
      const startX = e.clientX, startW = th.offsetWidth;
      this._resizing = true;
      document.body.classList.add('col-resizing');
      const move = ev => {
        this.prefs.colWidths = { ...this.prefs.colWidths, [c.key]: Math.max(MIN_COL_WIDTH, Math.round(startW + ev.clientX - startX)) };
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        document.body.classList.remove('col-resizing');
        setTimeout(() => { this._resizing = false; });  // 鬆開鼠標時的 click 不觸發排序
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    },
    resetWidth(c) {
      const { [c.key]: _, ...rest } = this.prefs.colWidths || {};
      this.prefs.colWidths = rest;
    },
    onHeaderClick(c) {
      if (this._resizing || !c.sort) return;
      this.toggleSort(c.key);
    },
    // 拖動表頭調整列順序
    onColDragStart(c, e) {
      this.dragCol = c.key;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', c.key);
    },
    onColDragOver(c, e) {
      if (!this.dragCol) return;
      e.preventDefault();
      this.dragOver = c.key === this.dragCol ? '' : c.key;
    },
    onColDrop(c) {
      const from = this.dragCol;
      this.dragCol = this.dragOver = '';
      if (!from || from === c.key) return;
      const keys = this.allColumns.map(x => x.key).filter(k => k !== from);
      // 往右拖放在目標後面，往左拖放在目標前面
      const before = this.allColumns.findIndex(x => x.key === from) > this.allColumns.findIndex(x => x.key === c.key);
      keys.splice(keys.indexOf(c.key) + (before ? 0 : 1), 0, from);
      this.saveColumnOrder(keys);
    },
    onColDragEnd() { this.dragCol = this.dragOver = ''; },

    openColumns() {
      this.colEdit = {
        items: this.allColumns.map(c => ({
          key: c.key, label: c.label, visible: this.isColumnVisible(c.key),
          col: c.custom ? { ...c.col } : null,
        })),
      };
    },
    moveColumn(i, d) {
      const list = this.colEdit.items;
      [list[i], list[i + d]] = [list[i + d], list[i]];
    },
    addCustomColumn() {
      const id = 'c' + Date.now().toString(36);
      this.colEdit.items.push({ key: 'x_' + id, visible: true, col: { id, name: '', type: 'text' } });
    },
    resetColumnOrder() {
      const rank = k => { const i = this.defaultColumns.findIndex(c => c.key === k); return i < 0 ? 1e9 : i; };
      this.colEdit.items.sort((a, b) => rank(a.key) - rank(b.key));
    },
    resetWidths() {
      this.prefs.colWidths = {};
      this.toast(t('columns.widthReset'));
    },
    async saveColumns() {
      const items = this.colEdit.items.filter(it => !it.col || it.col.name.trim());
      const visible = { ...this.prefs.visible };
      for (const it of items) visible[it.key] = it.key === 'email' || it.visible;
      this.prefs.visible = visible;
      const custom = items.filter(it => it.col).map(it => ({ ...it.col, name: it.col.name.trim() }));
      await call('set_sheet_columns', this.sheetId, custom);
      this.saveColumnOrder(items.map(it => it.key));
      this.colEdit = null;
      await this.refreshState();
      this.toast(t('columns.saved'));
    },

    // ---------- 自定義列：點擊單元格 ----------
    onCustomCell(a, col, e) {
      if (col.type === 'text') return this.copy(a.extra[col.id]);
      const r = e.currentTarget.getBoundingClientRect();
      const w = 300, h = col.type === 'country' ? 310 : 230;
      const x = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      const y = r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4;
      this.pop = { account: a, col, x, y };
    },
    onPopInput(v) {
      const { account: a, col } = this.pop;
      if (v) a.extra[col.id] = v; else delete a.extra[col.id];
      call('set_extra', [a.id], col.id, v || null).catch(e => this.toast(errText(e), 'error'));
    },
    openBulkColumn(e) {
      const col = this.currentSheet.columns.find(c => c.id === e.target.value);
      e.target.value = '';
      if (col) this.bulkCol = { col, value: '' };
    },
    async applyBulkColumn() {
      const { col, value } = this.bulkCol;
      const n = this.selectedIds.length;
      await call('set_extra', this.selectedIds, col.id, value || null);
      this.bulkCol = null;
      await this.loadAccounts();
      this.toast(t('bulk.columnDone', { n }));
    },

    // ---------- 新增 / 編輯 ----------
    openEdit(a, focus) {
      this.pop = null;
      this.recType = '';
      this.edit = a
        ? { ...a, extra: { ...a.extra } }
        : { sheet_id: this.sheetId, email: '', password: '', totp_secret: '', recovery_email: '', recovery_password: '',
            oauth_client_id: '', oauth_token: '', phone: '', notes: '',
            status: this.meta.statuses[0], group_id: typeof this.filters.group === 'number' ? this.filters.group : null, extra: {} };
      this.refreshEditCode(this.edit.totp_secret);
      nextTick(() => (focus === 'notes' ? this.$refs.editNotes : this.$refs.editFirst)?.focus());
    },
    async saveEdit() {
      if (!this.edit.email.trim()) return this.toast(t('edit.needEmail'), 'error');
      const isNew = !this.edit.id;
      const data = JSON.parse(JSON.stringify(this.edit));
      for (const k of Object.keys(data.extra)) if (!data.extra[k]) delete data.extra[k];
      try { await call('save_account', data); }
      catch (e) { return this.toast(t('edit.saveFailed') + errText(e), 'error'); }
      this.edit = null;
      await this.loadAccounts();
      if (isNew) await this.refreshState();
      this.toast(isNew ? t('edit.added') : t('edit.saved'));
    },
    async deleteOne(a) {
      if (!(await this.confirm(t('edit.deleteTitle'), t('edit.deleteConfirm', { email: a.email })))) return;
      await call('delete_accounts', [a.id]);
      await this.afterBulk(t('edit.deleted'));
    },
    genPassword() {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
      const buf = new Uint32Array(14);
      crypto.getRandomValues(buf);
      return Array.from(buf, n => chars[n % chars.length]).join('');
    },

    // ---------- 批量操作 ----------
    togglePage(e) { for (const a of this.paged) this.selected[a.id] = e.target.checked; },
    async bulkGroup(e) {
      const v = e.target.value; e.target.value = '';
      if (!v) return;
      await call('set_group', this.selectedIds, v === 'none' ? null : Number(v));
      await this.afterBulk(t('bulk.groupDone'), false);
    },
    async bulkStatus(e) {
      const v = e.target.value; e.target.value = '';
      if (!v) return;
      await call('set_status', this.selectedIds, v);
      await this.afterBulk(t('bulk.statusDone'), false);
    },
    async bulkMove(e) {
      const v = e.target.value; e.target.value = '';
      if (!v) return;
      await call('move_accounts', this.selectedIds, Number(v));
      await this.afterBulk(t('bulk.moved'));
    },
    async bulkDelete() {
      const n = this.selectedIds.length;
      if (!(await this.confirm(t('bulk.deleteTitle'), t('bulk.deleteConfirm', { n })))) return;
      await call('delete_accounts', this.selectedIds);
      await this.afterBulk(t('bulk.deleted', { n }));
    },
    async afterBulk(msg, clear = true) {
      if (clear) this.selected = {};
      await this.loadAccounts();
      await this.refreshState();
      this.toast(msg);
    },
    copySelected() {
      const set = new Set(this.selectedIds);
      this.copy(this.sorted.filter(a => set.has(a.id)).map(rowText).join('\n'), t('copy.rows', { n: set.size }));
    },

    // ---------- 導入 / 導出 ----------
    async openImport() {
      const order = [...this.prefs.importOrder];
      while (order.length < 6) order.push('skip');
      this.imp = { text: '', sep: 'auto', mode: this.prefs.importMode === 'manual' ? 'manual' : 'smart', order,
        group_id: typeof this.filters.group === 'number' ? this.filters.group : null, status: this.meta.statuses[0], skipDup: true,
        extra: {}, keepPartial: false, showFailed: false,
        // AI 糾錯：results 按原始行緩存結果（改了文本也不用重新請求），tried 記錄已經發給 AI 的行
        ai: { ready: false, results: {}, tried: {}, running: false, stop: false, error: '', text: '', showRaw: false, total: 0, got: 0 } };
      const imp = this.imp;
      try { imp.ai.ready = aiConfigured(await call('get_ai_config')); } catch { /* 未配置 */ }
      if (imp.ai.ready) this.scheduleAutoAi();
    },
    closeImport() {
      this.stopAiFix();
      this.imp = null;
    },
    applyPreset(order) {
      const o = [...order];
      while (o.length < 6) o.push('skip');
      this.imp.order = o;
      this.imp.mode = 'manual';
    },
    importReason(f) { return t(f.reason[0], f.reason[1]); },
    validEmail(s) { return EMAIL_RE.test((s || '').trim()); },

    // ---------- AI 糾錯：配置了 AI 時，無法識別的行自動交給 AI，流式顯示結果，人工核對後一併導入 ----------
    scheduleAutoAi() {
      clearTimeout(this._aiAutoTimer);
      this._aiAutoTimer = setTimeout(() => this.runAiFix(false), 900);  // 等粘貼/輸入停下來
    },
    async runAiFix(manual) {
      const imp = this.imp;
      if (!imp) return;
      const ai = imp.ai;
      if (!ai.ready) {
        if (manual) this.toast(t('import.aiNoConfig'), 'error');
        return;
      }
      if (ai.running) return;
      if (manual) for (const f of this.impParsed.failed) { delete ai.results[f.raw]; delete ai.tried[f.raw]; }
      // 每次最多發 100 行，剩下的這一批完成後接著發
      const lines = this.impParsed.failed.map(f => f.raw).filter(raw => !ai.tried[raw]).slice(0, 100);
      if (!lines.length) return;
      for (const raw of lines) ai.tried[raw] = true;
      Object.assign(ai, { running: true, stop: false, error: '', text: '', total: lines.length, got: 0 });
      let parsed = 0;
      try {
        const job = await call('ai_fix_start', lines);
        await pollAiJob(job, delta => {
          ai.text += delta;
          for (const obj of parseAiLines(ai.text).slice(parsed)) {
            parsed++;
            const raw = lines[(parseInt(obj.line, 10) || 0) - 1];
            if (raw === undefined) continue;
            const row = aiRowToImport(obj);
            const ok = obj.ok !== false && EMAIL_RE.test(row.email || '');
            ai.results[raw] = { raw, row, ok, reason: obj.reason || '', checked: ok };
            ai.got++;
          }
        }, () => this.imp !== imp || ai.stop);
      } catch (e) {
        ai.error = errText(e);
      }
      const stopped = ai.stop;
      ai.running = false;
      ai.stop = false;
      if (!ai.error && !parsed && !stopped) ai.error = t('import.aiEmpty');
      // 這一批完成後還有新出現的無法識別行（用戶又粘貼了內容）就繼續
      if (this.imp === imp && !ai.error && !stopped) this.runAiFix(false);
    },
    stopAiFix() {
      const ai = this.imp?.ai;
      if (ai?.running) ai.stop = true;
    },
    setAllAi(checked) { for (const r of this.impAiRows) r.checked = checked; },

    async doImport() {
      const i = this.imp;
      this.prefs.importMode = i.mode;
      if (i.mode === 'manual') this.prefs.importOrder = [...i.order];
      // AI 結果裡手動改過的地區代碼可能無效，無效的放進備註
      let rows = this.impRows.map(({ country, ...r }) => {
        const code = (country || '').trim().toUpperCase();
        if (COUNTRY_CODES.includes(code)) r.country = code;
        else if (code) r.notes = [r.notes, country].filter(Boolean).join(' ');
        return r;
      });
      // 帶國家/地區的行：寫進「國家/地區」類型的自定義列，沒有就自動新增一個
      if (rows.some(r => r.country)) {
        let col = this.countryColumns[0];
        if (!col) {
          col = { id: 'c' + Date.now().toString(36), name: t('type.country'), type: 'country' };
          await call('set_sheet_columns', this.sheetId, [...this.currentSheet.columns, col]);
        }
        rows = rows.map(({ country, ...r }) => (country ? { ...r, extra: { [col.id]: country } } : r));
      }
      const extra = Object.fromEntries(Object.entries(i.extra).filter(([, v]) => v));
      const r = await call('import_rows', this.sheetId, rows, i.group_id, i.status, i.skipDup, extra);
      this.closeImport();
      await this.loadAccounts();
      await this.refreshState();
      this.toast(r.skipped ? t('import.doneSkip', { n: r.added, m: r.skipped }) : t('import.done', { n: r.added }));
    },
    // 導入窗口裡一鍵加一個「顏色標記」列
    async addColorColumn() {
      const cols = [...this.currentSheet.columns, { id: 'c' + Date.now().toString(36), name: t('type.color'), type: 'color' }];
      await call('set_sheet_columns', this.sheetId, cols);
      await this.refreshState();
    },
    buildExport(rows, fmt) {
      if (fmt === 'txt') return rows.map(rowText).join('\n');
      const cols = this.currentSheet.columns.filter(c => c.type !== 'image');
      const esc = v => { v = String(v ?? ''); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      const head = [...this.meta.fields.map(f => t('col.' + f)), t('col.group'), t('col.status'), ...cols.map(c => c.name)];
      const lines = rows.map(a => [...this.meta.fields.map(f => a[f]), this.groupMap[a.group_id]?.name || '', this.statusLabel(a.status),
        ...cols.map(c => a.extra[c.id] || '')]);
      return '﻿' + [head, ...lines].map(r => r.map(esc).join(',')).join('\r\n');  // BOM 讓 Excel 正確識別 UTF-8
    },
    async doExport(fmt, only = null) {
      this.exportMenu = false;
      const set = new Set(this.selectedIds);
      const rows = only || (set.size ? this.sorted.filter(a => set.has(a.id)) : this.sorted);
      const d = new Date(), p = n => String(n).padStart(2, '0');
      const name = `mail_export_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${fmt}`;
      const content = this.buildExport(rows, fmt);
      try {
        const r = await call('save_export', name, content);
        if (r === null) {  // 開發模式：瀏覽器下載
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
          a.download = name; a.click();
        } else if (!r.cancelled) {
          this.toast(t('export.done', { n: rows.length, path: r.path }));
        }
      } catch (e) { this.toast(t('export.failed') + errText(e), 'error'); }
    },

    // ---------- 篩選 / 排序 / 翻頁 ----------
    resetFilters() { this.filters = { ...DEFAULT_FILTERS }; this.search = ''; },
    toggleSort(key) {
      if (this.sort.key !== key) this.sort = { key, dir: 1 };
      else if (this.sort.dir === 1) this.sort.dir = -1;
      else this.sort = { key: '', dir: 1 };
    },
    gotoPage(e) {
      const n = parseInt(e.target.value, 10);
      if (n >= 1) this.page = Math.min(n, this.pageCount);
      e.target.value = this.page;
    },

    // ---------- 複製 ----------
    async copy(text, label, secret) {
      if (!text) return;
      try { await navigator.clipboard.writeText(text); }
      catch {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      }
      const show = !secret && text.length < 60 && !text.includes('\n');
      this.toast(t('copy.done') + (label ? ' ' + label : '') + (show ? '：' + text : ''));
    },
    copyRow(a) { this.copy(rowText(a), t('copy.row'), true); },

    // ---------- 對話框 / 提示 ----------
    prompt(title, message, value = '') {
      return new Promise(resolve => {
        this.dialog = { title, message, input: true, value, resolve: v => { this.dialog = null; resolve(v && String(v).trim()); } };
        nextTick(() => { this.$refs.dialogInput?.focus(); this.$refs.dialogInput?.select(); });
      });
    },
    confirm(title, message, ok = t('btn.delete'), danger = true) {
      return new Promise(resolve => {
        this.dialog = { title, message, danger, ok, resolve: v => { this.dialog = null; resolve(!!v); } };
      });
    },
    toast(text, type = 'ok') {
      if (this.toasts.some(x => x.text === text)) return;
      const id = Date.now() + Math.random();
      this.toasts.push({ id, text, type });
      setTimeout(() => { this.toasts = this.toasts.filter(x => x.id !== id); }, type === 'error' ? 4000 : 2200);
    },
    onKey(e) {
      if (!this.lock.unlocked) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') {
        if (this.dialog) this.dialog.resolve(null);
        else if (this.pop) this.pop = null;
        else if (this.inbox) this.closeInbox();
        else if (this.bulkCol) this.bulkCol = null;
        else if (this.edit) this.edit = null;
        else if (this.imp) this.closeImport();
        else if (this.groupEdit) this.groupEdit = null;
        else if (this.colEdit) this.colEdit = null;
        else if (this.settings) this.settings = null;
        else if (this.search) this.search = '';
      } else if (ctrl && e.key.toLowerCase() === 's' && this.edit) {
        e.preventDefault(); this.saveEdit();
      } else if (ctrl && e.key.toLowerCase() === 'f') {
        e.preventDefault(); this.$refs.searchInput?.focus(); this.$refs.searchInput?.select();
      } else if (ctrl && e.key.toLowerCase() === 'n' && !this.edit) {
        e.preventDefault(); this.openEdit();
      }
    },
  },
});

// ---------- 自定義列：表格裡的顯示 ----------
app.component('cell-view', {
  props: ['col', 'value'],
  emits: ['click'],
  methods: { t, flag, countryName },
  template: `
    <span v-if="col.type === 'text'" class="copy" @click="$emit('click', $event)">{{ value }}</span>
    <span v-else class="cell-custom" @click="$emit('click', $event)" :title="col.type === 'country' && value ? countryName(value) : ''">
      <template v-if="!value"><span class="placeholder">＋</span></template>
      <span v-else-if="col.type === 'color'" class="color-mark" :style="{background: value}"></span>
      <template v-else-if="col.type === 'country'"><span class="flag">{{ flag(value) }}</span><span class="mono">{{ value }}</span></template>
      <span v-else-if="col.type === 'emoji'" class="emoji-cell">{{ value }}</span>
      <img v-else-if="col.type === 'image'" class="thumb" :src="value" alt="">
    </span>`,
});

// ---------- 自定義列：編輯器（編輯彈窗 / 單元格浮層 / 批量設置共用） ----------
app.component('cell-editor', {
  props: ['col', 'modelValue', 'autofocus'],
  emits: ['update:modelValue', 'pick'],
  data() { return { q: '', active: 0, colors: COLOR_MARKS, emojis: EMOJIS }; },
  computed: {
    countries() {
      return searchCountries(this.q, ui.lang).map(c => ({ ...c, name: countryName(c.code) }));
    },
  },
  watch: { q() { this.active = 0; } },
  mounted() {
    if (this.autofocus) nextTick(() => (this.$refs.search || this.$refs.text || this.$el).focus?.());
  },
  methods: {
    t, flag,
    set(v, pick) { this.$emit('update:modelValue', v); if (pick) this.$emit('pick'); },
    // 國家列表鍵盤操作：↑↓ 移動，Enter 選中（默認第一個）
    onCountryKey(e) {
      const n = this.countries.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.active = (this.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        nextTick(() => this.$refs.countryList?.children[this.active]?.scrollIntoView({ block: 'nearest' }));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (this.countries[this.active]) this.set(this.countries[this.active].code, true);
      }
    },
    toggleEmoji(e) {
      const v = this.modelValue || '';
      this.set(v.includes(e) ? v.replace(e, '') : v + e);
    },
    async onFile(ev) {
      const file = ev.target.files?.[0];
      ev.target.value = '';
      if (file) this.loadImage(file);
    },
    onPaste(ev) {
      if (this.col.type !== 'image') return;
      const item = [...(ev.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
      if (item) { ev.preventDefault(); this.loadImage(item.getAsFile()); }
    },
    async loadImage(file) {
      try { this.set(await fileToThumb(file)); }
      catch { alert(t('cell.imageFailed')); }
    },
  },
  template: `
    <div class="cell-editor" tabindex="-1" @paste="onPaste">
      <input v-if="col.type === 'text'" ref="text" :value="modelValue" @input="set($event.target.value)">

      <div v-else-if="col.type === 'color'" class="swatches">
        <button v-for="c in colors" type="button" class="swatch" :class="{on: modelValue === c}" :style="{background: c}" @click="set(c, true)"></button>
        <button type="button" class="btn sm" @click="set('', true)">{{ t('btn.clear') }}</button>
      </div>

      <template v-else-if="col.type === 'country'">
        <div class="editor-row">
          <input ref="search" v-model="q" :placeholder="t('cell.searchCountry')" @keydown="onCountryKey">
          <button type="button" class="btn sm" @click="set('', true)">{{ t('btn.clear') }}</button>
        </div>
        <div class="country-list" ref="countryList">
          <div v-for="(c, i) in countries" :key="c.code" class="country-item" :class="{on: modelValue === c.code, active: i === active}"
               @click="set(c.code, true)" @mouseenter="active = i">
            <span class="flag">{{ flag(c.code) }}</span><span class="cname">{{ c.name }}</span>
            <span class="meta">{{ c.a3 }} · {{ c.currency || '—' }} · +{{ c.dial }}</span><span class="code">{{ c.code }}</span>
          </div>
          <div v-if="!countries.length" class="muted" style="padding:8px">{{ t('cell.noCountry') }}</div>
        </div>
      </template>

      <template v-else-if="col.type === 'emoji'">
        <div class="editor-row">
          <input ref="text" class="emoji-cell" :value="modelValue" @input="set($event.target.value)" :placeholder="t('cell.emojiPlaceholder')">
          <button type="button" class="btn sm" @click="set('')">{{ t('btn.clear') }}</button>
        </div>
        <div class="emoji-grid">
          <button v-for="e in emojis" type="button" :class="{on: (modelValue || '').includes(e)}" @click="toggleEmoji(e)">{{ e }}</button>
        </div>
      </template>

      <div v-else-if="col.type === 'image'" class="image-editor">
        <img v-if="modelValue" :src="modelValue" alt="">
        <div v-else class="empty-img">🖼</div>
        <div>
          <div class="editor-row">
            <button type="button" class="btn sm" @click="$refs.file.click()">{{ t('cell.upload') }}</button>
            <button v-if="modelValue" type="button" class="btn sm" @click="set('')">{{ t('btn.clear') }}</button>
          </div>
          <div class="muted" style="font-size:12px;margin-top:6px">{{ t('cell.pasteHint') }}</div>
          <input ref="file" type="file" accept="image/*" style="display:none" @change="onFile">
        </div>
      </div>
    </div>`,
});

function domainOf(email) {
  const i = (email || '').lastIndexOf('@');
  return i >= 0 ? email.slice(i + 1).toLowerCase() : '';
}
function rowText(a) {
  const parts = [a.email, a.password, a.totp_secret, a.recovery_email];
  while (parts.length && !parts[parts.length - 1]) parts.pop();
  return parts.join('----');
}

app.mount('#app');
