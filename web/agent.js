/* AI 助手：用自然語言讓 AI 查詢、統計、篩選、搜索、勾選、改分組/狀態/字段、加列賦值、移動、複製導出、創建自建郵箱。

   對話循環在前端：後台只負責一輪流式請求（ai_chat_start），模型要調用的工具在這裡執行，結果發回給模型，直到模型給出回答。
   隱私：發給 AI 的數據不含密碼、2FA 密鑰、令牌（只有 has_xxx 標記）；需要明文的操作（複製、導出）在本地完成。
   修改數據的工具默認先在對話裡讓用戶確認（可勾選「自動執行」跳過）。 */

const AGENT_MAX_STEPS = 15;
const AGENT_TEXT_FIELDS = ['email', 'password', 'totp_secret', 'recovery_email', 'recovery_password',
  'oauth_client_id', 'oauth_token', 'phone', 'notes'];
const AGENT_SECRET_FIELDS = ['password', 'totp_secret', 'recovery_password', 'oauth_token'];
const AGENT_WRITE_TOOLS = ['update_accounts', 'move_to_sheet', 'create_recovery_mailboxes'];
// 顏色標記列可以用顏色名賦值
const COLOR_NAMES = {
  red: '#e5484d', 紅: '#e5484d', 红: '#e5484d', orange: '#f76b15', 橙: '#f76b15', yellow: '#f5a524', 黃: '#f5a524', 黄: '#f5a524',
  green: '#30a46c', 綠: '#30a46c', 绿: '#30a46c', teal: '#12a594', 青: '#12a594', sky: '#0ea5e9', cyan: '#0ea5e9', 天藍: '#0ea5e9', 天蓝: '#0ea5e9',
  blue: '#4f7cff', 藍: '#4f7cff', 蓝: '#4f7cff', purple: '#8e4ec6', 紫: '#8e4ec6', pink: '#e93d82', 粉: '#e93d82',
  brown: '#8b5e3c', 棕: '#8b5e3c', gray: '#64748b', grey: '#64748b', 灰: '#64748b', black: '#1f2937', 黑: '#1f2937',
};

const AGENT_FILTER = {
  type: 'object',
  description: '選擇郵箱的條件，全部同時滿足。不傳 = 當前列表的全部郵箱。',
  properties: {
    scope: { type: 'string', enum: ['all', 'view', 'selected'], description: 'all=當前列表全部（默認）；view=表格當前篩選/搜索後顯示的；selected=表格裡勾選的' },
    rows: { type: 'object', description: '表格「序號」範圍（按當前顯示順序，含首尾），例如第 1 到 10 行', properties: { from: { type: 'integer' }, to: { type: 'integer' } } },
    emails: { type: 'array', items: { type: 'string' }, description: '主郵箱地址列表（不分大小寫）' },
    ids: { type: 'array', items: { type: 'integer' } },
    search: { type: 'string', description: '和搜索框一樣的關鍵詞搜索（郵箱/輔助郵箱/備註/手機/自定義列，忽略 . _ - 符號）' },
    conditions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', description: 'email, recovery_email, recovery_domain, domain, phone, notes, status, group, password, totp_secret, recovery_password, oauth_token, created_at, updated_at，或自定義列名。密碼類字段只能用 empty / not_empty' },
          op: { type: 'string', enum: ['eq', 'ne', 'contains', 'not_contains', 'starts_with', 'ends_with', 'empty', 'not_empty', 'regex', 'gt', 'lt', 'in'] },
          value: { description: '比較值；in 用數組；日期用 YYYY-MM-DD' },
        },
        required: ['field', 'op'],
      },
    },
  },
};

const AGENT_SET = {
  type: 'object',
  description: '要修改的字段。字符串值可用模板 {email} {user}（郵箱用戶名）{domain} {index}（序號）按每行替換',
  properties: {
    status: { type: 'string' }, group: { type: 'string', description: '分組名，不存在會自動創建；空字符串 = 移出分組' },
    notes: { type: 'string' }, append_notes: { type: 'string', description: '追加到備註末尾（換行分隔）' },
    phone: { type: 'string' }, email: { type: 'string' }, recovery_email: { type: 'string' }, recovery_password: { type: 'string' },
    password: { type: 'string' }, totp_secret: { type: 'string' }, oauth_client_id: { type: 'string' }, oauth_token: { type: 'string' },
  },
};
const AGENT_COLUMNS = {
  type: 'object', additionalProperties: true,
  description: '自定義列賦值：{ "列名": 值 }，列不存在會自動新建。國家列填國家代碼或名稱，顏色列填 #hex 或顏色名（紅/藍/red…），空字符串 = 清空',
};

const agentFn = (name, description, properties = {}, required = []) =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

const AGENT_TOOLS = [
  agentFn('get_accounts', '查詢郵箱，返回不含密碼的字段和總數', {
    filter: AGENT_FILTER,
    fields: { type: 'array', items: { type: 'string' }, description: '只返回這些字段（默認常用字段 + 自定義列）' },
    limit: { type: 'integer', description: '默認 50，最多 200' }, offset: { type: 'integer' },
  }),
  agentFn('count_accounts', '統計數量，可按字段分組計數（domain、status、group、recovery_domain、自定義列名等）', {
    filter: AGENT_FILTER, group_by: { type: 'string' },
  }),
  agentFn('set_view', '設置表格的篩選和搜索框，讓用戶看到結果。只傳要改的項；clear=true 先清除所有篩選', {
    clear: { type: 'boolean' }, search: { type: 'string' }, status: { type: 'string' }, group: { type: 'string', description: '分組名；"none" = 未分組' },
    domain: { type: 'string', description: '主郵箱域名，例如 gmail.com' }, has_2fa: { type: 'string', enum: ['', 'yes', 'no'] },
    has_recovery: { type: 'string', enum: ['', 'yes', 'no'] }, country: { type: 'string', description: '國家，多個用 / 分隔' },
  }),
  agentFn('select_rows', '在表格裡勾選郵箱（之後用戶可以用批量操作欄）。show_only=true 時把搜索框設成這些郵箱，只顯示它們', {
    filter: AGENT_FILTER, mode: { type: 'string', enum: ['replace', 'add', 'clear'] }, show_only: { type: 'boolean' },
  }),
  agentFn('update_accounts', '修改郵箱：狀態、分組、備註、字段、自定義列值。對 filter 選中的郵箱統一修改，或用 items 給每個郵箱分別賦值', {
    filter: AGENT_FILTER, set: AGENT_SET, columns: AGENT_COLUMNS,
    items: { type: 'array', description: '分別賦值', items: { type: 'object', properties: { email: { type: 'string' }, set: AGENT_SET, columns: AGENT_COLUMNS }, required: ['email'] } },
  }),
  agentFn('add_column', '給當前列表新增自定義列', {
    name: { type: 'string' }, type: { type: 'string', enum: ['text', 'color', 'country', 'emoji', 'image'], description: '默認 text' },
  }, ['name']),
  agentFn('create_group', '新建分組', { name: { type: 'string' }, color: { type: 'string', description: '#hex，可省略' } }, ['name']),
  agentFn('move_to_sheet', '把郵箱移動到另一個列表，列表不存在時自動創建', { filter: AGENT_FILTER, sheet: { type: 'string' } }, ['sheet']),
  agentFn('switch_sheet', '切換表格顯示的列表（之後的操作都針對這個列表）', { name: { type: 'string' } }, ['name']),
  agentFn('copy_to_clipboard', '在本地把郵箱數據複製到剪貼板（可以包含密碼等，不會發給 AI）', {
    filter: AGENT_FILTER, fields: { type: 'array', items: { type: 'string' }, description: '默認 email,password,totp_secret,recovery_email' },
    separator: { type: 'string', description: '默認 ----' },
  }),
  agentFn('export_accounts', '在本地導出文件（CSV 或 TXT，包含密碼），會彈出保存對話框', { filter: AGENT_FILTER, format: { type: 'string', enum: ['csv', 'txt'] } }),
  agentFn('create_recovery_mailboxes', '用 BillionMail 管理員權限，給郵箱在自建域名下創建同名的輔助郵箱（隨機密碼）並保存；已有輔助郵箱的默認跳過', {
    filter: AGENT_FILTER, domain: { type: 'string' }, overwrite: { type: 'boolean' },
  }, ['domain']),
];

const AgentMixin = {
  data() {
    return { agent: { open: false, items: [], history: [], input: '', busy: false, stop: false } };
  },

  computed: {
    agentExamples() { return [1, 2, 3, 4].map(i => t('agent.ex' + i)); },
  },

  methods: {
    toggleAgent() {
      this.agent.open = !this.agent.open;
      if (this.agent.open) nextTick(() => this.$refs.agentInput?.focus());
    },
    agentClear() {
      this.agentStop();
      Object.assign(this.agent, { items: [], history: [], busy: false, stop: false });
    },
    agentStop() {
      if (!this.agent.busy) return;
      this.agent.stop = true;
      for (const m of this.agent.items) for (const tc of m.tools || []) if (tc.status === 'confirm') tc.resolve(false);
    },
    agentScroll() { nextTick(() => { const el = this.$refs.agentMsgs; if (el) el.scrollTop = el.scrollHeight; }); },
    agentToolLabel(name) { return t('agent.tool.' + name); },

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

    async agentLoop() {
      const agent = this.agent;
      for (let step = 0; step < AGENT_MAX_STEPS; step++) {
        agent.items.push({ role: 'assistant', text: '', tools: [], streaming: true, error: '' });
        const item = agent.items[agent.items.length - 1];  // 響應式代理
        const messages = [{ role: 'system', content: this.agentSystemPrompt() }, ...agent.history];
        let result;
        try {
          const job = await call('ai_chat_start', messages, AGENT_TOOLS);
          result = await pollAiJob(job, d => { item.text += d; this.agentScroll(); }, () => agent.stop);
        } catch (e) {
          item.error = errText(e);
          item.streaming = false;
          return;
        }
        item.streaming = false;
        const calls = result.tool_calls || [];
        if (result.stopped) return;
        agent.history.push(calls.length
          ? { role: 'assistant', content: item.text || null, tool_calls: calls }
          : { role: 'assistant', content: item.text });
        if (!calls.length) return;
        for (const c of calls) {
          const tc = { name: c.function.name, status: 'running', summary: '', desc: '', resolve: null };
          item.tools.push(tc);
          const proxy = item.tools[item.tools.length - 1];
          this.agentScroll();
          let out;
          if (agent.stop) out = { error: 'stopped by user' };
          else {
            try {
              const args = JSON.parse(c.function.arguments || '{}');
              out = await this.agentExec(proxy, c.function.name, args);
            } catch (e) {
              out = { error: errText(e) };
            }
          }
          proxy.status = out.error ? 'error' : 'done';
          proxy.summary = out.error ? String(out.error) : this.agentSummary(c.function.name, out);
          agent.history.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(out).slice(0, 30000) });
        }
        if (agent.stop) return;
      }
    },

    agentSummary(name, out) {
      if (out.declined) return t('agent.declined');
      if (name === 'get_accounts') return t('agent.sum.found', { n: out.total });
      if (name === 'count_accounts') return t('agent.sum.found', { n: out.total });
      if (name === 'set_view') return t('agent.sum.view', { n: out.visible });
      if (name === 'select_rows') return t('agent.sum.selected', { n: out.selected });
      if (name === 'update_accounts') return t('agent.sum.updated', { n: out.updated });
      if (name === 'move_to_sheet') return t('agent.sum.moved', { n: out.moved, s: out.sheet });
      if (name === 'copy_to_clipboard') return t('agent.sum.copied', { n: out.copied });
      if (name === 'export_accounts') return t('agent.sum.exported', { n: out.exported });
      if (name === 'create_recovery_mailboxes') return t('agent.sum.mailboxes', { n: out.created?.length || 0, f: out.failed?.length || 0 });
      return '✓';
    },

    agentSystemPrompt() {
      const ctx = {
        today: new Date().toISOString().slice(0, 10),
        ui_language: ui.lang,
        sheet: this.sheetName(this.currentSheet),
        sheets: this.sheets.map(s => ({ name: this.sheetName(s), count: s.count })),
        base_fields: ['email', 'password', 'totp_secret', 'recovery_email', 'recovery_password', 'phone', 'status', 'group', 'notes', 'oauth_client_id', 'oauth_token'],
        custom_columns: this.currentSheet.columns.map(c => ({ name: c.name, type: c.type })),
        groups: this.groups.map(g => g.name),
        statuses: this.meta.statuses.map(s => this.statusLabel(s)),
        total_in_sheet: this.accounts.length,
        table_view: { shown: this.sorted.length, search: this.search, filters: this.filters, sort: this.sort },
        selected: this.accounts.filter(a => this.selected[a.id]).length,
        top_domains: this.domains.slice(0, 15),
        self_hosted_domains: this.selfDomains,
      };
      return `你是「郵箱管理」軟件裡的 AI 助手，通過調用工具幫用戶管理郵箱賬號：查詢、統計、篩選、搜索、勾選、修改狀態/分組/備註/字段、新增列並賦值、移動列表、複製/導出、創建自建輔助郵箱。
規則：
- 「這些 / 選中的」指表格裡勾選的行（filter.scope=selected）；「當前顯示的」用 scope=view；「第 3 到 10 個」用 filter.rows 序號範圍。
- 不確定數據時先用 get_accounts / count_accounts 查清楚再修改。修改類工具調用後界面會讓用戶確認，你不需要先在對話裡詢問。
- 你看不到密碼、2FA 密鑰、令牌（只有 has_xxx 標記）；需要這些明文的操作用 copy_to_clipboard / export_accounts 在本地完成，不要讓用戶把密碼發給你。
- 用戶想「看 / 找 / 篩選 / 搜索」時，用 set_view 或 select_rows(show_only=true) 把結果顯示在表格裡。
- 字符串值可以用模板 {email} {user} {domain} {index}，按每行替換。
- 回答簡潔，使用用戶的語言；完成後說明做了什麼、影響了多少條。不要編造工具沒返回的數據。
當前狀態：${JSON.stringify(ctx)}`;
    },

    // ---------- 執行工具 ----------
    async agentExec(tc, name, args) {
      if (AGENT_WRITE_TOOLS.includes(name) && !this.prefs.agentAuto) {
        tc.desc = this.agentDescribe(name, args);
        tc.status = 'confirm';
        this.agentScroll();
        const ok = await new Promise(resolve => { tc.resolve = resolve; });
        tc.status = 'running';
        if (!ok) return { declined: true, error: 'user declined this operation' };
      }
      switch (name) {
        case 'get_accounts': return this.agentGet(args);
        case 'count_accounts': return this.agentCount(args);
        case 'set_view': return this.agentSetView(args);
        case 'select_rows': return this.agentSelect(args);
        case 'update_accounts': return this.agentUpdate(args);
        case 'add_column': return this.agentAddColumn(args.name, args.type);
        case 'create_group': return { group_id: await this.agentGroupId(args.name, true, args.color) };
        case 'move_to_sheet': return this.agentMove(args);
        case 'switch_sheet': return this.agentSwitchSheet(args.name);
        case 'copy_to_clipboard': return this.agentCopy(args);
        case 'export_accounts': {
          const rows = this.agentRows(args.filter);
          await this.doExport(args.format === 'txt' ? 'txt' : 'csv', rows);
          return { exported: rows.length };
        }
        case 'create_recovery_mailboxes': {
          const ids = this.agentRows(args.filter).map(a => a.id);
          const r = await call('create_recovery_mailboxes', ids, args.domain, !!args.overwrite);
          await this.loadAccounts();
          return r;
        }
        default: return { error: 'unknown tool ' + name };
      }
    },

    // 給用戶確認的說明：影響多少條 + 改什麼
    agentDescribe(name, args) {
      const label = k => (k === 'append_notes' ? t('col.notes') + ' +' : (t('col.' + k) !== 'col.' + k ? t('col.' + k) : k));
      const kv = obj => Object.entries(obj || {}).map(([k, v]) => `${label(k)} = ${v === '' ? '∅' : v}`).join('，');
      try {
        if (name === 'update_accounts') {
          if (args.items?.length) return t('agent.confirm.items', { n: args.items.length }) + '\n' +
            args.items.slice(0, 8).map(it => `${it.email}：${[kv(it.set), kv(it.columns)].filter(Boolean).join('，')}`).join('\n') +
            (args.items.length > 8 ? '\n…' : '');
          const n = this.agentRows(args.filter).length;
          return t('agent.confirm.update', { n }) + '\n' + [kv(args.set), kv(args.columns)].filter(Boolean).join('，');
        }
        if (name === 'move_to_sheet') return t('agent.confirm.move', { n: this.agentRows(args.filter).length, s: args.sheet });
        if (name === 'create_recovery_mailboxes') return t('agent.confirm.mailbox', { n: this.agentRows(args.filter).length, d: args.domain });
      } catch (e) { return errText(e); }
      return name;
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
    agentStatus(v) {
      const s = String(v ?? '').trim().toLowerCase();
      return this.meta.statuses.find(st => st.toLowerCase() === s || this.statusLabel(st).toLowerCase() === s ||
        Object.values(I18N).some(dict => (dict['status.' + this.statusIndex(st)] || '').toLowerCase() === s)) || '';
    },
    // 字段的值（用於篩選、統計），undefined = 沒有這個字段
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
      let v = this.agentField(a, field);
      if (v === undefined) throw new Error(`unknown field "${field}"`);
      const op = c.op;
      if (AGENT_SECRET_FIELDS.includes(field) && !['empty', 'not_empty'].includes(op)) throw new Error(`${field} only supports empty / not_empty`);
      if (op === 'empty') return !v;
      if (op === 'not_empty') return !!v;
      let want = c.value;
      // 值的規範化：狀態用內部值，國家列用代碼，日期轉時間戳
      const norm = x => {
        if (field === 'status') return this.agentStatus(x) || String(x);
        const col = this.agentColumn(field);
        if (col?.type === 'country') return countryFromText(String(x)) || String(x).toUpperCase();
        if (field === 'created_at' || field === 'updated_at') return Math.floor(Date.parse(x) / 1000) || 0;
        return x;
      };
      if (op === 'gt' || op === 'lt') {
        const w = norm(want);
        const [x, y] = typeof v === 'number' ? [v, Number(w)] : [String(v), String(w)];
        return op === 'gt' ? x > y : x < y;
      }
      if (op === 'regex') return new RegExp(String(want), 'i').test(String(v));
      const s = String(v).toLowerCase();
      if (op === 'in') return (Array.isArray(want) ? want : String(want).split(/[,，]/)).some(x => String(norm(x)).toLowerCase() === s);
      want = String(norm(want ?? '')).toLowerCase();
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
    // 發給 AI 的一行數據：不含密碼類明文
    agentRowOut(a, fields, index) {
      const out = { id: a.id };
      if (index.has(a.id)) out.index = index.get(a.id);
      const all = !fields?.length;
      const want = f => all || fields.includes(f);
      for (const f of ['email', 'recovery_email', 'phone', 'oauth_client_id']) if (want(f) && (a[f] || !all)) out[f] = a[f] || '';
      if (want('status')) out.status = this.statusLabel(a.status);
      if (want('group')) out.group = this.groupMap[a.group_id]?.name || '';
      if (want('notes') && (a.notes || !all)) out.notes = (a.notes || '').slice(0, 200);
      for (const f of AGENT_SECRET_FIELDS) if (want(f) || want('has_' + f)) out['has_' + f] = !!a[f];
      if (want('updated_at')) out.updated_at = this.fmtDate(a.updated_at);
      if (want('created_at')) out.created_at = this.fmtDate(a.created_at);
      for (const col of this.currentSheet.columns) {
        if (!want(col.name)) continue;
        const v = a.extra?.[col.id];
        if (v || !all) out[col.name] = col.type === 'image' ? (v ? '[image]' : '') : (v || '');
      }
      return out;
    },

    // ---------- 各個工具 ----------
    agentGet(args) {
      const rows = this.agentRows(args.filter);
      const limit = Math.min(200, Math.max(1, parseInt(args.limit, 10) || 50));
      const offset = Math.max(0, parseInt(args.offset, 10) || 0);
      const index = this.agentIndexMap();
      return { total: rows.length, offset, rows: rows.slice(offset, offset + limit).map(a => this.agentRowOut(a, args.fields, index)) };
    },
    agentCount(args) {
      const rows = this.agentRows(args.filter);
      if (!args.group_by) return { total: rows.length };
      const counts = {};
      for (const a of rows) {
        let v = this.agentField(a, args.group_by);
        if (v === undefined) throw new Error(`unknown field "${args.group_by}"`);
        if (args.group_by === 'status') v = this.statusLabel(v);
        if (AGENT_SECRET_FIELDS.includes(args.group_by)) v = v ? 'yes' : 'no';
        counts[v || '(empty)'] = (counts[v || '(empty)'] || 0) + 1;
      }
      const groups = Object.entries(counts).sort((x, y) => y[1] - x[1]).slice(0, 100).map(([value, count]) => ({ value, count }));
      return { total: rows.length, groups };
    },
    agentSetView(args) {
      if (args.clear) this.resetFilters();
      const f = { ...this.filters };
      if (args.status !== undefined) f.status = args.status ? (this.agentStatus(args.status) || '') : '';
      if (args.group !== undefined) {
        const g = this.groups.find(x => x.name.toLowerCase() === String(args.group).toLowerCase());
        f.group = !args.group ? '' : (args.group === 'none' ? 'none' : (g ? g.id : f.group));
      }
      if (args.domain !== undefined) f.domain = String(args.domain || '').toLowerCase();
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
      const sel = args.mode === 'add' ? { ...this.selected } : {};
      for (const a of rows) sel[a.id] = true;
      this.selected = sel;
      if (args.show_only) {
        this.resetFilters();
        this.search = rows.length <= 500 ? rows.map(a => a.email).join(' ') : '';
      }
      return { selected: rows.length, visible_selected: this.selectedIds.length };
    },
    agentTemplate(v, a, index) {
      return String(v ?? '').replace(/\{(email|user|domain|index)\}/g, (_, k) =>
        k === 'email' ? a.email : k === 'user' ? a.email.split('@')[0] : k === 'domain' ? domainOf(a.email) : String(index.get(a.id) || ''));
    },
    agentColumnValue(col, v) {
      v = String(v ?? '').trim();
      if (!v) return '';
      if (col.type === 'country') {
        const code = countryFromText(v) || (COUNTRY_CODES.includes(v.toUpperCase()) ? v.toUpperCase() : '');
        if (!code) throw new Error(`unknown country "${v}"`);
        return code;
      }
      if (col.type === 'color') {
        if (/^#[0-9a-f]{3,8}$/i.test(v)) return v;
        const c = COLOR_NAMES[v.toLowerCase()] || COLOR_NAMES[v.replace(/色$/, '')];
        if (!c) throw new Error(`unknown color "${v}"`);
        return c;
      }
      if (col.type === 'image') throw new Error('image columns cannot be set by AI');
      return v;
    },
    // 自動新建列時按列名和值猜類型：國家 / 顏色，其他為文本
    agentGuessType(name, value) {
      const n = String(name).toLowerCase(), v = String(value ?? '').trim();
      if (/國家|国家|地區|地区|country|region|国/.test(n) && (!v || countryFromText(v))) return 'country';
      if (/顏色|颜色|色|color|colour|標記|标记/.test(n) && (!v || /^#[0-9a-f]{3,8}$/i.test(v) || COLOR_NAMES[v.toLowerCase()] || COLOR_NAMES[v.replace(/色$/, '')])) return 'color';
      return 'text';
    },
    async agentGroupId(name, create, color) {
      name = String(name ?? '').trim();
      if (!name || name === 'none') return null;
      const g = this.groups.find(x => x.name.toLowerCase() === name.toLowerCase());
      if (g) return g.id;
      if (!create) throw new Error(`unknown group "${name}"`);
      const id = await call('add_group', name, color || this.randomColor());
      await this.refreshState();
      return id;
    },
    async agentAddColumn(name, type) {
      name = String(name || '').trim();
      if (!name) throw new Error('column name required');
      const existing = this.agentColumn(name);
      if (existing) return { column: existing.name, existed: true };
      const col = { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name,
        type: COLUMN_TYPES.includes(type) ? type : 'text' };
      await call('set_sheet_columns', this.sheetId, [...this.currentSheet.columns, col]);
      await this.refreshState();
      return { column: name, type: col.type, created: true };
    },
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
      const touched = new Set();
      for (const job of jobs) {
        if (!job.rows.length) continue;
        const ids = job.rows.map(a => a.id);
        const set = job.set;
        if (set.status != null && set.status !== '') {
          const st = this.agentStatus(set.status);
          if (!st) throw new Error(`unknown status "${set.status}", use one of: ${this.meta.statuses.map(s => this.statusLabel(s)).join(', ')}`);
          await call('set_status', ids, st);
        }
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
          if (!this.agentColumn(name)) await this.agentAddColumn(name, this.agentGuessType(name, value));
          const col = this.agentColumn(name);
          const byValue = new Map();
          for (const a of job.rows) {
            const v = this.agentColumnValue(col, this.agentTemplate(value, a, index));
            if (!byValue.has(v)) byValue.set(v, []);
            byValue.get(v).push(a.id);
          }
          for (const [v, vids] of byValue) await call('set_extra', vids, col.id, v || null);
        }
        ids.forEach(id => touched.add(id));
      }
      await this.loadAccounts();
      await this.refreshState();
      return { updated: touched.size, not_found: notFound };
    },
    async agentMove(args) {
      const rows = this.agentRows(args.filter);
      const name = String(args.sheet || '').trim();
      let sheet = this.sheets.find(s => this.sheetName(s).toLowerCase() === name.toLowerCase() || s.name.toLowerCase() === name.toLowerCase());
      if (!sheet) {
        await call('add_sheet', name);
        await this.refreshState();
        sheet = this.sheets.find(s => s.name === name);
      }
      if (sheet.id === this.sheetId) return { moved: 0, sheet: name, note: 'already in this sheet' };
      await call('move_accounts', rows.map(a => a.id), sheet.id);
      this.selected = {};
      await this.loadAccounts();
      await this.refreshState();
      return { moved: rows.length, sheet: this.sheetName(sheet) };
    },
    async agentSwitchSheet(name) {
      const n = String(name || '').trim().toLowerCase();
      const sheet = this.sheets.find(s => this.sheetName(s).toLowerCase() === n || s.name.toLowerCase() === n);
      if (!sheet) return { error: `no sheet named "${name}"`, sheets: this.sheets.map(s => this.sheetName(s)) };
      if (sheet.id !== this.sheetId) {
        this.sheetId = sheet.id;
        this.selected = {};
        this.page = 1;
        await this.loadAccounts();
      }
      return { sheet: this.sheetName(sheet), total: this.accounts.length, columns: this.currentSheet.columns.map(c => c.name) };
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
