/* AI 助手（agent）：用自然語言讓 AI 直接操作這個軟件——查詢統計、篩選搜索排序、新增/導入/修改/刪除郵箱、
   管理列/分組/列表、查看 2FA 驗證碼和收信、複製導出、創建自建郵箱、改設置、撤銷。

   對話循環在前端：後台只負責一輪流式請求（ai_chat_start），模型要調用的工具在這裡執行，結果發回給模型，直到模型給出回答。
   隱私：默認不把密碼、2FA 密鑰、令牌發給 AI（只有 has_xxx 標記），用戶可在面板裡勾選「允許讀取密碼」。
   安全：修改類操作默認先在對話裡確認（可勾選「自動執行」）；刪除類操作總是確認；修改前保存快照，可以撤銷。 */

const AGENT_MAX_STEPS = 30;
const AGENT_HISTORY_LIMIT = 150000;  // 對話歷史超過這麼多字符就丟掉最早的幾輪
const AGENT_UNDO_LIMIT = 30;
const AGENT_TEXT_FIELDS = ['email', 'password', 'totp_secret', 'recovery_email', 'recovery_password',
  'oauth_client_id', 'oauth_token', 'phone', 'notes'];
const AGENT_SECRET_FIELDS = ['password', 'totp_secret', 'recovery_password', 'oauth_token'];
// 顏色標記列可以用顏色名賦值
const COLOR_NAMES = {
  red: '#e5484d', 紅: '#e5484d', 红: '#e5484d', orange: '#f76b15', 橙: '#f76b15', yellow: '#f5a524', 黃: '#f5a524', 黄: '#f5a524',
  green: '#30a46c', 綠: '#30a46c', 绿: '#30a46c', teal: '#12a594', 青: '#12a594', sky: '#0ea5e9', cyan: '#0ea5e9', 天藍: '#0ea5e9', 天蓝: '#0ea5e9',
  blue: '#4f7cff', 藍: '#4f7cff', 蓝: '#4f7cff', purple: '#8e4ec6', 紫: '#8e4ec6', pink: '#e93d82', 粉: '#e93d82',
  brown: '#8b5e3c', 棕: '#8b5e3c', gray: '#64748b', grey: '#64748b', 灰: '#64748b', black: '#1f2937', 黑: '#1f2937',
};

// ---------- 工具定義（OpenAI function calling） ----------
const AGENT_FILTER = {
  type: 'object',
  description: '選擇郵箱的條件，全部同時滿足。不傳 = 當前列表的全部郵箱',
  properties: {
    scope: { type: 'string', enum: ['all', 'view', 'selected'], description: 'all=當前列表全部（默認）；view=表格當前篩選/搜索後顯示的；selected=表格裡勾選的' },
    rows: { type: 'object', description: '表格「序號」範圍（按當前顯示順序，含首尾）', properties: { from: { type: 'integer' }, to: { type: 'integer' } } },
    emails: { type: 'array', items: { type: 'string' }, description: '主郵箱地址列表（不分大小寫）' },
    ids: { type: 'array', items: { type: 'integer' } },
    search: { type: 'string', description: '和搜索框一樣的關鍵詞搜索（郵箱/輔助郵箱/備註/手機/自定義列，忽略 . _ - 符號；多個郵箱用空格分隔 = 任一匹配）' },
    conditions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', description: 'email, recovery_email, recovery_domain, domain, phone, notes, status, group, password, totp_secret, recovery_password, oauth_client_id, oauth_token, created_at, updated_at，或自定義列名' },
          op: { type: 'string', enum: ['eq', 'ne', 'contains', 'not_contains', 'starts_with', 'ends_with', 'empty', 'not_empty', 'regex', 'gt', 'lt', 'in'] },
          value: { description: '比較值；in 用數組；日期用 YYYY-MM-DD' },
        },
        required: ['field', 'op'],
      },
    },
  },
};
const AGENT_STR = { type: 'string' };
const AGENT_ACCOUNT_FIELDS = {
  email: AGENT_STR, password: AGENT_STR, totp_secret: AGENT_STR, recovery_email: AGENT_STR, recovery_password: AGENT_STR,
  phone: AGENT_STR, notes: AGENT_STR, oauth_client_id: AGENT_STR, oauth_token: AGENT_STR,
};
const AGENT_SET = {
  type: 'object',
  description: '要修改的字段。字符串可用模板 {email} {user}（郵箱用戶名）{domain} {index}（序號）{random}（隨機密碼）',
  properties: {
    ...AGENT_ACCOUNT_FIELDS, status: AGENT_STR,
    group: { type: 'string', description: '分組名，不存在會自動創建；空字符串 = 移出分組' },
    append_notes: { type: 'string', description: '追加到備註末尾（換行分隔）' },
  },
};
const AGENT_COLUMNS = {
  type: 'object', additionalProperties: true,
  description: '自定義列賦值 { "列名": 值 }，列不存在會自動新建。國家列填代碼或國名，顏色列填 #hex 或顏色名，空字符串 = 清空',
};
const AGENT_NEW_ACCOUNT = {
  type: 'object',
  properties: { ...AGENT_ACCOUNT_FIELDS, status: AGENT_STR, group: AGENT_STR, country: { type: 'string', description: '國家/地區，寫入國家列（沒有會自動新建）' }, columns: AGENT_COLUMNS },
  required: ['email'],
};

const agentFn = (name, description, properties = {}, required = []) =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

const AGENT_TOOLS = [
  agentFn('get_accounts', '查詢當前列表的郵箱，返回字段和總數。密碼類字段默認只返回 has_xxx', {
    filter: AGENT_FILTER,
    fields: { type: 'array', items: { type: 'string' }, description: '只返回這些字段（默認常用字段 + 自定義列）' },
    include_secrets: { type: 'boolean', description: '返回密碼、2FA 密鑰、令牌明文（需要用戶在面板允許）' },
    limit: { type: 'integer', description: '默認 50，最多 200' }, offset: { type: 'integer' },
  }),
  agentFn('count_accounts', '統計數量，可按字段分組計數（domain、status、group、recovery_domain、自定義列名、email 查重等）', {
    filter: AGENT_FILTER, group_by: { type: 'string' },
  }),
  agentFn('find_in_all_sheets', '在所有列表裡查找郵箱，返回每個列表的匹配數和郵箱', {
    search: { type: 'string' }, emails: { type: 'array', items: { type: 'string' } },
  }),
  agentFn('set_view', '設置表格的篩選和搜索框，讓用戶看到結果。只傳要改的項；clear=true 先清除所有篩選', {
    clear: { type: 'boolean' }, search: { type: 'string' }, status: { type: 'string' }, group: { type: 'string', description: '分組名；"none" = 未分組' },
    domain: { type: 'string', description: '主郵箱域名，例如 gmail.com' }, has_2fa: { type: 'string', enum: ['', 'yes', 'no'] },
    has_recovery: { type: 'string', enum: ['', 'yes', 'no'] }, country: { type: 'string', description: '國家，多個用 / 分隔' },
  }),
  agentFn('select_rows', '在表格裡勾選郵箱。show_only=true 時把搜索框設成這些郵箱，只顯示它們', {
    filter: AGENT_FILTER, mode: { type: 'string', enum: ['replace', 'add', 'remove', 'clear'] }, show_only: { type: 'boolean' },
  }),
  agentFn('set_table', '表格排序、每頁條數、翻頁', {
    sort_by: { type: 'string', description: '列名或字段名（email、status、group、notes、updated、自定義列名…），空 = 不排序' },
    sort_dir: { type: 'string', enum: ['asc', 'desc'] }, page_size: { type: 'integer', enum: [20, 50, 100, 200] }, page: { type: 'integer' },
  }),
  agentFn('add_accounts', '新增郵箱到當前列表（或 sheet 指定的列表，不存在自動創建）。每個郵箱可帶任意字段、狀態、分組、國家、自定義列', {
    accounts: { type: 'array', items: AGENT_NEW_ACCOUNT },
    group: { type: 'string', description: '默認分組（不存在自動創建）' }, status: { type: 'string', description: '默認狀態' },
    sheet: { type: 'string' }, skip_duplicates: { type: 'boolean', description: '跳過列表裡已有的郵箱，默認 true' },
  }, ['accounts']),
  agentFn('import_text', '用軟件的智能識別解析用戶粘貼的原始賬號文本（任意分隔符、任意順序）並導入。返回無法識別的行，你可以整理後用 add_accounts 補上', {
    text: { type: 'string' }, group: AGENT_STR, status: AGENT_STR, sheet: AGENT_STR, columns: AGENT_COLUMNS,
    skip_duplicates: { type: 'boolean' },
  }, ['text']),
  agentFn('update_accounts', '修改郵箱：任意字段、狀態、分組、備註、自定義列值。對 filter 選中的統一修改，或用 items 給每個郵箱分別賦值', {
    filter: AGENT_FILTER, set: AGENT_SET, columns: AGENT_COLUMNS,
    items: { type: 'array', description: '分別賦值', items: { type: 'object', properties: { email: AGENT_STR, set: AGENT_SET, columns: AGENT_COLUMNS }, required: ['email'] } },
  }),
  agentFn('delete_accounts', '刪除郵箱（用戶會確認，可撤銷）', { filter: AGENT_FILTER }, ['filter']),
  agentFn('move_to_sheet', '把郵箱移動到另一個列表，列表不存在時自動創建', { filter: AGENT_FILTER, sheet: AGENT_STR }, ['sheet']),
  agentFn('manage_columns', '管理表格列：list 列出；add 新增自定義列；rename / set_type 修改自定義列；delete 刪除自定義列；show / hide 顯示隱藏（含內置列）；move 調整位置；resize 設置寬度；reset_layout 恢復默認順序和寬度', {
    action: { type: 'string', enum: ['list', 'add', 'rename', 'set_type', 'delete', 'show', 'hide', 'move', 'resize', 'reset_layout'] },
    name: { type: 'string', description: '列名（內置列可用 序號/郵箱/密碼/2FA/輔助郵箱/分組/狀態/備註/更新時間 或 index/email/…）' },
    names: { type: 'array', items: { type: 'string' }, description: 'show / hide 多個列' },
    new_name: AGENT_STR, type: { type: 'string', enum: ['text', 'color', 'country', 'emoji', 'image'] },
    before: { type: 'string', description: 'move：放到這一列前面' }, after: { type: 'string', description: 'move：放到這一列後面' },
    position: { type: 'integer', description: 'move：第幾列（從 1 開始）' }, width: { type: 'integer', description: 'resize：像素' },
  }, ['action']),
  agentFn('manage_groups', '管理側邊欄的分組（不是表格裡的「分組」列）：list / create / rename / recolor / move（調整分組在側邊欄的順序）/ delete（刪除分組不刪郵箱）', {
    action: { type: 'string', enum: ['list', 'create', 'rename', 'recolor', 'move', 'delete'] }, name: AGENT_STR, new_name: AGENT_STR,
    color: { type: 'string', description: '#hex 或顏色名' },
    position: { type: 'integer', description: 'move：移到第幾個（1 = 最前面，-1 = 最後面）' },
    before: { type: 'string', description: 'move：放到這個名稱前面' }, after: { type: 'string', description: 'move：放到這個名稱後面' },
    offset: { type: 'integer', description: 'move：相對移動，-1 = 上移一位，2 = 下移兩位' },
  }, ['action']),
  agentFn('manage_sheets', '管理側邊欄的列表：list / create / rename / switch（切換表格顯示的列表，之後的操作針對它）/ move（調整列表順序）/ delete（連同郵箱，用戶會確認，可撤銷）', {
    action: { type: 'string', enum: ['list', 'create', 'rename', 'switch', 'move', 'delete'] }, name: AGENT_STR, new_name: AGENT_STR,
    position: { type: 'integer', description: 'move：移到第幾個（1 = 最前面，-1 = 最後面）' },
    before: { type: 'string', description: 'move：放到這個名稱前面' }, after: { type: 'string', description: 'move：放到這個名稱後面' },
    offset: { type: 'integer', description: 'move：相對移動，-1 = 上移一位，2 = 下移兩位' },
  }, ['action']),
  agentFn('get_2fa_codes', '獲取郵箱當前的 2FA 驗證碼（6 位，30 秒有效）', { filter: AGENT_FILTER }),
  agentFn('fetch_mail', '收取郵箱的最新郵件（自建 BillionMail / 微軟郵箱），返回發件人、標題、時間、提取到的驗證碼和正文摘要', {
    email: { type: 'string', description: '主郵箱地址（當前列表裡的）' },
    which: { type: 'string', enum: ['recovery', 'email'], description: 'recovery=它的輔助郵箱（默認），email=主郵箱本身' },
    limit: { type: 'integer', description: '取最新多少封，默認 5，最多 50（返回 total = 郵件總數）' },
  }, ['email']),
  agentFn('copy_to_clipboard', '在本地把郵箱數據複製到剪貼板（可以包含密碼，不經過 AI）', {
    filter: AGENT_FILTER, fields: { type: 'array', items: { type: 'string' }, description: '默認 email,password,totp_secret,recovery_email' },
    separator: { type: 'string', description: '默認 ----' },
  }),
  agentFn('export_accounts', '在本地導出文件（CSV 或 TXT，包含密碼），會彈出保存對話框', { filter: AGENT_FILTER, format: { type: 'string', enum: ['csv', 'txt'] } }),
  agentFn('create_recovery_mailboxes', '用 BillionMail 管理員權限，給郵箱在自建域名下創建同名輔助郵箱（隨機密碼）並保存；已有輔助郵箱的默認跳過', {
    filter: AGENT_FILTER, domain: AGENT_STR, overwrite: { type: 'boolean' },
  }, ['domain']),
  agentFn('open_account', '在界面上打開某個郵箱：edit=編輯窗口，inbox=主郵箱收件箱，recovery_inbox=輔助郵箱收件箱', {
    email: AGENT_STR, view: { type: 'string', enum: ['edit', 'inbox', 'recovery_inbox'] },
  }, ['email']),
  agentFn('set_preferences', '修改軟件設置：主題、語言、自動鎖定、表格裡是否顯示密碼', {
    theme: { type: 'string', enum: ['light', 'dark', 'system'] }, language: { type: 'string', enum: ['zh-Hant', 'zh-Hans', 'en', 'ja'] },
    auto_lock_minutes: { type: 'integer', description: '0 = 從不' }, show_passwords: { type: 'boolean' },
  }),
  agentFn('undo', '撤銷你在這次對話裡做的修改（默認最近一次）。返回可撤銷的操作列表', { id: { type: 'string', description: '要撤銷的操作 id，不傳 = 最近一次' } }),
];

// 自建郵箱管理窗口專用：這裡每一行就是 BillionMail 後台的真實郵箱
const AGENT_SELFMAIL_TOOLS = [
  agentFn('create_mailboxes', '在 BillionMail 後台批量新建郵箱並加入列表：names 給用戶名或完整地址；或 count 個「prefix + 6 位隨機字符」。密碼留空 = 每個隨機', {
    domain: { type: 'string', description: '域名（names 裡沒寫域名時用它）' },
    names: { type: 'array', items: { type: 'string' } },
    count: { type: 'integer', description: '隨機生成多少個（最多 500）' }, prefix: AGENT_STR,
    password: { type: 'string', description: '統一密碼（至少 8 位），留空 = 隨機' },
    group: { type: 'string', description: '加入的分組，不存在自動創建' },
  }),
  agentFn('sync_mailboxes', '從 BillionMail 後台同步：後台新增的郵箱加進列表，後台刪掉的從列表移除，密碼和停用狀態更新'),
];
// 自建郵箱窗口用不上的工具（只有一個列表、郵箱只能在後台新建）
const AGENT_MAIN_ONLY = ['add_accounts', 'import_text', 'move_to_sheet', 'manage_sheets', 'find_in_all_sheets', 'create_recovery_mailboxes'];

// 修改類（確認後執行，可勾選自動執行）和刪除類（總是確認）
function agentConfirmLevel(name, args) {
  if (name === 'delete_accounts') return 'danger';
  if (['manage_sheets', 'manage_columns', 'manage_groups'].includes(name) && args.action === 'delete') return 'danger';
  if (['update_accounts', 'add_accounts', 'import_text', 'move_to_sheet', 'create_recovery_mailboxes', 'create_mailboxes'].includes(name)) return 'write';
  return '';
}

const AgentMixin = {
  data() {
    return { agent: { open: false, items: [], history: [], input: '', busy: false, stop: false, undo: [] } };
  },

  computed: {
    agentExamples() { return (SELFMAIL ? [1, 2, 3, 4] : [1, 2, 3, 4, 5]).map(i => t((SELFMAIL ? 'agent.sm' : 'agent.ex') + i)); },
    agentTools() {
      return SELFMAIL ? [...AGENT_TOOLS.filter(x => !AGENT_MAIN_ONLY.includes(x.function.name)), ...AGENT_SELFMAIL_TOOLS] : AGENT_TOOLS;
    },
  },

  methods: {
    // ---------- 面板 ----------
    toggleAgent() {
      this.agent.open = !this.agent.open;
      if (this.agent.open) nextTick(() => this.$refs.agentInput?.focus());
    },
    agentClear() {
      this.agentStop();
      Object.assign(this.agent, { items: [], history: [], busy: false, stop: false, undo: [] });
    },
    agentStop() {
      if (!this.agent.busy) return;
      this.agent.stop = true;
      for (const m of this.agent.items) for (const tc of m.tools || []) if (tc.status === 'confirm') tc.resolve(false);
    },
    agentScroll() { nextTick(() => { const el = this.$refs.agentMsgs; if (el) el.scrollTop = el.scrollHeight; }); },
    agentToolLabel(name) { return t('agent.tool.' + name); },
    // 回答裡的簡單 Markdown：**粗體**、`代碼`、```代碼塊```、# 標題（先轉義，安全）
    agentMd(text) {
      const esc = String(text || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      return esc.replace(/```[\w-]*\n?([\s\S]*?)```/g, '<pre>$1</pre>')
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/^#{1,4}\s*(.+)$/gm, '<b>$1</b>');
    },
    agentPretty(json) {
      try { return JSON.stringify(JSON.parse(json), null, 1).slice(0, 4000); } catch { return String(json || '').slice(0, 4000); }
    },
    // 對話記錄（含工具調用的參數和結果），方便排查 AI 做了什麼
    agentTranscript() {
      const lines = [];
      for (const m of this.agent.items) {
        if (m.role === 'user') lines.push(`【${t('agent.you')}】\n${m.text}`);
        else {
          if (m.text) lines.push(`【AI】\n${m.text}`);
          for (const tc of m.tools || []) lines.push(`  → ${tc.name} ${tc.args}\n  ← ${tc.status}: ${(tc.result || tc.summary || '').slice(0, 1500)}`);
          if (m.error) lines.push(`  ✕ ${m.error}`);
        }
      }
      this.copy(lines.join('\n\n'), t('agent.transcript'), true);
    },
    async agentUndoClick(tc) {
      try {
        const r = await this.agentUndo(tc.undoId);
        if (r.error) this.toast(r.error, 'error'); else this.toast(t('agent.undone'));
      } catch (e) { this.toast(errText(e), 'error'); }
    },

    // ---------- 對話循環 ----------
    async agentSend(text) {
      const agent = this.agent;
      text = (text ?? agent.input).trim();
      if (!text || agent.busy) return;
      try {
        if (!aiConfigured(await call('get_ai_config'))) return this.toast(t('import.aiNoConfig'), 'error');
      } catch (e) { return this.toast(errText(e), 'error'); }
      agent.input = '';
      agent.items.push({ role: 'user', text, tools: [] });
      agent.history.push({ role: 'user', content: text });
      agent.busy = true;
      agent.stop = false;
      this.agentScroll();
      try {
        await this.agentLoop();
      } finally {
        agent.busy = false;
        agent.stop = false;
      }
    },
    // 歷史太長時丟掉最早的幾輪（從一條用戶消息開始截，保證工具調用和結果成對）
    agentTrimHistory() {
      const h = this.agent.history;
      while (JSON.stringify(h).length > AGENT_HISTORY_LIMIT && h.length > 2) {
        let i = h.findIndex((m, k) => k > 0 && m.role === 'user');
        if (i <= 0) break;
        h.splice(0, i);
      }
    },
    async agentLoop() {
      const agent = this.agent;
      for (let step = 0; step < AGENT_MAX_STEPS; step++) {
        agent.items.push({ role: 'assistant', text: '', tools: [], streaming: true, error: '' });
        const item = agent.items[agent.items.length - 1];  // 響應式代理
        this.agentTrimHistory();
        const messages = [{ role: 'system', content: this.agentSystemPrompt() }, ...agent.history];
        let result;
        try {
          const job = await call('ai_chat_start', messages, this.agentTools);
          result = await pollAiJob(job, d => { item.text += d; this.agentScroll(); }, () => agent.stop);
        } catch (e) {
          item.error = errText(e);
          item.streaming = false;
          return;
        }
        item.streaming = false;
        if (result.stopped) return;
        const calls = result.tool_calls || [];
        agent.history.push(calls.length
          ? { role: 'assistant', content: item.text || null, tool_calls: calls }
          : { role: 'assistant', content: item.text });
        if (!calls.length) return;
        for (const c of calls) {
          item.tools.push({ name: c.function.name, status: 'running', summary: '', desc: '', danger: false, resolve: null, undoId: '',
            args: c.function.arguments || '{}', result: '', open: false });
          const tc = item.tools[item.tools.length - 1];
          this.agentScroll();
          let out;
          if (agent.stop) out = { error: 'stopped by user' };
          else {
            try {
              out = await this.agentExec(tc, c.function.name, JSON.parse(c.function.arguments || '{}'));
            } catch (e) {
              out = { error: errText(e) };
            }
          }
          tc.status = out.error ? 'error' : 'done';
          tc.summary = out.error ? String(out.error) : this.agentSummary(c.function.name, out);
          if (out.undo_id) tc.undoId = out.undo_id;
          const content = JSON.stringify(out).slice(0, 30000);
          tc.result = content;
          agent.history.push({ role: 'tool', tool_call_id: c.id, content });
        }
        if (agent.stop) return;
      }
    },

    agentSummary(name, out) {
      if (out.declined) return t('agent.declined');
      const n = out.total ?? out.updated ?? out.added ?? out.deleted ?? out.moved ?? out.copied ?? out.exported ?? out.selected;
      switch (name) {
        case 'set_view': return t('agent.sum.view', { n: out.visible });
        case 'select_rows': return t('agent.sum.selected', { n: out.selected });
        case 'update_accounts': return t('agent.sum.updated', { n: out.updated });
        case 'add_accounts': case 'import_text':
          return t('agent.sum.added', { n: out.added, s: out.skipped || 0 }) + (out.failed?.length ? ' · ' + t('agent.sum.failed', { n: out.failed.length }) : '');
        case 'delete_accounts': return t('agent.sum.deleted', { n: out.deleted });
        case 'move_to_sheet': return t('agent.sum.moved', { n: out.moved, s: out.sheet });
        case 'copy_to_clipboard': return t('agent.sum.copied', { n: out.copied });
        case 'export_accounts': return t('agent.sum.exported', { n: out.exported });
        case 'create_recovery_mailboxes': case 'create_mailboxes': return t('agent.sum.mailboxes', { n: out.created?.length || 0, f: out.failed?.length || 0 });
        case 'sync_mailboxes': return t('selfmail.synced', { n: out.total, a: out.added, u: out.updated, d: out.removed });
        case 'get_2fa_codes': return t('agent.sum.found', { n: out.codes?.length || 0 });
        case 'fetch_mail': return t('agent.sum.mails', { n: out.messages?.length || 0 });
        case 'undo': return out.undone || '✓';
      }
      return n != null ? t('agent.sum.found', { n }) : '✓';
    },

    agentSystemPrompt() {
      const ctx = {
        today: new Date().toISOString().slice(0, 10),
        ui_language: ui.lang,
        current_sheet: this.sheetName(this.currentSheet),
        sheets: this.visibleSheets.map(s => ({ name: this.sheetName(s), count: s.count })),
        columns: this.allColumns.map(c => ({ name: c.label, key: c.custom ? undefined : c.key, type: c.custom ? c.col.type : undefined, visible: this.isColumnVisible(c.key) })),
        groups: this.groups.map(g => g.name),
        statuses: this.meta.statuses.map(s => this.statusLabel(s)),
        total_in_sheet: this.accounts.length,
        table_view: { shown: this.sorted.length, search: this.search, filters: this.filters, sort: this.sort, page: this.page, page_size: this.pageSize },
        selected: this.accounts.filter(a => this.selected[a.id]).length,
        top_domains: this.domains.slice(0, 15),
        self_hosted_domains: this.selfDomains,
        billionmail_configured: !!this.mailCfg?.panel_url,
        can_read_secrets: !!this.prefs.agentSecrets,
        undo_available: this.agent.undo.map(u => ({ id: u.id, label: u.label })).slice(-5),
      };
      const secrets = this.prefs.agentSecrets
        ? '用戶已允許你讀取密碼類明文，需要時 get_accounts 傳 include_secrets=true。'
        : '默認看不到密碼、2FA 密鑰、令牌（只有 has_xxx）。需要明文的操作用 copy_to_clipboard / export_accounts 在本地完成；用戶要你直接讀出密碼時，告訴他在 AI 助手面板頂部勾選「允許讀取密碼」。';
      return `你是「郵箱管理」桌面軟件內置的 AI 助手（agent）。你能通過工具完成這個軟件裡幾乎所有的操作：用戶讓你做什麼，就直接調用工具去做完，而不是教用戶自己去點界面。
能力：查詢、統計、查重、跨列表查找；篩選、搜索、排序、勾選、翻頁；新增郵箱（add_accounts，或 import_text 解析用戶粘貼的原始文本）、修改任意字段/狀態/分組/備註/自定義列、刪除郵箱、移動到其他列表；管理列（新增/改名/改類型/刪除/顯示隱藏/調整順序和寬度）、分組、列表；查看 2FA 驗證碼；收取郵件和驗證碼；複製、導出；用 BillionMail 創建自建輔助郵箱；改主題/語言/自動鎖定；撤銷你之前的修改（undo）。
工作方式：
- 你擁有上面列出的全部工具。不要說「我沒有這個功能」「需要你在軟件裡手動操作」，也不要提「改名繞過」之類的變通辦法，先看工具能不能直接完成；只有工具確實做不到時才這樣說。
- 先根據「當前狀態」裡的 groups（側邊欄分組，按顯示順序）、sheets（列表）、columns（表格列）判斷用戶說的名字指的是什麼：
  · 名字是某個分組 / 列表的名稱（例如「分組 29」「分組名稱 29」「29 這個分組」），「移到第一 / 最前 / 置頂 / 第 N 個 / 上移 / 下移 / 放最後」就是調整它在側邊欄的順序（manage_groups / manage_sheets 的 move）——即使用戶說的是「第一列」，這裡的「列」只是口語的「第一位」。
  · 只有名字是表格列名（序號、郵箱、密碼、分組列、備註、自定義列…）時，才是調整表格的列（manage_columns）。
  · 「把郵箱放進 / 移到 29 分組」是改郵箱的分組（update_accounts set.group），不是調整分組順序。
  · 名字同時能對上兩種、又看不出指哪個時，簡短地問一句再做。
- 用戶糾正你（「不是這個意思」「我說的是…」「錯了」）：先用 undo 撤銷剛才理解錯的那一步，再按正確的理解重新做，並說明已撤銷了什麼。
- 多步任務就連續調用多個工具一次做完。信息不足時先用查詢類工具弄清楚；只有確實無法判斷用戶意圖時才提問。
- 用戶給了賬號數據要導入/添加：原始文本直接 import_text（無法識別的行你自己整理後用 add_accounts 補上）；你已經理解了字段就用 add_accounts。可以同時指定分組、狀態、國家、自定義列（例如「編號」）。
- 需要的分組、列、列表不存在時，工具會自動創建，不用先問用戶。
- 修改和刪除類操作界面會讓用戶確認，你直接調用即可，不要在回答裡先徵求同意。用戶說「撤銷 / 改回去」時用 undo。
- 「這些 / 選中的」= filter.scope=selected；「當前顯示的」= scope=view；「第 3 到 10 個」= filter.rows。
- 字符串值可用模板 {email} {user} {domain} {index} {random}（隨機密碼）。
- 密碼：${secrets}
- 用戶想「看 / 找 / 篩選」時，用 set_view 或 select_rows(show_only=true) 把結果顯示在表格裡。
- 完成後用一兩句話總結做了什麼、影響多少條；工具報錯時根據錯誤調整參數重試，連續失敗再如實告訴用戶錯誤原因。不要編造工具沒有返回的數據。用用戶的語言回答。
示例（意圖 → 調用）：
- 「導入下面郵箱，分組 222，編號寫進編號列：a@x.com----pw----備註----7----2FA密鑰 …」→ add_accounts({accounts:[{email:"a@x.com",password:"pw",notes:"備註",totp_secret:"2FA密鑰",columns:{"編號":"7"}}, …], group:"222"})
- 「把這段賬號加進來」（格式雜亂）→ import_text({text: 原文})，再用 add_accounts 補上 failed 的行
- 「把 outlook 的都移到 微軟 分組並標紅」→ update_accounts({filter:{conditions:[{field:"domain",op:"contains",value:"outlook"}]}, set:{group:"微軟"}, columns:{"顏色標記":"紅"}})
- 「第 5 到 20 個狀態改封禁」→ update_accounts({filter:{rows:{from:5,to:20}}, set:{status:"封禁"}})
- 「有沒有重複的郵箱」→ count_accounts({group_by:"email"})
- 「user1 的驗證碼 / 輔助郵箱收到的驗證碼」→ get_2fa_codes / fetch_mail
- 「把備註列放到郵箱後面，隱藏手機號」→ manage_columns({action:"move",name:"備註",after:"郵箱"}) + manage_columns({action:"hide",name:"手機號"})
- 「分組 29 移到第一個 / 置頂」→ manage_groups({action:"move",name:"29",position:1})；「29 分組往上移一位」→ manage_groups({action:"move",name:"29",offset:-1})
- 「把 新號 分組放到 222 後面」→ manage_groups({action:"move",name:"新號",after:"222"})；「默認列表放最後」→ manage_sheets({action:"move",name:"默認列表",position:-1})
- 「剛才改錯了」→ undo
${SELFMAIL ? `
你現在在「自建郵箱管理」窗口：表格裡的每一行就是 BillionMail 後台的一個真實郵箱（郵箱 + 登錄密碼）。
- 新建郵箱用 create_mailboxes（會在後台創建）；delete_accounts 會在後台刪除郵箱，不可撤銷；修改密碼、把狀態改成 / 改離「停用」會同步到後台，也不可撤銷。分組、備註、自定義列只存在本地，可以撤銷。
- 用戶說「同步 / 刷新列表」用 sync_mailboxes；收郵件、驗證碼用 fetch_mail({email, which:"email"})。
- 可用域名：${JSON.stringify(this.selfDomains)}` : ''}
當前狀態：${JSON.stringify(ctx)}`;
    },

    // ---------- 執行工具 ----------
    async agentExec(tc, name, args) {
      const level = agentConfirmLevel(name, args);
      if (level === 'danger' || (level === 'write' && !this.prefs.agentAuto)) {
        tc.desc = await this.agentDescribe(name, args);
        tc.danger = level === 'danger';
        tc.status = 'confirm';
        this.agentScroll();
        const ok = await new Promise(resolve => { tc.resolve = resolve; });
        tc.status = 'running';
        if (!ok) return { declined: true, error: 'user declined this operation' };
      }
      switch (name) {
        case 'get_accounts': return this.agentGet(args);
        case 'count_accounts': return this.agentCount(args);
        case 'find_in_all_sheets': return this.agentFindAll(args);
        case 'set_view': return this.agentSetView(args);
        case 'select_rows': return this.agentSelect(args);
        case 'set_table': return this.agentSetTable(args);
        case 'add_accounts': return this.agentAdd(args.accounts || [], args);
        case 'import_text': return this.agentImportText(args);
        case 'update_accounts': return this.agentUpdate(args);
        case 'delete_accounts': return this.agentDelete(args);
        case 'move_to_sheet': return this.agentMove(args);
        case 'manage_columns': return this.agentManageColumns(args);
        case 'manage_groups': return this.agentManageGroups(args);
        case 'manage_sheets': return this.agentManageSheets(args);
        case 'get_2fa_codes': return this.agent2fa(args);
        case 'fetch_mail': return this.agentFetchMail(args);
        case 'copy_to_clipboard': return this.agentCopy(args);
        case 'export_accounts': {
          const rows = this.agentRows(args.filter);
          await this.doExport(args.format === 'txt' ? 'txt' : 'csv', rows);
          return { exported: rows.length };
        }
        case 'create_recovery_mailboxes': {
          const rows = this.agentRows(args.filter);
          const undoId = this.agentPushUndo(t('agent.tool.create_recovery_mailboxes'), { rows: this.agentSnapshot(rows) });
          const r = await call('create_recovery_mailboxes', rows.map(a => a.id), args.domain, !!args.overwrite);
          await this.loadAccounts();
          return { ...r, undo_id: undoId, note: 'undo only restores the fields; created mailboxes stay on the server' };
        }
        case 'open_account': return this.agentOpen(args);
        case 'set_preferences': return this.agentPrefs(args);
        case 'undo': return this.agentUndo(args.id);
        case 'create_mailboxes': return this.agentCreateMailboxes(args);
        case 'sync_mailboxes': {
          const r = await call('selfmail_sync');
          await this.loadAccounts();
          await this.refreshState();
          return r;
        }
        default: return { error: 'unknown tool ' + name };
      }
    },

    // 給用戶確認的說明：影響多少條 + 做什麼
    async agentDescribe(name, args) {
      const label = k => (k === 'append_notes' ? t('col.notes') + ' +' : (t('col.' + k) !== 'col.' + k ? t('col.' + k) : k));
      const kv = obj => Object.entries(obj || {}).filter(([, v]) => v != null)
        .map(([k, v]) => `${label(k)} = ${v === '' ? '∅' : v}`).join('，');
      const colNames = list => [...new Set(list.flatMap(a => Object.keys(a.columns || {})))];
      try {
        switch (name) {
          case 'update_accounts':
            if (args.items?.length) return t('agent.confirm.items', { n: args.items.length }) + '\n' +
              args.items.slice(0, 8).map(it => `${it.email}：${[kv(it.set), kv(it.columns)].filter(Boolean).join('，')}`).join('\n') +
              (args.items.length > 8 ? '\n…' : '');
            return t('agent.confirm.update', { n: this.agentRows(args.filter).length }) + '\n' + [kv(args.set), kv(args.columns)].filter(Boolean).join('，');
          case 'add_accounts': {
            const list = args.accounts || [];
            return t('agent.confirm.add', { n: list.length, s: args.sheet || this.sheetName(this.currentSheet) }) + '\n' +
              list.slice(0, 6).map(a => a.email).join('\n') + (list.length > 6 ? '\n…' : '') +
              (args.group || args.status ? '\n' + kv({ group: args.group, status: args.status }) : '') +
              (colNames(list).length ? '\n' + t('agent.confirm.columns', { s: colNames(list).join('、') }) : '');
          }
          case 'import_text': {
            const p = parseImport(args.text || '', 'auto', 'smart', []);
            return t('agent.confirm.add', { n: p.rows.length, s: args.sheet || this.sheetName(this.currentSheet) }) +
              (p.failed.length ? '\n' + t('import.failed', { n: p.failed.length }) : '') +
              (args.group || args.status ? '\n' + kv({ group: args.group, status: args.status }) : '');
          }
          case 'create_mailboxes': {
            const n = args.names?.length || Math.min(500, parseInt(args.count, 10) || 0);
            return t('agent.confirm.mailboxes', { n, d: args.domain || (args.names || []).map(x => String(x).split('@')[1]).filter(Boolean)[0] || '—' }) +
              (args.names?.length ? '\n' + args.names.slice(0, 6).join('\n') + (args.names.length > 6 ? '\n…' : '') : '') +
              (args.group ? '\n' + kv({ group: args.group }) : '');
          }
          case 'delete_accounts': {
            const rows = this.agentRows(args.filter);
            return t('agent.confirm.delete', { n: rows.length }) + '\n' + rows.slice(0, 6).map(a => a.email).join('\n') + (rows.length > 6 ? '\n…' : '');
          }
          case 'move_to_sheet': return t('agent.confirm.move', { n: this.agentRows(args.filter).length, s: args.sheet });
          case 'create_recovery_mailboxes': return t('agent.confirm.mailbox', { n: this.agentRows(args.filter).length, d: args.domain });
          case 'manage_sheets': {
            const s = this.agentSheet(args.name);
            return t('agent.confirm.deleteSheet', { s: args.name, n: s ? s.count : 0 });
          }
          case 'manage_columns': return t('agent.confirm.deleteColumn', { s: args.name });
          case 'manage_groups': return t('agent.confirm.deleteGroup', { s: args.name });
        }
      } catch (e) { return errText(e); }
      return name;
    },

    // ---------- 撤銷 ----------
    agentSnapshot(rows) { return JSON.parse(JSON.stringify(rows)); },
    agentPushUndo(label, data) {
      const id = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      this.agent.undo.push({ id, label, ...data });
      if (this.agent.undo.length > AGENT_UNDO_LIMIT) this.agent.undo.shift();
      return id;
    },
    async agentUndo(id) {
      const list = this.agent.undo;
      const idx = id ? list.findIndex(u => u.id === id) : list.length - 1;
      if (idx < 0) return { error: 'nothing to undo', available: list.map(u => ({ id: u.id, label: u.label })) };
      const u = list.splice(idx, 1)[0];
      let rows = u.rows || [];
      if (u.sheet) {  // 恢復被刪除的列表：新建同名列表，郵箱放回去
        const newId = await call('add_sheet', u.sheet.name);
        await call('set_sheet_columns', newId, u.sheet.columns);
        rows = rows.map(r => ({ ...r, sheet_id: newId }));
      }
      if (u.columns) await call('set_sheet_columns', u.columns.sheetId, u.columns.columns);
      if (u.prefs) Object.assign(this.prefs, JSON.parse(JSON.stringify(u.prefs)));
      if (u.order) await call('reorder', u.order.kind, u.order.ids);
      if (u.addedIds?.length) await call('delete_accounts', u.addedIds);
      if (rows.length) await call('restore_accounts', rows);
      for (const m of this.agent.items) for (const tc of m.tools || []) if (tc.undoId === u.id) { tc.undoId = ''; tc.undone = true; }
      await this.reload();
      return { undone: u.label, remaining: list.map(x => ({ id: x.id, label: x.label })) };
    },

    // ---------- 選擇郵箱 ----------
    agentRows(filter) {
      const f = filter || {};
      let list;
      if (f.rows || f.scope === 'view') list = this.sorted;
      else if (f.scope === 'selected') list = this.sortList(this.accounts.filter(a => this.selected[a.id]));
      else list = this.sortList(this.accounts);
      if (f.rows) {
        const from = Math.max(1, parseInt(f.rows.from, 10) || 1);
        const to = parseInt(f.rows.to, 10) || list.length;
        list = list.slice(from - 1, to);
      }
      if (f.ids?.length) { const set = new Set(f.ids.map(Number)); list = list.filter(a => set.has(a.id)); }
      if (f.emails?.length) {
        const set = new Set(f.emails.map(e => String(e).trim().toLowerCase()));
        list = list.filter(a => set.has(a.email.toLowerCase()));
      }
      if (f.search) list = list.filter(this.searchMatcher(f.search));
      for (const c of f.conditions || []) list = list.filter(a => this.agentCond(a, c));
      return list;
    },
    agentColumn(name) {
      const n = String(name || '').trim().toLowerCase();
      return this.currentSheet.columns.find(c => c.name.toLowerCase() === n || c.id === name);
    },
    // 列名 → 表格列 key（內置列可用 key 或四種語言的列名；自定義列用列名）
    agentColKey(name) {
      const n = String(name || '').trim().toLowerCase();
      if (!n) return '';
      const alias = { totp_secret: 'totp', '2fa': 'totp', updated_at: 'updated', '#': 'index' };
      if (alias[n]) return alias[n];
      for (const c of BASE_COLUMNS) {
        if (c.key === n || Object.values(I18N).some(d => (d['col.' + c.key] || '').toLowerCase() === n)) return c.key;
      }
      const col = this.agentColumn(name);
      return col ? 'x_' + col.id : '';
    },
    agentSheet(name) {
      const n = String(name || '').trim().toLowerCase();
      return this.visibleSheets.find(s => this.sheetName(s).toLowerCase() === n || s.name.toLowerCase() === n);
    },
    agentStatus(v) {
      const s = String(v ?? '').trim().toLowerCase();
      return this.meta.statuses.find(st => st.toLowerCase() === s || this.statusLabel(st).toLowerCase() === s ||
        Object.values(I18N).some(dict => (dict['status.' + this.statusIndex(st)] || '').toLowerCase() === s)) || '';
    },
    agentStatusOrThrow(v) {
      const st = this.agentStatus(v);
      if (!st) throw new Error(`unknown status "${v}", use one of: ${this.meta.statuses.map(s => this.statusLabel(s)).join(', ')}`);
      return st;
    },
    // 字段的值（用於篩選、統計、複製），undefined = 沒有這個字段
    agentField(a, field) {
      const f = String(field || '').trim();
      if (AGENT_TEXT_FIELDS.includes(f)) return a[f] || '';
      switch (f) {
        case 'status': return a.status;
        case 'group': return this.groupMap[a.group_id]?.name || '';
        case 'domain': return domainOf(a.email);
        case 'recovery_domain': return domainOf(a.recovery_email);
        case 'created_at': return a.created_at;
        case 'updated_at': return a.updated_at;
      }
      const col = this.agentColumn(f);
      if (col) return a.extra?.[col.id] || '';
      return undefined;
    },
    agentCond(a, c) {
      const field = String(c.field || '').trim();
      const v = this.agentField(a, field);
      if (v === undefined) throw new Error(`unknown field "${field}"`);
      const op = c.op;
      if (AGENT_SECRET_FIELDS.includes(field) && !this.prefs.agentSecrets && !['empty', 'not_empty'].includes(op)) {
        throw new Error(`${field} only supports empty / not_empty (reading secrets is not allowed)`);
      }
      if (op === 'empty') return !v;
      if (op === 'not_empty') return !!v;
      // 值的規範化：狀態用內部值，國家列用代碼，日期轉時間戳
      const norm = x => {
        if (field === 'status') return this.agentStatus(x) || String(x);
        const col = this.agentColumn(field);
        if (col?.type === 'country') return countryFromText(String(x)) || String(x).toUpperCase();
        if (field === 'created_at' || field === 'updated_at') return Math.floor(Date.parse(x) / 1000) || 0;
        return x;
      };
      if (op === 'gt' || op === 'lt') {
        const w = norm(c.value);
        const [x, y] = typeof v === 'number' ? [v, Number(w)] : [String(v), String(w)];
        return op === 'gt' ? x > y : x < y;
      }
      if (op === 'regex') return new RegExp(String(c.value), 'i').test(String(v));
      const s = String(v).toLowerCase();
      if (op === 'in') return (Array.isArray(c.value) ? c.value : String(c.value).split(/[,，]/)).some(x => String(norm(x)).toLowerCase() === s);
      const want = String(norm(c.value ?? '')).toLowerCase();
      switch (op) {
        case 'eq': return s === want;
        case 'ne': return s !== want;
        case 'contains': return s.includes(want);
        case 'not_contains': return !s.includes(want);
        case 'starts_with': return s.startsWith(want);
        case 'ends_with': return s.endsWith(want);
      }
      throw new Error('unknown op ' + op);
    },
    agentIndexMap() { return new Map(this.sorted.map((a, i) => [a.id, i + 1])); },
    // 發給 AI 的一行數據：密碼類只給 has_xxx，除非用戶允許
    agentRowOut(a, fields, index, secrets) {
      const out = { id: a.id };
      if (index.has(a.id)) out.index = index.get(a.id);
      const all = !fields?.length;
      const want = f => all || fields.includes(f);
      for (const f of ['email', 'recovery_email', 'phone', 'oauth_client_id']) if (want(f) && (a[f] || !all)) out[f] = a[f] || '';
      if (want('status')) out.status = this.statusLabel(a.status);
      if (want('group')) out.group = this.groupMap[a.group_id]?.name || '';
      if (want('notes') && (a.notes || !all)) out.notes = (a.notes || '').slice(0, 300);
      for (const f of AGENT_SECRET_FIELDS) {
        if (secrets && (all || want(f))) out[f] = a[f] || '';
        else if (want(f) || want('has_' + f)) out['has_' + f] = !!a[f];
      }
      if (want('updated_at')) out.updated_at = this.fmtDate(a.updated_at);
      if (want('created_at')) out.created_at = this.fmtDate(a.created_at);
      for (const col of this.currentSheet.columns) {
        if (!want(col.name)) continue;
        const v = a.extra?.[col.id];
        if (v || !all) out[col.name] = col.type === 'image' ? (v ? '[image]' : '') : (v || '');
      }
      return out;
    },
    agentTemplate(v, a, index) {
      return String(v ?? '').replace(/\{(email|user|domain|index|random)\}/g, (_, k) => {
        if (k === 'random') return this.genPassword();
        const email = a.email || '';
        if (k === 'email') return email;
        if (k === 'user') return email.split('@')[0];
        if (k === 'domain') return domainOf(email);
        return String(index?.get(a.id) || '');
      });
    },
    agentColumnValue(col, v) {
      v = String(v ?? '').trim();
      if (!v) return '';
      if (col.type === 'country') {
        const code = countryFromText(v) || (COUNTRY_CODES.includes(v.toUpperCase()) ? v.toUpperCase() : '');
        if (!code) throw new Error(`unknown country "${v}"`);
        return code;
      }
      if (col.type === 'color') return this.agentColor(v);
      if (col.type === 'image') throw new Error('image columns cannot be set by AI');
      return v;
    },
    agentColor(v) {
      v = String(v || '').trim();
      if (/^#[0-9a-f]{3,8}$/i.test(v)) return v;
      const c = COLOR_NAMES[v.toLowerCase()] || COLOR_NAMES[v.replace(/色$/, '')];
      if (!c) throw new Error(`unknown color "${v}"`);
      return c;
    },
    // 自動新建列時按列名和值猜類型：國家 / 顏色，其他為文本
    agentGuessType(name, value) {
      const n = String(name).toLowerCase(), v = String(value ?? '').trim();
      if (/國家|国家|地區|地区|country|region/.test(n) && (!v || countryFromText(v))) return 'country';
      if (/顏色|颜色|色|color|colour|標記|标记/.test(n) && (!v || /^#[0-9a-f]{3,8}$/i.test(v) || COLOR_NAMES[v.toLowerCase()] || COLOR_NAMES[v.replace(/色$/, '')])) return 'color';
      return 'text';
    },
    async agentGroupId(name, create, color) {
      name = String(name ?? '').trim();
      if (!name || name === 'none') return null;
      const g = this.groups.find(x => x.name.toLowerCase() === name.toLowerCase());
      if (g) return g.id;
      if (!create) throw new Error(`unknown group "${name}"`);
      const id = await call('add_group', name, color ? this.agentColor(color) : this.randomColor());
      await this.refreshState();
      return id;
    },
    async agentAddColumn(name, type) {
      name = String(name || '').trim();
      if (!name) throw new Error('column name required');
      const existing = this.agentColumn(name);
      if (existing) return { column: existing.name, type: existing.type, existed: true };
      const col = { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name,
        type: COLUMN_TYPES.includes(type) ? type : 'text' };
      await call('set_sheet_columns', this.sheetId, [...this.currentSheet.columns, col]);
      await this.refreshState();
      return { column: name, type: col.type, created: true };
    },
    // 列名 → 自定義列，不存在就按值猜類型新建
    async agentEnsureColumn(name, sample) {
      if (!this.agentColumn(name)) await this.agentAddColumn(name, this.agentGuessType(name, sample));
      return this.agentColumn(name);
    },
    async agentEnsureCountryColumn() {
      if (!this.countryColumns.length) await this.agentAddColumn(t('type.country'), 'country');
      return this.countryColumns[0];
    },

    // ---------- 查詢 ----------
    agentGet(args) {
      const rows = this.agentRows(args.filter);
      const limit = Math.min(200, Math.max(1, parseInt(args.limit, 10) || 50));
      const offset = Math.max(0, parseInt(args.offset, 10) || 0);
      const index = this.agentIndexMap();
      const secrets = !!(args.include_secrets && this.prefs.agentSecrets);
      const out = { total: rows.length, offset, rows: rows.slice(offset, offset + limit).map(a => this.agentRowOut(a, args.fields, index, secrets)) };
      if (args.include_secrets && !secrets) out.note = 'secrets hidden: the user has not ticked "allow reading passwords" in the assistant panel';
      return out;
    },
    agentCount(args) {
      const rows = this.agentRows(args.filter);
      if (!args.group_by) return { total: rows.length };
      const counts = {};
      for (const a of rows) {
        let v = this.agentField(a, args.group_by);
        if (v === undefined) throw new Error(`unknown field "${args.group_by}"`);
        if (args.group_by === 'status') v = this.statusLabel(v);
        if (AGENT_SECRET_FIELDS.includes(args.group_by) && !this.prefs.agentSecrets) v = v ? 'yes' : 'no';
        if (args.group_by === 'email') v = String(v).toLowerCase();
        counts[v || '(empty)'] = (counts[v || '(empty)'] || 0) + 1;
      }
      let groups = Object.entries(counts).sort((x, y) => y[1] - x[1]);
      if (args.group_by === 'email') groups = groups.filter(([, n]) => n > 1);  // 查重只返回重複的
      return { total: rows.length, distinct: Object.keys(counts).length, groups: groups.slice(0, 100).map(([value, count]) => ({ value, count })) };
    },
    async agentFindAll(args) {
      const set = args.emails?.length ? new Set(args.emails.map(e => String(e).trim().toLowerCase())) : null;
      const match = this.searchMatcher(args.search || '');
      const out = [];
      for (const s of this.visibleSheets) {
        const rows = s.id === this.sheetId ? this.accounts : await call('list_accounts', s.id);
        const hits = rows.filter(a => (!set || set.has(a.email.toLowerCase())) && match(a));
        if (hits.length) out.push({ sheet: this.sheetName(s), count: hits.length, emails: hits.slice(0, 30).map(a => a.email) });
      }
      return { total: out.reduce((n, x) => n + x.count, 0), sheets: out };
    },

    // ---------- 界面 ----------
    agentSetView(args) {
      if (args.clear) this.resetFilters();
      const f = { ...this.filters };
      if (args.status !== undefined) f.status = args.status ? this.agentStatusOrThrow(args.status) : '';
      if (args.group !== undefined) {
        const g = this.groups.find(x => x.name.toLowerCase() === String(args.group).toLowerCase());
        if (args.group && args.group !== 'none' && !g) throw new Error(`unknown group "${args.group}"`);
        f.group = !args.group ? '' : (args.group === 'none' ? 'none' : g.id);
      }
      if (args.domain !== undefined) f.domain = String(args.domain || '').toLowerCase().replace(/^@/, '');
      if (args.has_2fa !== undefined) f.twofa = args.has_2fa || '';
      if (args.has_recovery !== undefined) f.recovery = args.has_recovery || '';
      if (args.country !== undefined) f.country = args.country || '';
      this.filters = f;
      if (args.search !== undefined) this.search = args.search || '';
      return { visible: this.filtered.length };
    },
    agentSelect(args) {
      if (args.mode === 'clear') { this.selected = {}; return { selected: 0 }; }
      const rows = this.agentRows(args.filter);
      const sel = args.mode === 'add' || args.mode === 'remove' ? { ...this.selected } : {};
      for (const a of rows) { if (args.mode === 'remove') delete sel[a.id]; else sel[a.id] = true; }
      this.selected = sel;
      if (args.show_only) {
        this.resetFilters();
        this.search = rows.length <= 500 ? rows.map(a => a.email).join(' ') : '';
      }
      return { selected: Object.keys(sel).length, matched: rows.length, visible_selected: this.selectedIds.length };
    },
    agentSetTable(args) {
      if (args.sort_by !== undefined) {
        if (!args.sort_by) this.sort = { key: '', dir: 1 };
        else {
          const field = { status: 'status', group: 'group', notes: 'notes', updated: 'updated', updated_at: 'updated' }[args.sort_by];
          const key = field || this.agentColKey(args.sort_by) || args.sort_by;
          const col = this.allColumns.find(c => c.key === key);
          if (!col || !col.sort) throw new Error(`cannot sort by "${args.sort_by}"`);
          this.sort = { key, dir: args.sort_dir === 'desc' ? -1 : 1 };
        }
      }
      if (args.page_size) this.pageSize = [20, 50, 100, 200].includes(args.page_size) ? args.page_size : 50;
      if (args.page) { const p = Math.max(1, Math.min(args.page, this.pageCount)); nextTick(() => { this.page = p; }); }
      return { sort: this.sort, page_size: this.pageSize, pages: this.pageCount };
    },
    agentOpen(args) {
      const a = this.accounts.find(x => x.email.toLowerCase() === String(args.email || '').trim().toLowerCase());
      if (!a) return { error: `no account "${args.email}" in the current sheet` };
      if (args.view === 'inbox' || args.view === 'recovery_inbox') {
        const which = args.view === 'inbox' ? 'email' : 'recovery';
        if (!this.mailEligible(a, which)) return { error: 'this mailbox cannot be fetched (missing password / server settings)' };
        this.openInbox(a, which);
      } else this.openEdit(a);
      return { opened: args.view || 'edit', email: a.email };
    },
    agentPrefs(args) {
      if (args.theme) this.prefs.theme = args.theme;
      if (args.language && LANGUAGES.some(l => l.code === args.language)) this.prefs.lang = args.language;
      if (args.auto_lock_minutes != null) this.prefs.autoLock = Math.max(0, parseInt(args.auto_lock_minutes, 10) || 0);
      if (args.show_passwords != null) this.showPwd = !!args.show_passwords;
      return { theme: this.prefs.theme, language: this.prefs.lang, auto_lock_minutes: this.prefs.autoLock, show_passwords: this.showPwd };
    },

    // ---------- 新增 / 導入 ----------
    async agentAdd(list, opts) {
      if (opts.sheet) {
        const r = await this.agentManageSheets({ action: 'switch', name: opts.sheet, create: true });
        if (r.error) return r;
      }
      const invalid = [];
      const prepared = [];
      for (const raw of list) {
        const row = {};
        const email = String(raw.email || '').trim();
        if (!this.validEmail(email)) { invalid.push(raw.email || '(empty)'); continue; }
        for (const f of AGENT_TEXT_FIELDS) {
          if (raw[f] != null && raw[f] !== '') row[f] = this.agentTemplate(raw[f], { email }, null);
        }
        row.email = email;
        const columns = { ...(raw.columns || {}) };
        prepared.push({ row, columns, country: raw.country, status: raw.status || opts.status, group: raw.group ?? opts.group });
      }
      // 自定義列、國家列
      for (const p of prepared) {
        const extra = {};
        for (const [name, v] of Object.entries(p.columns)) {
          const col = await this.agentEnsureColumn(name, v);
          const value = this.agentColumnValue(col, this.agentTemplate(v, p.row, null));
          if (value) extra[col.id] = value;
        }
        if (p.country) {
          const col = await this.agentEnsureCountryColumn();
          extra[col.id] = this.agentColumnValue(col, p.country);
        }
        p.row.extra = extra;
      }
      // 按狀態 + 分組分批導入
      const buckets = new Map();
      for (const p of prepared) {
        const status = p.status ? this.agentStatusOrThrow(p.status) : this.meta.statuses[0];
        const gid = await this.agentGroupId(p.group, true);
        const key = status + '|' + gid;
        if (!buckets.has(key)) buckets.set(key, { status, gid, rows: [] });
        buckets.get(key).rows.push(p.row);
      }
      let added = 0, skipped = 0;
      const ids = [];
      for (const b of buckets.values()) {
        const r = await call('import_rows', this.sheetId, b.rows, b.gid, b.status, opts.skip_duplicates !== false, {});
        added += r.added; skipped += r.skipped; ids.push(...(r.ids || []));
      }
      const undoId = ids.length ? this.agentPushUndo(t('agent.tool.add_accounts') + ' ' + ids.length, { addedIds: ids }) : '';
      await this.loadAccounts();
      await this.refreshState();
      return { added, skipped, invalid, sheet: this.sheetName(this.currentSheet), undo_id: undoId };
    },
    async agentImportText(args) {
      const p = parseImport(args.text || '', 'auto', 'smart', []);
      const accounts = p.rows.map(({ country, ...r }) => ({ ...r, country, columns: args.columns }));
      const r = await this.agentAdd(accounts, args);
      return { ...r, failed: p.failed.map(f => ({ line: f.n, raw: f.raw, reason: t(f.reason[0], f.reason[1]) })) };
    },

    // ---------- 修改 / 刪除 / 移動 ----------
    async agentUpdate(args) {
      const index = this.agentIndexMap();
      const jobs = [];
      if (args.items?.length) {
        for (const it of args.items) {
          const email = String(it.email || '').trim().toLowerCase();
          jobs.push({ email, rows: this.accounts.filter(a => a.email.toLowerCase() === email), set: it.set || {}, columns: it.columns || {} });
        }
      } else {
        jobs.push({ rows: this.agentRows(args.filter), set: args.set || {}, columns: args.columns || {} });
      }
      const notFound = jobs.filter(j => j.email && !j.rows.length).map(j => j.email);
      const affected = [...new Map(jobs.flatMap(j => j.rows).map(a => [a.id, a])).values()];
      if (!affected.length) return { updated: 0, not_found: notFound };
      for (const job of jobs) if (job.set.status) this.agentStatusOrThrow(job.set.status);  // 先校驗，出錯不留撤銷記錄
      const serverSide = SELFMAIL && jobs.some(j => j.set.password != null || j.set.status != null);
      const undoId = serverSide ? '' : this.agentPushUndo(t('agent.tool.update_accounts') + ' ' + affected.length, { rows: this.agentSnapshot(affected) });
      for (const job of jobs) {
        if (!job.rows.length) continue;
        const ids = job.rows.map(a => a.id);
        const set = job.set;
        if (set.status != null && set.status !== '') await call('set_status', ids, this.agentStatusOrThrow(set.status));
        if (set.group != null) await call('set_group', ids, await this.agentGroupId(set.group, true));
        const fieldKeys = AGENT_TEXT_FIELDS.filter(f => set[f] != null);
        if (fieldKeys.length || set.append_notes) {
          await call('update_fields', job.rows.map(a => {
            const fields = {};
            for (const f of fieldKeys) fields[f] = this.agentTemplate(set[f], a, index);
            if (set.append_notes) fields.notes = [fields.notes ?? a.notes, this.agentTemplate(set.append_notes, a, index)].filter(Boolean).join('\n');
            return { id: a.id, fields };
          }));
        }
        for (const [name, value] of Object.entries(job.columns)) {
          const col = await this.agentEnsureColumn(name, value);
          const byValue = new Map();
          for (const a of job.rows) {
            const v = this.agentColumnValue(col, this.agentTemplate(value, a, index));
            if (!byValue.has(v)) byValue.set(v, []);
            byValue.get(v).push(a.id);
          }
          for (const [v, vids] of byValue) await call('set_extra', vids, col.id, v || null);
        }
      }
      await this.loadAccounts();
      await this.refreshState();
      return { updated: affected.length, not_found: notFound, undo_id: undoId };
    },
    async agentDelete(args) {
      const rows = this.agentRows(args.filter);
      if (!rows.length) return { deleted: 0 };
      const undoId = SELFMAIL ? '' : this.agentPushUndo(t('agent.tool.delete_accounts') + ' ' + rows.length, { rows: this.agentSnapshot(rows) });
      await call('delete_accounts', rows.map(a => a.id));
      for (const a of rows) delete this.selected[a.id];
      await this.loadAccounts();
      await this.refreshState();
      return { deleted: rows.length, undo_id: undoId };
    },
    async agentMove(args) {
      const rows = this.agentRows(args.filter);
      const name = String(args.sheet || '').trim();
      let sheet = this.agentSheet(name);
      if (!sheet) {
        await call('add_sheet', name);
        await this.refreshState();
        sheet = this.visibleSheets.find(s => s.name === name);
      }
      if (sheet.id === this.sheetId) return { moved: 0, sheet: name, note: 'already in this sheet' };
      const undoId = this.agentPushUndo(t('agent.tool.move_to_sheet') + ' ' + rows.length, { rows: this.agentSnapshot(rows) });
      await call('move_accounts', rows.map(a => a.id), sheet.id);
      this.selected = {};
      await this.loadAccounts();
      await this.refreshState();
      return { moved: rows.length, sheet: this.sheetName(sheet), undo_id: undoId };
    },

    // ---------- 列 / 分組 / 列表 ----------
    async agentManageColumns(args) {
      const cols = this.currentSheet.columns;
      const needCustom = () => {
        const col = this.agentColumn(args.name);
        if (!col) throw new Error(`no custom column "${args.name}" (built-in columns can only be shown/hidden/moved/resized)`);
        return col;
      };
      const needKey = name => {
        const key = this.agentColKey(name);
        if (!key) throw new Error(`no column "${name}"`);
        return key;
      };
      switch (args.action) {
        case 'list':
          return { columns: this.allColumns.map(c => ({ name: c.label, key: c.custom ? undefined : c.key, custom: !!c.custom, type: c.custom ? c.col.type : undefined,
            visible: this.isColumnVisible(c.key), width: this.colWidth(c) })) };
        case 'add': return this.agentAddColumn(args.name, args.type || this.agentGuessType(args.name, ''));
        case 'rename': case 'set_type': {
          const col = needCustom();
          const next = cols.map(c => (c.id !== col.id ? c : { ...c,
            name: args.action === 'rename' ? String(args.new_name || '').trim() || c.name : c.name,
            type: args.action === 'set_type' && COLUMN_TYPES.includes(args.type) ? args.type : c.type }));
          await call('set_sheet_columns', this.sheetId, next);
          await this.refreshState();
          return { ok: true, column: next.find(c => c.id === col.id) };
        }
        case 'delete': {
          const col = needCustom();
          // 列的值還留在數據庫裡，撤銷時把列加回來就恢復了
          const undoId = this.agentPushUndo(t('agent.tool.manage_columns') + ' ' + col.name, { columns: { sheetId: this.sheetId, columns: JSON.parse(JSON.stringify(cols)) } });
          await call('set_sheet_columns', this.sheetId, cols.filter(c => c.id !== col.id));
          await this.refreshState();
          return { deleted: col.name, undo_id: undoId };
        }
        case 'show': case 'hide': {
          const keys = (args.names?.length ? args.names : [args.name]).map(needKey);
          this.agentPushLayoutUndo();
          const visible = { ...this.prefs.visible };
          for (const k of keys) visible[k] = k === 'email' || args.action === 'show';
          this.prefs.visible = visible;
          return { visible: this.visibleColumns.map(c => c.label) };
        }
        case 'move': {
          const key = needKey(args.name);
          const keys = this.allColumns.map(c => c.key).filter(k => k !== key);
          let pos;
          if (args.before) pos = keys.indexOf(needKey(args.before));
          else if (args.after) pos = keys.indexOf(needKey(args.after)) + 1;
          else pos = Math.max(0, Math.min(keys.length, (parseInt(args.position, 10) || 1) - 1));
          keys.splice(pos, 0, key);
          const undoId = this.agentPushLayoutUndo();
          this.saveColumnOrder(keys);
          return { order: this.allColumns.map(c => c.label), undo_id: undoId };
        }
        case 'resize': {
          const key = needKey(args.name);
          this.agentPushLayoutUndo();
          this.prefs.colWidths = { ...this.prefs.colWidths, [key]: Math.max(MIN_COL_WIDTH, parseInt(args.width, 10) || 120) };
          return { ok: true };
        }
        case 'reset_layout': {
          this.agentPushLayoutUndo();
          const orders = { ...this.prefs.colOrders };
          delete orders[this.sheetId];
          delete orders._default;
          this.prefs.colOrders = orders;
          this.prefs.colWidths = {};
          return { ok: true };
        }
      }
      return { error: 'unknown action ' + args.action };
    },
    async agentManageGroups(args) {
      const find = () => {
        const g = this.groups.find(x => x.name.toLowerCase() === String(args.name || '').trim().toLowerCase());
        if (!g) throw new Error(`no group "${args.name}"`);
        return g;
      };
      switch (args.action) {
        case 'list': return { groups: this.groups.map(g => ({ name: g.name, color: g.color, count: g.count })) };
        case 'create': return { group_id: await this.agentGroupId(args.name, true, args.color), name: args.name };
        case 'rename': case 'recolor': {
          const g = find();
          await call('update_group', g.id, args.action === 'rename' ? String(args.new_name || g.name) : g.name,
            args.color ? this.agentColor(args.color) : g.color);
          await this.refreshState();
          return { ok: true };
        }
        case 'move': return this.agentMoveItem('groups', find(), args);
        case 'delete': {
          const g = find();
          await call('delete_group', g.id);
          if (this.filters.group === g.id) this.filters.group = '';
          await this.refreshState();
          await this.loadAccounts();
          return { deleted: g.name };
        }
      }
      return { error: 'unknown action ' + args.action };
    },
    // 列佈局（順序、顯示、寬度）改動前存快照，可撤銷
    agentPushLayoutUndo() {
      const { colOrders, visible, colWidths } = this.prefs;
      return this.agentPushUndo(t('agent.tool.manage_columns'), { prefs: JSON.parse(JSON.stringify({ colOrders, visible, colWidths })) });
    },
    // 調整分組 / 列表在側邊欄的順序
    async agentMoveItem(kind, item, args) {
      const list = kind === 'groups' ? this.groups : this.visibleSheets;
      const label = x => (kind === 'groups' ? x.name : this.sheetName(x));
      const findName = n => {
        const x = list.find(y => label(y).toLowerCase() === String(n).trim().toLowerCase() || y.name.toLowerCase() === String(n).trim().toLowerCase());
        if (!x) throw new Error(`no ${kind === 'groups' ? 'group' : 'sheet'} "${n}"`);
        return x;
      };
      const ids = list.map(x => x.id);
      const rest = ids.filter(id => id !== item.id);
      let pos;
      if (args.before) pos = rest.indexOf(findName(args.before).id);
      else if (args.after) pos = rest.indexOf(findName(args.after).id) + 1;
      else if (args.offset) pos = ids.indexOf(item.id) + parseInt(args.offset, 10);
      else {
        const p = parseInt(args.position, 10) || 1;
        pos = p < 0 ? rest.length + 1 + p : p - 1;
      }
      pos = Math.max(0, Math.min(rest.length, pos));
      rest.splice(pos, 0, item.id);
      const undoId = this.agentPushUndo(t('agent.tool.manage_' + kind) + ' ' + label(item), { order: { kind, ids } });
      await call('reorder', kind, rest);
      await this.refreshState();
      const now = kind === 'groups' ? this.groups : this.visibleSheets;
      return { order: now.map(label), undo_id: undoId };
    },
    async agentManageSheets(args) {
      const name = String(args.name || '').trim();
      switch (args.action) {
        case 'list': return { current: this.sheetName(this.currentSheet), sheets: this.visibleSheets.map(s => ({ name: this.sheetName(s), count: s.count })) };
        case 'create': {
          if (this.agentSheet(name)) return { exists: true, name };
          await call('add_sheet', name);
          await this.refreshState();
          return { created: name };
        }
        case 'move': {
          const s = this.agentSheet(name);
          if (!s) return { error: `no sheet "${name}"`, sheets: this.visibleSheets.map(x => this.sheetName(x)) };
          return this.agentMoveItem('sheets', s, args);
        }
        case 'rename': {
          const s = this.agentSheet(name);
          if (!s) return { error: `no sheet "${name}"` };
          await call('rename_sheet', s.id, String(args.new_name || '').trim() || s.name);
          await this.refreshState();
          return { ok: true };
        }
        case 'switch': {
          let s = this.agentSheet(name);
          if (!s && args.create) { await call('add_sheet', name); await this.refreshState(); s = this.agentSheet(name); }
          if (!s) return { error: `no sheet "${name}"`, sheets: this.visibleSheets.map(x => this.sheetName(x)) };
          if (s.id !== this.sheetId) {
            this.sheetId = s.id;
            this.selected = {};
            this.page = 1;
            await this.loadAccounts();
          }
          return { sheet: this.sheetName(s), total: this.accounts.length, columns: this.currentSheet.columns.map(c => c.name) };
        }
        case 'delete': {
          const s = this.agentSheet(name);
          if (!s) return { error: `no sheet "${name}"` };
          if (this.visibleSheets.length <= 1) return { error: t('err.keep_one_sheet') };
          const rows = await call('list_accounts', s.id);
          const undoId = this.agentPushUndo(t('agent.tool.manage_sheets') + ' ' + this.sheetName(s),
            { rows, sheet: { name: s.name, columns: JSON.parse(JSON.stringify(s.columns)) } });
          await call('delete_sheet', s.id);
          await this.reload();
          return { deleted: this.sheetName(s), accounts: rows.length, undo_id: undoId };
        }
      }
      return { error: 'unknown action ' + args.action };
    },

    // ---------- 2FA / 收信 / 複製 ----------
    async agent2fa(args) {
      const rows = this.agentRows(args.filter).filter(a => a.totp_secret).slice(0, 200);
      const codes = rows.length ? await call('totp_codes', rows.map(a => a.totp_secret)) : {};
      return { seconds_left: 30 - (Math.floor(Date.now() / 1000) % 30),
        codes: rows.map(a => ({ email: a.email, code: codes[a.totp_secret] || '' })) };
    },
    async agentFetchMail(args) {
      const a = this.accounts.find(x => x.email.toLowerCase() === String(args.email || '').trim().toLowerCase());
      if (!a) return { error: `no account "${args.email}" in the current sheet` };
      const which = args.which === 'email' ? 'email' : 'recovery';
      const limit = Math.min(50, Math.max(1, parseInt(args.limit, 10) || 5));
      const r = await call('fetch_mail', a.id, which, limit);
      return { address: r.address, total: r.total, messages: r.messages.slice(0, limit).map(m => ({
        from: m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr, subject: m.subject, date: this.fmtDate(m.date),
        folder: m.folder, codes: m.codes, text: (m.text || '').slice(0, 600) })) };
    },
    async agentCreateMailboxes(args) {
      const gid = args.group ? await this.agentGroupId(args.group, true) : null;
      const r = await call('selfmail_create', args.domain || '', args.names || [], parseInt(args.count, 10) || 0, args.prefix || '',
        args.password || '', gid, null);
      await this.loadAccounts();
      await this.refreshState();
      return { created: r.created.map(x => x.email), failed: r.failed,
        note: 'passwords are saved in the table; use copy_to_clipboard to copy email----password' };
    },
    agentCopy(args) {
      const rows = this.agentRows(args.filter);
      const fields = args.fields?.length ? args.fields : ['email', 'password', 'totp_secret', 'recovery_email'];
      const sep = args.separator ?? '----';
      const val = (a, f) => {
        const v = this.agentField(a, f);
        if (v === undefined) throw new Error(`unknown field "${f}"`);
        return f === 'status' ? this.statusLabel(v) : String(v ?? '');
      };
      this.copy(rows.map(a => fields.map(f => val(a, f)).join(sep)).join('\n'), t('copy.rows', { n: rows.length }), true);
      return { copied: rows.length, fields };
    },
  },
};
