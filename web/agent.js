/* AI 助手（agent）：用自然語言讓 AI 直接操作這個軟件——查詢統計、篩選搜索排序、新增/導入/修改/刪除郵箱、
   管理列/分組/列表、查看 2FA 驗證碼和收信、複製導出、創建自建郵箱、改設置、撤銷。

   對話循環在前端：後台只負責一輪流式請求（ai_chat_start），模型要調用的工具在這裡執行，結果發回給模型，直到模型給出回答。
   隱私：默認不把密碼、2FA 密鑰、令牌發給 AI（只有 has_xxx 標記），用戶可在面板裡勾選「允許讀取密碼」。
   安全：修改類操作默認先在對話裡確認（可勾選「自動執行」）；刪除類操作總是確認；修改前保存快照，可以撤銷。 */

const AGENT_MAX_STEPS = 30;
const AGENT_HISTORY_LIMIT = 150000;  // 對話歷史超過這麼多字符就丟掉最早的幾輪
const AGENT_UNDO_LIMIT = 30;
const AGENT_MAX_IMAGES = 4;  // 每條消息最多附幾張圖
const AGENT_IMAGE_MAX = 1280;  // 圖片縮到這個邊長再發送和保存
const AGENT_TEXT_FIELDS = ['email', 'password', 'totp_secret', 'backup_codes', 'recovery_email', 'recovery_password',
  'oauth_client_id', 'oauth_token', 'phone', 'notes'];
const AGENT_SECRET_FIELDS = ['password', 'totp_secret', 'backup_codes', 'recovery_password', 'oauth_token'];
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
    scan_id: { type: 'string', description: 'fs_scan_accounts 返回的 scan_id：只選這次從文件裡統計到的郵箱' },
    search: { type: 'string', description: '和搜索框一樣的關鍵詞搜索（郵箱/輔助郵箱/備註/手機/自定義列，忽略 . _ - 符號；多個郵箱用空格分隔 = 任一匹配）' },
    conditions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', description: 'email, recovery_email, recovery_domain, domain, phone, notes, status, group, family（家庭組名）, family_role（owner=組長 / member=成員 / 空=沒加入）, password, totp_secret, recovery_password, oauth_client_id, oauth_token, created_at, updated_at，或自定義列名' },
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
    group: { type: 'string', description: '只放在這一個分組（替換原有的所有分組），不存在自動創建；空字符串 = 移出所有分組' },
    groups: { type: 'array', items: AGENT_STR, description: '只放在這幾個分組（替換原有的）' },
    add_groups: { type: 'array', items: AGENT_STR, description: '加入這些分組（保留原有分組），不存在自動創建' },
    remove_groups: { type: 'array', items: AGENT_STR, description: '移出這些分組（其他分組保留）' },
    append_notes: { type: 'string', description: '追加到備註末尾（換行分隔）' },
  },
};
// 只改字段裡的一部分文字：不會覆蓋整個字段
const AGENT_EDITS = {
  type: 'array',
  description: '局部修改文字（不覆蓋整個字段）：replace 把 find 換成 value；remove 刪掉 find；prepend / append 在開頭 / 末尾加上 value。' +
    'regex=true 時 find 是正則（value 裡可用 $1）。field 可以是 notes、phone、recovery_email 等字段或自定義列名',
  items: {
    type: 'object',
    properties: {
      field: { type: 'string' }, op: { type: 'string', enum: ['replace', 'remove', 'prepend', 'append'] },
      find: { type: 'string' }, value: { type: 'string' }, regex: { type: 'boolean' }, ignore_case: { type: 'boolean' },
    },
    required: ['field', 'op'],
  },
};
const AGENT_COLUMNS = {
  type: 'object', additionalProperties: true,
  description: '自定義列賦值 { "列名": 值 }，列不存在會自動新建。國家列填代碼或國名，顏色列填 #hex 或顏色名，空字符串 = 清空',
};
const AGENT_NEW_ACCOUNT = {
  type: 'object',
  properties: { ...AGENT_ACCOUNT_FIELDS, status: AGENT_STR, group: AGENT_STR, groups: { type: 'array', items: AGENT_STR, description: '加入多個分組' }, country: { type: 'string', description: '國家/地區，寫入國家列（沒有會自動新建）' }, columns: AGENT_COLUMNS },
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
    family: { type: 'string', description: '家庭組名（組長排第一）；"owner" = 所有組長；"none" = 沒加入家庭組；空 = 不限' },
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
  agentFn('import_text', '用軟件的智能識別解析原始賬號文本（任意分隔符、任意順序）並導入：text 是用戶粘貼的文本，或者 scan_id = fs_scan_accounts 從文件裡統計到的賬號（用文件裡的原始行導入，已在列表裡的自動跳過）。返回無法識別的行，你可以整理後用 add_accounts 補上', {
    text: { type: 'string' }, scan_id: { type: 'string', description: '導入 fs_scan_accounts 掃描到的賬號（代替 text）' },
    keep_unrecognized: { type: 'boolean', description: '默認 true：有郵箱但帶了認不出內容的行照樣導入，多餘內容放進備註' },
    group: AGENT_STR, status: AGENT_STR, sheet: AGENT_STR, columns: AGENT_COLUMNS,
    skip_duplicates: { type: 'boolean' },
  }),
  agentFn('update_accounts', '修改郵箱：set / columns 是整個覆蓋字段的值；edits 是只改其中一部分文字（替換、刪掉某些字、加前後綴）。對 filter 選中的統一修改，或用 items 給每個郵箱分別修改', {
    filter: AGENT_FILTER, set: AGENT_SET, columns: AGENT_COLUMNS, edits: AGENT_EDITS,
    items: { type: 'array', description: '分別修改', items: { type: 'object', properties: { email: AGENT_STR, set: AGENT_SET, columns: AGENT_COLUMNS, edits: AGENT_EDITS }, required: ['email'] } },
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
  agentFn('manage_families', '管理家庭組（郵箱之間的關係：一個組長 + 若干成員，例如 Google 家庭組；成員可以在不同列表，一個郵箱可以在多個家庭組）。' +
    'list 列出全部家庭組和成員；create 新建（可同時給 owner 組長和 members 成員）；update 改名稱 / 類型 / 人數上限 / 備註；delete 刪除家庭組（不刪郵箱）；' +
    'add_members 加入成員；remove_members 移出成員；set_owner 設置組長（原組長變成普通成員，owner 留空 = 取消組長）', {
    action: { type: 'string', enum: ['list', 'create', 'update', 'delete', 'add_members', 'remove_members', 'set_owner'] },
    name: { type: 'string', description: '家庭組名稱（create 時是新名稱）' }, new_name: AGENT_STR,
    kind: { type: 'string', description: '類型 / 服務，例如 Google One、YouTube Premium、Microsoft 365' },
    max_members: { type: 'integer', description: '人數上限（含組長），0 = 不限；create 默認 6' }, notes: AGENT_STR,
    owner: { type: 'string', description: '組長的郵箱地址' },
    members: { type: 'array', items: AGENT_STR, description: '成員郵箱地址（可以在任何列表）' },
    filter: { ...AGENT_FILTER, description: 'add_members / remove_members：也可以用條件選當前列表裡的郵箱作為成員' },
  }, ['action']),
  agentFn('manage_sheets', '管理側邊欄的列表：list / create / rename / switch（切換表格顯示的列表，之後的操作針對它）/ move（調整列表順序）/ delete（連同郵箱，用戶會確認，可撤銷）', {
    action: { type: 'string', enum: ['list', 'create', 'rename', 'switch', 'move', 'delete'] }, name: AGENT_STR, new_name: AGENT_STR,
    position: { type: 'integer', description: 'move：移到第幾個（1 = 最前面，-1 = 最後面）' },
    before: { type: 'string', description: 'move：放到這個名稱前面' }, after: { type: 'string', description: 'move：放到這個名稱後面' },
    offset: { type: 'integer', description: 'move：相對移動，-1 = 上移一位，2 = 下移兩位' },
  }, ['action']),
  agentFn('get_2fa_codes', '獲取郵箱當前的 2FA 驗證碼（6 位，30 秒有效）', { filter: AGENT_FILTER }),
  agentFn('use_backup_code', '取這個郵箱下一個未用的一次性備用碼（例如 Google 的 10 個備用碼）：在本地複製到剪貼板並標記為已用，返回剩餘數量', {
    email: AGENT_STR,
  }, ['email']),
  agentFn('fetch_mail', '收取郵箱的最新郵件（自建 BillionMail / 微軟郵箱），返回發件人、標題、時間、提取到的驗證碼和正文摘要', {
    email: { type: 'string', description: '主郵箱地址（當前列表裡的）' },
    which: { type: 'string', enum: ['recovery', 'email'], description: 'recovery=它的輔助郵箱（默認），email=主郵箱本身' },
    limit: { type: 'integer', description: '取最新多少封，默認 5，最多 50（返回 total = 郵件總數）' },
  }, ['email']),
  agentFn('copy_to_clipboard', '在本地把郵箱數據複製到剪貼板（可以包含密碼，不經過 AI）', {
    filter: AGENT_FILTER, fields: { type: 'array', items: { type: 'string' }, description: '默認 email,password,totp_secret,recovery_email' },
    separator: { type: 'string', description: '默認 ----' },
  }),
  agentFn('export_accounts', '在本地導出文件（CSV 或 TXT，包含密碼）。給 path 時直接保存到這個路徑（文件夾或完整文件名），否則彈出保存對話框', {
    filter: AGENT_FILTER, format: { type: 'string', enum: ['csv', 'txt'] },
    path: { type: 'string', description: '保存位置，例如 D:\\導出\\yutoux.txt 或一個文件夾' }, overwrite: { type: 'boolean' },
  }),
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
  agentFn('get_history', '查詢操作記錄（新的在前）：密碼、2FA、備用碼、輔助郵箱、備註、狀態等敏感字段的變更前 → 變更後，刪除的郵箱（變更前是刪除時的字段，可以用來找回），主密碼 / API 密鑰的改動。用來回答「這個郵箱以前的密碼是什麼」「剛才誰改了 2FA」「刪掉的郵箱密碼還能找回嗎」', {
    email: { type: 'string', description: '只看這個郵箱' },
    field: { type: 'string', enum: ['email', 'password', 'totp_secret', 'backup_codes', 'recovery_email', 'recovery_password', 'oauth_client_id', 'oauth_token', 'phone', 'notes', 'status', 'delete', 'restore', 'security'],
      description: '只看這個字段；delete = 刪除郵箱，restore = 撤銷恢復，security = 主密碼 / API 設置' },
    actor: { type: 'string', enum: ['user', 'agent', 'sync'], description: 'user = 用戶自己，agent = AI 助手，sync = 自建郵箱同步' },
    search: { type: 'string', description: '在郵箱、列表名、變更前後的內容裡搜索' },
    days: { type: 'integer', description: '只看最近幾天' },
    limit: { type: 'integer', description: '默認 20，最多 100' },
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
// 操作電腦：文件和命令（設置裡可關閉）。讀取 / 搜索文件內容、寫入、移動會先讓用戶確認（自動執行模式下讀寫不確認），執行命令總是確認
const AGENT_PATH = { type: 'string', description: '路徑，例如 E:\\workspace\\號池。用戶給的路徑原樣傳入（少了冒號、正反斜槓都可以），不存在時返回相近的名字' };
const AGENT_COMPUTER_TOOLS = [
  agentFn('fs_list', '列出電腦上某個文件夾的內容（名稱、類型、大小、修改時間）', {
    path: AGENT_PATH, pattern: { type: 'string', description: '文件名過濾，例如 *.txt；多個用分號' },
    recursive: { type: 'boolean', description: '包括子文件夾' }, limit: { type: 'integer', description: '默認 200，最多 500' },
  }, ['path']),
  agentFn('fs_scan_accounts', '統計文件或文件夾（含子文件夾）裡的郵箱賬號：每行第一個郵箱算一個賬號，去重，並對比哪些已在當前列表 / 其他列表 / 還沒導入。' +
    '返回 scan_id，之後 update_accounts / select_rows / set_view 的 filter.scan_id、import_text.scan_id 可以直接用它，不用把郵箱抄一遍。支持 txt/csv/json/xlsx/docx 等', {
    path: AGENT_PATH, pattern: { type: 'string', description: '只看這些文件，例如 *.txt;*.csv（默認所有文本、表格文件）' },
    recursive: { type: 'boolean', description: '默認 true' },
  }, ['path']),
  agentFn('fs_read', '讀取文本文件的內容（自動識別編碼，xlsx/docx 轉成文本），按行分段返回。賬號文件裡有密碼，統計郵箱請用 fs_scan_accounts', {
    path: AGENT_PATH, offset: { type: 'integer', description: '從第幾行開始，默認 1' }, limit: { type: 'integer', description: '最多多少行，默認 200' },
  }, ['path']),
  agentFn('fs_search', '在文件或文件夾裡搜索包含某段文字的行（返回文件、行號、內容）', {
    path: AGENT_PATH, query: AGENT_STR, regex: { type: 'boolean' }, pattern: { type: 'string', description: '只搜這些文件，例如 *.txt' },
    recursive: { type: 'boolean', description: '默認 true' },
  }, ['path', 'query']),
  agentFn('fs_write', '寫入文本文件（UTF-8）。文件已存在時需要 append=true（追加到末尾）或 overwrite=true（覆蓋）', {
    path: AGENT_PATH, content: AGENT_STR, append: { type: 'boolean' }, overwrite: { type: 'boolean' },
  }, ['path', 'content']),
  agentFn('fs_move', '移動 / 重命名 / 複製文件或文件夾。to 是文件夾時放進去', {
    from: AGENT_PATH, to: AGENT_PATH, copy: { type: 'boolean', description: 'true = 複製，保留原文件' },
  }, ['from', 'to']),
  agentFn('fs_mkdir', '新建文件夾（含上級）', { path: AGENT_PATH }, ['path']),
  agentFn('fs_open', '在資源管理器裡打開文件夾，或打開文件所在位置並選中它', { path: AGENT_PATH }, ['path']),
  agentFn('run_command', '在用戶電腦上執行一條 PowerShell 命令並返回輸出（每次都需要用戶確認）。只在文件工具做不到時使用，不要執行刪除、格式化、改系統設置等危險操作', {
    command: AGENT_STR, cwd: { type: 'string', description: '工作目錄，默認用戶主目錄' }, timeout: { type: 'integer', description: '秒，默認 60，最多 600' },
  }, ['command']),
];
// 技能和經驗：read_skill 總是可用；記經驗 / 寫技能在設置裡開了「允許 AI 自動學習」才有
const AGENT_SKILL_TOOLS = [
  agentFn('read_skill', '讀取一個技能的完整內容（技能列表見系統提示裡的「可用技能」），遇到相關任務時先讀再照做', { name: AGENT_STR }, ['name']),
];
const AGENT_LEARN_TOOLS = [
  agentFn('remember', '記下一條關於用戶的長期經驗（偏好、習慣、術語含義、對你的糾正），以後每次對話都會帶上。replace_id 給出時更新那一條', {
    content: { type: 'string', description: '一句話，寫清楚什麼情況下怎麼做；不要記郵箱地址、密碼等具體數據' }, replace_id: AGENT_STR,
  }, ['content']),
  agentFn('forget', '刪除一條過時或錯誤的經驗', { id: AGENT_STR }, ['id']),
  agentFn('save_skill', '把一套可重複使用的做法寫成技能（同名則更新，舊版本會保留可回滾）。用戶教了你一種做法、或完成了以後可能重複的多步任務時使用', {
    name: { type: 'string', description: '簡短名稱，例如「批量建 MJJ 郵箱」' },
    description: { type: 'string', description: '一句話：什麼時候用' },
    content: { type: 'string', description: '具體步驟、要用的工具和參數要點、注意事項' },
  }, ['name', 'content']),
];

// 自建郵箱窗口用不上的工具（只有一個列表、郵箱只能在後台新建）
const AGENT_MAIN_ONLY = ['add_accounts', 'import_text', 'move_to_sheet', 'manage_sheets', 'manage_families', 'find_in_all_sheets', 'create_recovery_mailboxes'];

// 修改類（確認後執行，可勾選自動執行）和刪除類（總是確認）
// 確認卡片裡顯示命令：在引號外的「;」處換行，長命令也能看清楚每一步
function agentFormatCommand(cmd) {
  let out = '', quote = '';
  for (const ch of String(cmd || '')) {
    if (quote) { if (ch === quote) quote = ''; out += ch; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    if (ch === ';') { out += ';\n'; continue; }
    out += ch;
  }
  return out.split('\n').map(l => l.trim()).filter(Boolean).join('\n');
}

// AI 助手調用後端：操作記錄裡記為「AI 助手」
function agentCall(name, ...args) { return callAs('agent', name, ...args); }

function agentConfirmLevel(name, args) {
  if (name === 'delete_accounts') return 'danger';
  if (['manage_sheets', 'manage_columns', 'manage_groups', 'manage_families'].includes(name) && args.action === 'delete') return 'danger';
  if (name === 'manage_families' && args.action !== 'list') return 'write';
  if (name === 'run_command') return 'danger';
  if (['fs_read', 'fs_search', 'fs_write', 'fs_move', 'fs_mkdir'].includes(name)) return 'write';
  if (name === 'export_accounts' && args.path) return 'write';
  if (['update_accounts', 'add_accounts', 'import_text', 'move_to_sheet', 'create_recovery_mailboxes', 'create_mailboxes'].includes(name)) return 'write';
  return '';
}

const AgentMixin = {
  data() {
    return { agent: { open: false, items: [], history: [], input: '', busy: false, stop: false, undo: [],
      // 多對話：chatId = 當前對話（null = 還沒保存的新對話），chats = 對話列表，images = 待發送的圖片
      chatId: null, title: '', chats: [], showList: false, images: [], viewer: '', token: 0, trimmed: 0, skillMenu: false },
      // 助手設置（設置 → AI 糾錯裡改）和技能 / 經驗庫
      agentCfg: { agent_max_turns: 20, agent_max_chars: 150000, agent_learn: true, agent_reflect: true, agent_computer: true },
      kb: { skills: [], memories: [], reflected: {} }, kbEdit: null };
  },

  computed: {
    agentExamples() { return (SELFMAIL ? [1, 2, 3, 4] : [1, 2, 3, 4, 5]).map(i => t((SELFMAIL ? 'agent.sm' : 'agent.ex') + i)); },
    agentTools() {
      const base = SELFMAIL ? [...AGENT_TOOLS.filter(x => !AGENT_MAIN_ONLY.includes(x.function.name)), ...AGENT_SELFMAIL_TOOLS] : AGENT_TOOLS;
      return [...base, ...(this.agentCfg.agent_computer ? AGENT_COMPUTER_TOOLS : []), ...AGENT_SKILL_TOOLS, ...(this.agentCfg.agent_learn ? AGENT_LEARN_TOOLS : [])];
    },
    // 技能：當前窗口可用的（停用的不算）
    agentSkills() { return this.kb.skills.filter(s => s.mode !== 'off' && (!s.scope || s.scope === 'all' || s.scope === (MODE || 'main'))); },
  },

  methods: {
    // ---------- 面板 ----------
    toggleAgent() {
      this.agent.open = !this.agent.open;
      this.prefs.agentOpen = this.agent.open;
      if (this.agent.open) { nextTick(() => this.$refs.agentInput?.focus()); this.agentScroll(); }
    },
    // 鎖定時清掉內存裡的對話（已經加密保存在數據庫，解鎖後恢復）
    agentReset() {
      this.agentStop();
      Object.assign(this.agent, { items: [], history: [], busy: false, stop: false, undo: [], chatId: null, title: '',
        chats: [], showList: false, images: [], viewer: '', token: this.agent.token + 1 });
    },

    // ---------- 多對話：保存 / 恢復 / 切換 ----------
    // 解鎖後調用：載入對話列表，恢復上次的對話和面板狀態
    async agentInit() {
      await this.agentLoadCfg();
      agentCall('fs_info').then(r => { this.fsInfo = r; }).catch(() => {});
      await this.agentLoadKb();
      try {
        this.agent.chats = await agentCall('list_chats', MODE);
        const id = this.prefs.agentChatId;
        if (id && this.agent.chats.some(c => c.id === id)) await this.agentOpenChat(id);
        if (this.prefs.agentOpen) this.agent.open = true;
      } catch { /* 忽略 */ }
    },
    async agentLoadCfg() {
      try {
        const c = await agentCall('get_ai_config');
        for (const k of Object.keys(this.agentCfg)) if (c[k] !== undefined) this.agentCfg[k] = c[k];
      } catch { /* 忽略 */ }
    },
    async agentLoadKb() {
      try { Object.assign(this.kb, { reflected: {}, ...(await agentCall('get_agent_kb')) }); } catch { /* 忽略 */ }
    },
    async agentSaveKb() {
      const kb = JSON.parse(JSON.stringify(this.kb));
      await agentCall('save_agent_kb', kb);
    },
    async agentRefreshChats() {
      try { this.agent.chats = await agentCall('list_chats', MODE); } catch { /* 忽略 */ }
    },
    async agentOpenChat(id) {
      const agent = this.agent;
      if (agent.busy) return this.toast(t('agent.busySwitch'), 'error');
      if (id !== agent.chatId) this.agentReflectCurrent();
      const c = await agentCall('get_chat', id);
      if (!c) { await this.agentRefreshChats(); return; }
      const d = c.data || {};
      // 上次關閉時還在執行 / 等確認的操作，標記為已中斷
      for (const m of d.items || []) {
        m.streaming = false;
        for (const tc of m.tools || []) {
          if (tc.status === 'running' || tc.status === 'confirm') { tc.status = 'error'; tc.summary = t('agent.interrupted'); }
        }
      }
      Object.assign(agent, { items: d.items || [], history: d.history || [], undo: d.undo || [], chatId: c.id, title: c.title,
        showList: false, images: [], token: agent.token + 1 });
      this.prefs.agentChatId = c.id;
      this.agentScroll();
    },
    agentNewChat() {
      const agent = this.agent;
      if (agent.busy) return this.toast(t('agent.busySwitch'), 'error');
      clearTimeout(this._agentSaveTimer);
      if (agent.items.length) this.agentSaveNow();  // 先把當前對話存好
      this.agentReflectCurrent();
      Object.assign(agent, { items: [], history: [], undo: [], chatId: null, title: '', showList: false, images: [], input: '',
        token: agent.token + 1 });
      this.prefs.agentChatId = null;
      nextTick(() => this.$refs.agentInput?.focus());
    },
    async agentDeleteChat(c) {
      if (!(await this.confirm(t('agent.deleteChat'), t('agent.deleteChatConfirm', { s: c.title || t('agent.untitled') })))) return;
      await agentCall('delete_chat', c.id);
      if (c.id === this.agent.chatId) {
        Object.assign(this.agent, { items: [], history: [], undo: [], chatId: null, title: '', token: this.agent.token + 1 });
        this.prefs.agentChatId = null;
      }
      await this.agentRefreshChats();
    },
    async agentRenameChat(c) {
      const name = await this.prompt(t('agent.renameChat'), '', c.title);
      if (!name) return;
      await agentCall('rename_chat', c.id, name);
      if (c.id === this.agent.chatId) this.agent.title = name;
      await this.agentRefreshChats();
    },
    agentAutoTitle() {
      const first = this.agent.items.find(m => m.role === 'user');
      const text = (first?.text || '').split('\n').map(x => x.trim()).find(Boolean) || '';
      return text.slice(0, 40) || (first?.images?.length ? t('agent.imageMsg') : t('agent.untitled'));
    },
    // 對話有變化就保存（防抖）
    agentSaveSoon() {
      clearTimeout(this._agentSaveTimer);
      this._agentSaveTimer = setTimeout(() => this.agentSaveNow(), 600);
    },
    async agentSaveNow() {
      const agent = this.agent;
      if (!agent.items.length || !this.lock.unlocked) return;
      const token = agent.token;
      if (!agent.title) agent.title = this.agentAutoTitle();
      const data = JSON.parse(JSON.stringify({ items: agent.items, history: agent.history, undo: agent.undo }));
      try {
        const id = await agentCall('save_chat', agent.chatId, MODE, agent.title, data);
        if (agent.token === token && !agent.chatId) agent.chatId = id;  // 保存期間切換了對話就不改
        if (agent.token === token) this.prefs.agentChatId = id;
        await this.agentRefreshChats();
      } catch { /* 鎖定了等情況，忽略 */ }
    },
    agentTime(ms) {
      const d = new Date(ms), now = new Date(), p = n => String(n).padStart(2, '0');
      return d.toDateString() === now.toDateString() ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`;
    },

    // ---------- 圖片消息 ----------
    async agentAttach(files) {
      for (const f of files || []) {
        if (!f || !f.type?.startsWith('image/')) continue;
        if (this.agent.images.length >= AGENT_MAX_IMAGES) { this.toast(t('agent.tooManyImages', { n: AGENT_MAX_IMAGES }), 'error'); break; }
        try { this.agent.images.push(await fileToThumb(f, AGENT_IMAGE_MAX)); } catch { this.toast(t('cell.imageFailed'), 'error'); }
      }
    },
    agentPaste(e) {
      const files = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image/')).map(i => i.getAsFile());
      if (files.length) { e.preventDefault(); this.agentAttach(files); }
    },
    agentDrop(e) { this.agentAttach([...(e.dataTransfer?.files || [])]); },
    agentPickImages(e) { this.agentAttach([...(e.target.files || [])]); e.target.value = ''; },
    agentCopyText(text) { this.copy(text, t('agent.message')); },
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
        if (m.role === 'user') lines.push(`【${t('agent.you')}】\n${m.text}${m.images?.length ? `\n[${t('agent.imageMsg')} ×${m.images.length}]` : ''}`);
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
      const fromInput = text === undefined;
      text = (text ?? agent.input).trim();
      const images = fromInput ? [...agent.images] : [];
      if ((!text && !images.length) || agent.busy) return;
      try {
        if (!aiConfigured(await agentCall('get_ai_config'))) return this.toast(t('import.aiNoConfig'), 'error');
      } catch (e) { return this.toast(errText(e), 'error'); }
      if (fromInput) { agent.input = ''; agent.images = []; }
      agent.items.push({ role: 'user', text, images, tools: [] });
      // 「/技能名 其餘內容」：把技能內容帶進這條消息
      const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
      const skill = m && this.agentSkills.find(s => s.name.toLowerCase() === m[1].toLowerCase());
      if (skill) {
        text = `【${t('agent.useSkill')}：${skill.name}】\n${skill.content}\n\n${m[2] || ''}`.trim();
        skill.uses = (skill.uses || 0) + 1;
        this.agentSaveKb().catch(() => {});
      }
      // 帶圖片時按 OpenAI 多模態格式發送（模型需要支持識圖）
      agent.history.push({ role: 'user', content: images.length
        ? [{ type: 'text', text: text || t('agent.imageOnly') }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))]
        : text });
      this.agentSaveSoon();
      agent.busy = true;
      agent.stop = false;
      this.agentScroll();
      try {
        await this.agentLoop();
      } finally {
        agent.busy = false;
        agent.stop = false;
        this.agentSaveSoon();
      }
    },
    // 歷史太長時丟掉最早的幾輪（從一條用戶消息開始截，保證工具調用和結果成對）
    // 發給模型的歷史：最多最近 agent_max_turns 輪、agent_max_chars 字（圖片按固定權重算），從一條用戶消息開始截，
    // 保證工具調用和結果成對。完整歷史仍然保存在對話裡。
    agentContext() {
      const h = this.agent.history;
      const maxTurns = Math.max(1, this.agentCfg.agent_max_turns || 20);
      const maxChars = Math.max(5000, this.agentCfg.agent_max_chars || AGENT_HISTORY_LIMIT);
      const starts = h.map((m, i) => (m.role === 'user' ? i : -1)).filter(i => i >= 0);
      let from = starts.length > maxTurns ? starts[starts.length - maxTurns] : 0;
      const size = arr => JSON.stringify(arr, (k, v) => (k === 'url' && typeof v === 'string' && v.startsWith('data:') ? 'x'.repeat(3000) : v)).length;
      while (size(h.slice(from)) > maxChars) {
        const next = starts.find(i => i > from);
        if (next === undefined) break;
        from = next;
      }
      this.agent.trimmed = starts.filter(i => i < from).length;
      return h.slice(from);
    },
    async agentLoop() {
      const agent = this.agent;
      for (let step = 0; step < AGENT_MAX_STEPS; step++) {
        agent.items.push({ role: 'assistant', text: '', tools: [], streaming: true, error: '', tool: '', toolChars: 0, started: Date.now() });
        const item = agent.items[agent.items.length - 1];  // 響應式代理
        const context = this.agentContext();
        const messages = [{ role: 'system', content: this.agentSystemPrompt() }, ...context];
        let result;
        try {
          const job = await agentCall('ai_chat_start', messages, this.agentTools);
          result = await pollAiJob(job, d => { item.text += d; this.agentScroll(); }, () => agent.stop,
            r => { if (r.tool) { item.tool = r.tool; item.toolChars = r.tool_chars; } });
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
            args: c.function.arguments || '{}', result: '', open: false, started: Date.now(), progress: null });
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
          tc.elapsed = Math.round((Date.now() - tc.started) / 1000);
          tc.summary = out.error ? String(out.error) : this.agentSummary(c.function.name, out);
          if (out.undo_id) tc.undoId = out.undo_id;
          const content = JSON.stringify(out).slice(0, 30000);
          tc.result = content;
          agent.history.push({ role: 'tool', tool_call_id: c.id, content });
          this.agentSaveSoon();
        }
        if (agent.stop) return;
      }
    },

    agentSummary(name, out) {
      if (out.declined) return t('agent.declined');
      const n = out.total ?? out.updated ?? out.added ?? out.deleted ?? out.moved ?? out.copied ?? out.exported ?? out.selected;
      switch (name) {
        case 'set_view': return t('agent.sum.view', { n: out.visible });
        case 'fs_list': return out.error ? out.error : t('agent.sum.fsList', { n: out.total });
        case 'fs_scan_accounts': return out.error ? out.error : t('agent.sum.fsScan', { n: out.unique_emails, f: out.files_with_accounts, a: out.in_current_sheet, b: out.not_in_sheet });
        case 'fs_read': return out.error ? out.error : `${out.from}-${out.to} / ${out.total_lines}`;
        case 'fs_search': return out.error ? out.error : t('agent.sum.found', { n: out.matches });
        case 'fs_write': case 'fs_mkdir': case 'fs_open': return out.error ? out.error : (out.path || out.opened || '✓');
        case 'fs_move': return out.error ? out.error : out.to;
        case 'run_command': return out.error ? out.error : `exit ${out.exit_code} · ${out.seconds}s`;
        case 'manage_families': return out.families ? t('agent.sum.families', { n: out.families.length })
          : (out.family ? `${out.family}${out.members != null ? ' · ' + out.members : ''}` : '✓');
        case 'select_rows': return t('agent.sum.selected', { n: out.selected });
        case 'update_accounts': return t('agent.sum.updated', { n: out.updated });
        case 'add_accounts': case 'import_text':
          return t('agent.sum.added', { n: out.added, s: out.skipped || 0 }) + (out.failed?.length ? ' · ' + t('agent.sum.failed', { n: out.failed.length }) : '');
        case 'delete_accounts': return t('agent.sum.deleted', { n: out.deleted });
        case 'move_to_sheet': return t('agent.sum.moved', { n: out.moved, s: out.sheet });
        case 'copy_to_clipboard': return t('agent.sum.copied', { n: out.copied });
        case 'export_accounts': return t('agent.sum.exported', { n: out.exported });
        case 'create_recovery_mailboxes': return t('agent.sum.mailboxes', { n: out.created?.length || 0, f: out.failed?.length || 0 });
        case 'create_mailboxes': return t('agent.sum.mailboxes', { n: out.created || 0, f: out.failed?.length || 0 }) +
          (out.in_group != null ? ' · ' + t('agent.sum.inGroup', { n: out.in_group }) : '');
        case 'sync_mailboxes': return t('selfmail.synced', { n: out.total, a: out.added, u: out.updated, d: out.removed });
        case 'get_2fa_codes': return t('agent.sum.found', { n: out.codes?.length || 0 });
        case 'fetch_mail': return t('agent.sum.mails', { n: out.messages?.length || 0 });
        case 'undo': return out.undone || '✓';
        case 'get_history': return t('agent.sum.found', { n: out.total ?? 0 });
        case 'remember': return out.memory || '✓';
        case 'save_skill': return out.skill || '✓';
        case 'read_skill': return out.name || '✓';
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
        families: SELFMAIL ? undefined : this.families.map(f => ({ name: f.name, kind: f.kind || undefined, owner: this.famOwner(f)?.email || '',
          members: f.members.length, max: f.max_members || undefined })),
        statuses: this.meta.statuses.map(s => this.statusLabel(s)),
        total_in_sheet: this.accounts.length,
        // 用戶當前在看什麼（用名稱，不用內部 id）
        current_view: {
          group: this.filters.group === '' ? t('group.all') : this.filters.group === 'none' ? t('group.none') : (this.groupMap[this.filters.group]?.name || ''),
          family: typeof this.filters.family === 'number' ? this.familyMap[this.filters.family]?.name : this.filters.family || undefined,
          status: this.filters.status ? this.statusLabel(this.filters.status) : '', domain: this.filters.domain, country: this.filters.country,
          has_2fa: this.filters.twofa, has_recovery: this.filters.recovery, search: this.search,
          sort: this.sort.key ? `${this.sort.key} ${this.sort.dir > 0 ? 'asc' : 'desc'}` : '',
          shown: this.sorted.length, page: this.page, page_size: this.pageSize,
        },
        selected: this.accounts.filter(a => this.selected[a.id]).length,
        computer: this.agentCfg.agent_computer ? this.fsInfo || undefined : undefined,
        top_domains: this.domains.slice(0, 15),
        self_hosted_domains: this.selfDomains,
        billionmail_configured: !!this.mailCfg?.panel_url,
        can_read_secrets: !!this.prefs.agentSecrets,
        undo_available: this.agent.undo.map(u => ({ id: u.id, label: u.label })).slice(-5),
      };
      const secrets = this.prefs.agentSecrets
        ? '用戶已允許你讀取密碼類明文，需要時 get_accounts 傳 include_secrets=true。'
        : '默認看不到密碼、2FA 密鑰、令牌（只有 has_xxx）。需要明文的操作用 copy_to_clipboard / export_accounts 在本地完成；用戶要你直接讀出密碼時，告訴他在 AI 助手面板頂部勾選「允許讀取密碼」。';
      const skills = this.agentSkills;
      const autoSkills = skills.filter(s => s.mode === 'auto');
      const manualSkills = skills.filter(s => s.mode !== 'auto');
      const memories = this.kb.memories.filter(m => m.enabled !== false);
      const learned = [
        memories.length ? `關於這個用戶的經驗（優先遵守；過時或錯誤的用 forget 刪掉）：\n${memories.map(m => `- [${m.id}] ${m.content}`).join('\n')}` : '',
        autoSkills.length ? `技能（用戶要求每次對話都遵循）：\n${autoSkills.map(s => `### ${s.name}\n${s.content}`).join('\n\n')}` : '',
        manualSkills.length ? `可用技能（相關時先 read_skill 讀完整內容再照做）：\n${manualSkills.map(s => `- ${s.name}：${s.description || ''}`).join('\n')}` : '',
        this.agent.trimmed ? `（更早的 ${this.agent.trimmed} 輪對話已省略，需要時可以請用戶重新提供）` : '',
      ].filter(Boolean).join('\n\n');
      const learnRule = this.agentCfg.agent_learn
        ? `- 自動學習：用戶糾正你、說明偏好或某個詞的意思時，用 remember 記下（一句話，不記具體郵箱、密碼）；用戶教了一種做法、或你完成了一個以後可能重複的多步任務時，用 save_skill 寫成技能。不要重複記已有的內容。\n`
        : '';
      return `你是「郵箱管理」桌面軟件內置的 AI 助手（agent）。你能通過工具完成這個軟件裡幾乎所有的操作：用戶讓你做什麼，就直接調用工具去做完，而不是教用戶自己去點界面。
能力：查詢、統計、查重、跨列表查找；篩選、搜索、排序、勾選、翻頁；新增郵箱（add_accounts，或 import_text 解析用戶粘貼的原始文本）、修改任意字段/狀態/分組/備註/自定義列、刪除郵箱、移動到其他列表；管理列（新增/改名/改類型/刪除/顯示隱藏/調整順序和寬度）、分組、列表、家庭組（組長 + 成員的關係）；${this.agentCfg.agent_computer ? '操作電腦：瀏覽 / 讀取 / 搜索 / 寫入 / 移動文件、從文件裡統計和導入郵箱、執行命令；' : ''}查看 2FA 驗證碼；收取郵件和驗證碼；複製、導出；用 BillionMail 創建自建輔助郵箱；改主題/語言/自動鎖定；撤銷你之前的修改（undo）。
工作方式：
- 你擁有上面列出的全部工具。不要說「我沒有這個功能」「需要你在軟件裡手動操作」，也不要提「改名繞過」之類的變通辦法，先看工具能不能直接完成；只有工具確實做不到時才這樣說。
- 先根據「當前狀態」裡的 groups（側邊欄分組，按顯示順序）、sheets（列表）、columns（表格列）判斷用戶說的名字指的是什麼：
  · 名字是某個分組 / 列表的名稱（例如「分組 29」「分組名稱 29」「29 這個分組」），「移到第一 / 最前 / 置頂 / 第 N 個 / 上移 / 下移 / 放最後」就是調整它在側邊欄的順序（manage_groups / manage_sheets 的 move）——即使用戶說的是「第一列」，這裡的「列」只是口語的「第一位」。
  · 只有名字是表格列名（序號、郵箱、密碼、分組列、備註、自定義列…）時，才是調整表格的列（manage_columns）。
  · 「把郵箱放進 / 加到 29 分組」是改郵箱的分組，不是調整分組順序。
- 一個郵箱可以同時在多個分組：「加入 / 也放進 X 分組」用 set.add_groups（保留原有分組）；「從 X 分組移出」用 set.remove_groups；「只放在 X / 改成 X 分組」才用 set.group 或 set.groups（替換全部）；「移出所有分組」用 set.group=""。篩選「在 X 分組裡的」用 conditions {field:"group", op:"eq", value:"X"}。
  · 名字同時能對上兩種、又看不出指哪個時，簡短地問一句再做。
${this.agentCfg.agent_computer ? `- 操作電腦：用戶給出電腦上的路徑時直接用 fs_* 工具（路徑原樣傳入，少冒號、斜槓方向都沒關係；不存在時根據返回的 similar / entries 找到最像的那個再試，不要讓用戶重新輸入）。
  · 統計 / 導入文件裡的郵箱：先 fs_scan_accounts 得到 scan_id 和統計（不要用 fs_read 把賬號文件讀出來，裡面有密碼）。之後用 filter.scan_id 操作這些郵箱：已在當前列表的用 update_accounts({filter:{scan_id}, set:{add_groups:["X"]}}) 加分組；不在列表裡的（not_in_sheet > 0）用 import_text({scan_id, group:"X"}) 導入並放進分組（已在的自動跳過）。用戶只說「統計」時只匯報數字（文件數、郵箱數、重複、已在 / 未在列表）。
  · 不要自己寫腳本（run_command / PowerShell）去解析、拆分、去重、導入賬號文件：import_text({scan_id}) 會識別手機號、國家、接碼鏈接、「標籤:值」等字段，認不出的多餘內容自動放進備註，郵箱照樣導入（返回 partial = 這類行數）。導入後如實匯報 added / skipped / partial / failed_total。
  · 執行命令（run_command）只用於文件工具做不到的系統操作（解壓、查看磁盤、網絡測試等），命令要短、一次做一件事；用戶每次都要確認；不要刪除文件、改系統設置。
` : ''}- 家庭組 ≠ 分組：分組只是標籤；家庭組是郵箱之間的關係（一個組長 + 成員，例如 Google 家庭組 / YouTube 家庭方案），用 manage_families。「把 A 設為組長，B、C 加進去」→ manage_families create（或 set_owner + add_members）；「看 X 家庭組 / 誰是組長」→ manage_families list 或 set_view({family})；篩選家庭組成員用 conditions {field:"family", op:"eq", value:"X"}，所有組長用 {field:"family_role", op:"eq", value:"owner"}。成員可以在別的列表，用郵箱地址指定即可。
- 用戶糾正你（「不是這個意思」「我說的是…」「錯了」）：先用 undo 撤銷剛才理解錯的那一步，再按正確的理解重新做，並說明已撤銷了什麼。
- 多步任務就連續調用多個工具一次做完。信息不足時先用查詢類工具弄清楚；只有確實無法判斷用戶意圖時才提問。
- 用戶給了賬號數據要導入/添加：原始文本直接 import_text（無法識別的行你自己整理後用 add_accounts 補上）；你已經理解了字段就用 add_accounts。可以同時指定分組、狀態、國家、自定義列（例如「編號」）。
- 需要的分組、列、列表不存在時，工具會自動創建，不用先問用戶。
- 修改和刪除類操作界面會讓用戶確認，你直接調用即可，不要在回答裡先徵求同意。用戶說「撤銷 / 改回去」時用 undo。
- 「這些 / 選中的」= filter.scope=selected；「當前顯示的」= scope=view；「第 3 到 10 個」= filter.rows。
- 字符串值可用模板 {email} {user} {domain} {index} {random}（隨機密碼）。
- 密碼：${secrets}
- 用戶想「看 / 找 / 篩選」時，用 set_view 或 select_rows(show_only=true) 把結果顯示在表格裡。
- 改文字時分清「覆蓋」和「局部修改」：
  · 「改成 / 設為 / 填上 X」才用 set / columns 覆蓋整個值。
  · 「把 A 替換成 B」「把裡面的 X 去掉 / 刪掉」「加上前綴 / 後綴」「在備註後面加…」用 update_accounts 的 edits（replace / remove / prepend / append），只動匹配的那部分，其餘內容保持不變。
  · 「刪除 X 列」= manage_columns 的 delete（整列沒了）；「清空 X 列 / 把 X 列的內容刪掉」= columns 把值設成空字符串，列保留。分不清時先問。
  · 不要改動或刪除比用戶要求更多的內容；不確定影響範圍時先 get_accounts 看一下。edits 返回 edited = 實際有變化的行數，可用來核對。
${learnRule}- 用戶粘貼的內容常夾雜從網頁複製來的雜訊（圖標、「Loading...」、空行等），只提取其中有效的郵箱和字段。
- 批量操作後核對工具返回的計數（created / in_list / in_group / updated / not_found / failed），和預期不一致時自己查明原因並修正，再告訴用戶。
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
- 「這個郵箱以前的密碼 / 2FA 是什麼」「誰改了備註」「被刪除的郵箱還能找回密碼嗎」→ get_history${this.agentCfg.agent_computer ? `
- 「統計 E\\workspace\\號池\\新號商 的郵箱並加到 yutoux 分組」→ fs_scan_accounts({path:"E\\workspace\\號池\\新號商"}) → update_accounts({filter:{scan_id}, set:{add_groups:["yutoux"]}}) → 有 not_in_sheet 時 import_text({scan_id, group:"yutoux"})
- 「把 yutoux 分組導出到桌面」→ export_accounts({filter:{conditions:[{field:"group",op:"eq",value:"yutoux"}]}, format:"txt", path: 桌面路徑})` : ''}
${SELFMAIL ? `
你現在在「自建郵箱管理」窗口：表格裡的每一行就是 BillionMail 後台的一個真實郵箱（郵箱 + 登錄密碼）。
- 新建郵箱用 create_mailboxes（會在後台創建）；delete_accounts 會在後台刪除郵箱，不可撤銷；修改密碼、把狀態改成 / 改離「停用」會同步到後台，也不可撤銷。分組、備註、自定義列只存在本地，可以撤銷。
- 用戶說「同步 / 刷新列表」用 sync_mailboxes；收郵件、驗證碼用 fetch_mail({email, which:"email"})。
- 可用域名：${JSON.stringify(this.selfDomains)}` : ''}
${learned ? '\n' + learned + '\n' : ''}
當前狀態：${JSON.stringify(ctx)}`;
    },

    // ---------- 執行工具 ----------
    async agentExec(tc, name, args) {
      const level = agentConfirmLevel(name, args);
      if (level === 'danger' || (level === 'write' && !this.prefs.agentAuto)) {
        tc.desc = await this.agentDescribe(name, args);
        tc.code = name === 'run_command' ? agentFormatCommand(args.command) : '';
        tc.danger = level === 'danger';
        tc.status = 'confirm';
        this.agentScroll();
        const ok = await new Promise(resolve => { tc.resolve = resolve; });
        tc.status = 'running';
        tc.started = Date.now();
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
        case 'manage_families': return this.agentManageFamilies(args);
        case 'manage_sheets': return this.agentManageSheets(args);
        case 'get_2fa_codes': return this.agent2fa(args);
        case 'use_backup_code': {
          const a = this.accounts.find(x => x.email.toLowerCase() === String(args.email || '').trim().toLowerCase());
          if (!a) return { error: `no account "${args.email}" in the current sheet` };
          const i = this.backupList(a).findIndex(x => !x.used);
          if (i < 0) return { error: 'no unused backup codes left', total: this.backupList(a).length };
          const code = this.backupList(a)[i].code;
          await this.copyBackup(a, i, true, 'agent');
          const out = { copied: true, number: i + 1, left: this.backupLeft(a), total: this.backupList(a).length };
          if (this.prefs.agentSecrets) out.code = code;
          return out;
        }
        case 'fetch_mail': return this.agentFetchMail(args);
        case 'copy_to_clipboard': return this.agentCopy(args);
        case 'export_accounts': {
          const rows = this.agentRows(args.filter);
          const fmt = args.format === 'txt' ? 'txt' : 'csv';
          if (args.path) {  // 直接保存到指定位置；給的是文件夾就自動起文件名
            let path = String(args.path).trim().replace(/^["']|["']$/g, '');
            if (!/\.(csv|txt)$/i.test(path)) {
              const d = new Date(), p2 = n => String(n).padStart(2, '0');
              path = path.replace(/[\\/]+$/, '') + `\\mail_export_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}.${fmt}`;
            }
            const r = await agentCall('fs_write', path, this.buildExport(rows, fmt), false, !!args.overwrite);
            return r.error ? r : { exported: rows.length, path: r.path };
          }
          await this.doExport(fmt, rows);
          return { exported: rows.length };
        }
        case 'fs_list': return agentCall('fs_list', args.path, args.pattern || '', !!args.recursive, args.limit || 200);
        case 'fs_scan_accounts': return this.agentScan(args);
        case 'fs_read': return agentCall('fs_read', args.path, args.offset || 1, args.limit || 200);
        case 'fs_search': return agentCall('fs_search', args.path, args.query || '', !!args.regex, args.pattern || '', args.recursive !== false);
        case 'fs_write': return agentCall('fs_write', args.path, args.content ?? '', !!args.append, !!args.overwrite);
        case 'fs_move': return agentCall('fs_move', args.from, args.to, !!args.copy);
        case 'fs_mkdir': return agentCall('fs_mkdir', args.path);
        case 'fs_open': return agentCall('fs_reveal', args.path);
        case 'run_command': return agentCall('run_command', args.command, args.cwd || '', args.timeout || 60);
        case 'create_recovery_mailboxes': {
          const rows = this.agentRows(args.filter);
          const undoId = this.agentPushUndo(t('agent.tool.create_recovery_mailboxes'), { rows: this.agentSnapshot(rows) });
          const r = await withProgress(pid => agentCall('create_recovery_mailboxes', rows.map(a => a.id), args.domain, !!args.overwrite, pid),
            p => { tc.progress = p; });
          await this.loadAccounts();
          return { ...r, undo_id: undoId, note: 'undo only restores the fields; created mailboxes stay on the server' };
        }
        case 'open_account': return this.agentOpen(args);
        case 'get_history': return this.agentHistory(args);
        case 'set_preferences': return this.agentPrefs(args);
        case 'undo': return this.agentUndo(args.id);
        case 'read_skill': {
          const s = this.agentSkills.find(x => x.name.toLowerCase() === String(args.name || '').trim().toLowerCase());
          if (!s) return { error: `no skill "${args.name}"`, skills: this.agentSkills.map(x => x.name) };
          s.uses = (s.uses || 0) + 1;
          this.agentSaveKb().catch(() => {});
          return { name: s.name, content: s.content };
        }
        case 'remember': return this.agentRemember(args.content, args.replace_id, 'ai');
        case 'forget': {
          const n = this.kb.memories.length;
          this.kb.memories = this.kb.memories.filter(m => m.id !== args.id);
          if (this.kb.memories.length === n) return { error: `no memory "${args.id}"` };
          await this.agentSaveKb();
          return { forgot: args.id };
        }
        case 'save_skill': return this.agentUpsertSkill({ name: args.name, description: args.description, content: args.content }, 'ai');
        case 'create_mailboxes': return this.agentCreateMailboxes(args, tc);
        case 'sync_mailboxes': {
          const r = await agentCall('selfmail_sync');
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
              args.items.slice(0, 8).map(it => `${it.email}：${[kv(it.set), kv(it.columns), this.agentDescribeEdits(it.edits)].filter(Boolean).join('，')}`).join('\n') +
              (args.items.length > 8 ? '\n…' : '');
            return t('agent.confirm.update', { n: this.agentRows(args.filter).length }) + '\n' +
              [kv(args.set), kv(args.columns), this.agentDescribeEdits(args.edits)].filter(Boolean).join('，');
          case 'add_accounts': {
            const list = args.accounts || [];
            return t('agent.confirm.add', { n: list.length, s: args.sheet || this.sheetName(this.currentSheet) }) + '\n' +
              list.slice(0, 6).map(a => a.email).join('\n') + (list.length > 6 ? '\n…' : '') +
              (args.group || args.status ? '\n' + kv({ group: args.group, status: args.status }) : '') +
              (colNames(list).length ? '\n' + t('agent.confirm.columns', { s: colNames(list).join('、') }) : '');
          }
          case 'import_text': {
            const sc = args.scan_id && this._agentScans?.[args.scan_id];
            const p = parseImport(sc ? sc.emails.map(e => sc.lines[e]).join('\n') : args.text || '', 'auto', 'smart', []);
            const keep = args.keep_unrecognized !== false;
            const partial = keep ? p.failed.filter(f => f.row).length : 0;
            return t('agent.confirm.add', { n: p.rows.length + partial, s: args.sheet || this.sheetName(this.currentSheet) }) +
              (partial ? '\n' + t('agent.confirm.partial', { n: partial }) : '') +
              (p.failed.length - partial ? '\n' + t('import.failed', { n: p.failed.length - partial }) : '') +
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
          case 'fs_read': case 'fs_search': return t('agent.confirm.fsRead') + '\n' + args.path + (args.query ? `\n🔍 ${args.query}` : '');
          case 'fs_write': return t(args.append ? 'agent.confirm.fsAppend' : args.overwrite ? 'agent.confirm.fsOverwrite' : 'agent.confirm.fsWrite') +
            '\n' + args.path + '\n' + String(args.content ?? '').slice(0, 300) + (String(args.content ?? '').length > 300 ? '…' : '');
          case 'fs_move': return t(args.copy ? 'agent.confirm.fsCopy' : 'agent.confirm.fsMove') + `\n${args.from}\n→ ${args.to}`;
          case 'fs_mkdir': return t('agent.confirm.fsMkdir') + '\n' + args.path;
          case 'run_command': return t('agent.confirm.command') + (args.cwd ? `\n📁 ${args.cwd}` : '') +
            (String(args.command || '').length > 300 ? '\n' + t('agent.confirm.longCommand', { n: String(args.command).length }) : '');
          case 'export_accounts': return t('agent.confirm.exportTo', { n: this.agentRows(args.filter).length }) + '\n' + args.path;
          case 'manage_families': {
            if (args.action === 'delete') return t('agent.confirm.deleteFamily', { s: args.name });
            const who = [args.owner ? FAMILY_ICONS.owner + ' ' + args.owner : '', ...(args.members || []), args.filter ? t('agent.confirm.byFilter', { n: this.agentRows(args.filter).length }) : '']
              .filter(Boolean);
            const info = [[t('family.name'), args.new_name], [t('family.kind'), args.kind], [t('family.max'), args.max_members], [t('col.notes'), args.notes]]
              .filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k} = ${v}`).join('，');
            return `${t('agent.fam.' + args.action)}「${args.name || ''}」` + (info ? '\n' + info : '') +
              (who.length ? '\n' + who.slice(0, 8).join('\n') + (who.length > 8 ? '\n…' : '') : '');
          }
        }
      } catch (e) { return errText(e); }
      return name;
    },

    // ---------- 操作記錄 ----------
    async agentHistory(args) {
      const q = { email: args.email || '', field: args.field || '', actor: args.actor || '', search: args.search || '',
        limit: Math.max(1, Math.min(parseInt(args.limit, 10) || 20, 100)) };
      if (args.days) q.start = Date.now() - parseInt(args.days, 10) * 86400000;
      const r = await agentCall('list_audit', q);
      const secret = f => AGENT_SECRET_FIELDS.includes(f) && !this.prefs.agentSecrets;
      const hide = (f, v) => (secret(f) && v ? '(hidden)' : v);
      return {
        total: r.total,
        items: r.items.map(it => {
          let before = it.before;
          if (it.action === 'delete') {  // 刪除前的字段：密碼類按權限隱藏
            try { before = Object.fromEntries(Object.entries(JSON.parse(it.before)).map(([k, v]) => [k, hide(k, v)])); } catch { /* 保持原樣 */ }
          }
          return { time: this.histTime(it.ts), actor: it.actor, action: it.action, email: it.email || undefined, sheet: it.sheet || undefined,
            field: it.field || undefined, before: it.action === 'delete' ? before : hide(it.field, before), after: hide(it.field, it.after) };
        }),
        note: this.prefs.agentSecrets ? undefined : 'secret values are hidden; the user can allow reading secrets in the assistant panel',
      };
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
        const newId = await agentCall('add_sheet', u.sheet.name);
        await agentCall('set_sheet_columns', newId, u.sheet.columns);
        rows = rows.map(r => ({ ...r, sheet_id: newId }));
      }
      if (u.columns) await agentCall('set_sheet_columns', u.columns.sheetId, u.columns.columns);
      if (u.prefs) Object.assign(this.prefs, JSON.parse(JSON.stringify(u.prefs)));
      if (u.order) await agentCall('reorder', u.order.kind, u.order.ids);
      if (u.family) await agentCall('restore_family', u.family);
      if (u.familyCreated) await agentCall('delete_family', u.familyCreated);
      if (u.addedIds?.length) await agentCall('delete_accounts', u.addedIds);
      if (rows.length) await agentCall('restore_accounts', rows);
      for (const m of this.agent.items) for (const tc of m.tools || []) if (tc.undoId === u.id) { tc.undoId = ''; tc.undone = true; }
      await this.reload();
      this.agentSaveSoon();
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
      if (f.scan_id) { const set = new Set(this.agentScanOrThrow(f.scan_id).emails); list = list.filter(a => set.has(a.email.toLowerCase())); }
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
        case 'group': return this.accGroupNames(a).join(', ');
        case 'family': return this.accFamilyNames(a).join(', ');
        case 'family_role': { const fs = this.accFamilies(a); return fs.some(f => f.role === 'owner') ? 'owner' : fs.length ? 'member' : ''; }
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
      if ((field === 'group' || field === 'family') && ['eq', 'ne', 'in'].includes(op)) {
        const names = (field === 'group' ? this.accGroupNames(a) : this.accFamilyNames(a)).map(x => x.toLowerCase());
        const wants = (op === 'in' ? (Array.isArray(c.value) ? c.value : String(c.value).split(/[,，]/)) : [c.value])
          .map(x => String(x ?? '').trim().toLowerCase());
        const hit = wants.some(w => (w === '' || w === 'none' ? !names.length : names.includes(w)));
        return op === 'ne' ? !hit : hit;
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
      if (want('group') || want('groups')) out.groups = this.accGroupNames(a);
      if ((want('family') || want('families')) && (this.accFamilies(a).length || !all))
        out.families = this.accFamilies(a).map(f => ({ name: this.familyMap[f.id].name, role: f.role }));
      if (want('notes') && (a.notes || !all)) out.notes = (a.notes || '').slice(0, 300);
      for (const f of AGENT_SECRET_FIELDS) {
        if (secrets && (all || want(f))) out[f] = a[f] || '';
        else if (want(f) || want('has_' + f)) out['has_' + f] = !!a[f];
      }
      if (a.backup_codes && (all || want('backup_codes') || want('backup_codes_left'))) {
        out.backup_codes_left = this.backupLeft(a);
        out.backup_codes_total = this.backupList(a).length;
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
      const id = await agentCall('add_group', name, color ? this.agentColor(color) : this.randomColor());
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
      await agentCall('set_sheet_columns', this.sheetId, [...this.currentSheet.columns, col]);
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
      if (args.group_by === 'group') {
        for (const a of rows) {
          const names = this.accGroupNames(a);
          for (const n of names.length ? names : ['(empty)']) counts[n] = (counts[n] || 0) + 1;
        }
        const groups = Object.entries(counts).sort((x, y) => y[1] - x[1]).map(([value, count]) => ({ value, count }));
        return { total: rows.length, groups, note: 'an account can be in several groups, so counts may add up to more than total' };
      }
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
        const rows = s.id === this.sheetId ? this.accounts : await agentCall('list_accounts', s.id);
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
      if (args.family !== undefined && !SELFMAIL) {
        const v = String(args.family || '').trim();
        const fam = this.families.find(x => x.name.toLowerCase() === v.toLowerCase());
        if (v && !['owner', 'none'].includes(v) && !fam) throw new Error(`unknown family "${v}"`);
        f.family = !v ? '' : (fam ? fam.id : v);
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
        const groups = [...(raw.groups || []), ...(raw.group != null ? [raw.group] : (raw.groups ? [] : [opts.group]))].filter(x => x != null && x !== '');
        prepared.push({ row, columns, country: raw.country, status: raw.status || opts.status, groups });
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
      // 每行帶自己的分組（可多個），按狀態分批導入
      const buckets = new Map();
      for (const p of prepared) {
        const status = p.status ? this.agentStatusOrThrow(p.status) : this.meta.statuses[0];
        p.row.group_ids = [];
        for (const n of p.groups) { const id = await this.agentGroupId(n, true); if (id && !p.row.group_ids.includes(id)) p.row.group_ids.push(id); }
        if (!buckets.has(status)) buckets.set(status, { status, rows: [] });
        buckets.get(status).rows.push(p.row);
      }
      let added = 0, skipped = 0;
      const ids = [];
      for (const b of buckets.values()) {
        const r = await agentCall('import_rows', this.sheetId, b.rows, null, b.status, opts.skip_duplicates !== false, {});
        added += r.added; skipped += r.skipped; ids.push(...(r.ids || []));
      }
      const undoId = ids.length ? this.agentPushUndo(t('agent.tool.add_accounts') + ' ' + ids.length, { addedIds: ids }) : '';
      await this.loadAccounts();
      await this.refreshState();
      return { added, skipped, invalid, sheet: this.sheetName(this.currentSheet), undo_id: undoId };
    },
    async agentImportText(args) {
      if (args.scan_id) {
        const sc = this.agentScanOrThrow(args.scan_id);
        args = { ...args, text: sc.emails.map(e => sc.lines[e]).join('\n') };
      }
      if (!String(args.text || '').trim()) throw new Error('text or scan_id is required');
      const p = parseImport(args.text || '', 'auto', 'smart', []);
      // 有郵箱但帶了認不出的內容的行：默認照樣導入，多出來的內容放進備註，不丟數據
      const keep = args.keep_unrecognized !== false;
      const partial = keep ? p.failed.filter(f => f.row) : [];
      const failed = p.failed.filter(f => !keep || !f.row);
      const accounts = [...p.rows, ...partial.map(f => f.row)].map(({ country, ...r }) => ({ ...r, country, columns: args.columns }));
      const r = await this.agentAdd(accounts, args);
      const out = { ...r, failed_total: failed.length, failed: failed.slice(0, 20).map(f => ({ line: f.n, raw: f.raw, reason: t(f.reason[0], f.reason[1]) })) };
      if (partial.length) Object.assign(out, { partial: partial.length, partial_note: 'imported; content that matched no field was kept in notes' });
      return out;
    },

    // ---------- 修改 / 刪除 / 移動 ----------
    async agentUpdate(args) {
      const index = this.agentIndexMap();
      const jobs = [];
      if (args.items?.length) {
        for (const it of args.items) {
          const email = String(it.email || '').trim().toLowerCase();
          jobs.push({ email, rows: this.accounts.filter(a => a.email.toLowerCase() === email), set: it.set || {}, columns: it.columns || {},
            edits: it.edits || [] });
        }
      } else {
        jobs.push({ rows: this.agentRows(args.filter), set: args.set || {}, columns: args.columns || {}, edits: args.edits || [] });
      }
      const notFound = jobs.filter(j => j.email && !j.rows.length).map(j => j.email);
      const affected = [...new Map(jobs.flatMap(j => j.rows).map(a => [a.id, a])).values()];
      if (!affected.length) return { updated: 0, not_found: notFound };
      for (const job of jobs) if (job.set.status) this.agentStatusOrThrow(job.set.status);  // 先校驗，出錯不留撤銷記錄
      for (const job of jobs) for (const e of job.edits) this.agentEditTarget(e.field);  // 先校驗字段，出錯不留撤銷記錄
      const serverSide = SELFMAIL && jobs.some(j => j.set.password != null || j.set.status != null ||
        j.edits.some(e => this.agentEditTarget(e.field).field === 'password'));
      let edited = 0;
      const undoId = serverSide ? '' : this.agentPushUndo(t('agent.tool.update_accounts') + ' ' + affected.length, { rows: this.agentSnapshot(affected) });
      for (const job of jobs) {
        if (!job.rows.length) continue;
        const ids = job.rows.map(a => a.id);
        const set = job.set;
        if (set.status != null && set.status !== '') await agentCall('set_status', ids, this.agentStatusOrThrow(set.status));
        if (set.groups != null) {
          const gids = [];
          for (const n of set.groups) { const id = await this.agentGroupId(n, true); if (id) gids.push(id); }
          await agentCall('set_groups', ids, gids);
        } else if (set.group != null) {
          const id = await this.agentGroupId(set.group, true);
          await agentCall('set_groups', ids, id ? [id] : []);
        }
        for (const n of set.add_groups || []) { const id = await this.agentGroupId(n, true); if (id) await agentCall('add_to_group', ids, id); }
        for (const n of set.remove_groups || []) { const id = await this.agentGroupId(n, false).catch(() => null); if (id) await agentCall('remove_from_group', ids, id); }
        const fieldKeys = AGENT_TEXT_FIELDS.filter(f => set[f] != null);
        const fieldEdits = job.edits.filter(e => this.agentEditTarget(e.field).field);
        if (fieldKeys.length || set.append_notes || fieldEdits.length) {
          const updates = [];
          for (const a of job.rows) {
            const fields = {};
            for (const f of fieldKeys) fields[f] = this.agentTemplate(set[f], a, index);
            if (set.append_notes) fields.notes = [fields.notes ?? a.notes, this.agentTemplate(set.append_notes, a, index)].filter(Boolean).join('\n');
            let changed = false;
            for (const e of fieldEdits) {  // 局部修改：在（可能已覆蓋的）當前值上改
              const f = this.agentEditTarget(e.field).field;
              const before = fields[f] ?? a[f] ?? '';
              const after = this.agentApplyEdit(before, e, a, index);
              if (after !== before) { fields[f] = after; changed = true; }
            }
            if (changed) edited++;
            if (Object.keys(fields).length) updates.push({ id: a.id, fields });
          }
          if (updates.length) await agentCall('update_fields', updates);
        }
        // 自定義列的局部修改
        const colEdits = job.edits.filter(e => this.agentEditTarget(e.field).col);
        if (colEdits.length) {
          const byCol = new Map();
          for (const e of colEdits) {
            const col = this.agentEditTarget(e.field).col;
            if (!byCol.has(col.id)) byCol.set(col.id, { col, edits: [] });
            byCol.get(col.id).edits.push(e);
          }
          for (const { col, edits } of byCol.values()) {
            const byValue = new Map();
            for (const a of job.rows) {
              const before = String(job.columns[col.name] ?? a.extra?.[col.id] ?? '');
              let after = before;
              for (const e of edits) after = this.agentApplyEdit(after, e, a, index);
              if (after === before) continue;
              edited++;
              const v = this.agentColumnValue(col, after);
              if (!byValue.has(v)) byValue.set(v, []);
              byValue.get(v).push(a.id);
            }
            for (const [v, vids] of byValue) await agentCall('set_extra', vids, col.id, v || null);
          }
        }
        for (const [name, value] of Object.entries(job.columns)) {
          const col = await this.agentEnsureColumn(name, value);
          const byValue = new Map();
          for (const a of job.rows) {
            const v = this.agentColumnValue(col, this.agentTemplate(value, a, index));
            if (!byValue.has(v)) byValue.set(v, []);
            byValue.get(v).push(a.id);
          }
          for (const [v, vids] of byValue) await agentCall('set_extra', vids, col.id, v || null);
        }
      }
      await this.loadAccounts();
      await this.refreshState();
      const out = { updated: affected.length, not_found: notFound, undo_id: undoId };
      if (jobs.some(j => j.edits.length)) out.edited = edited;
      return out;
    },
    // edits 的目標：內置文字字段（可用字段名或四種語言的列名）或自定義列
    agentEditTarget(name) {
      const n = String(name || '').trim();
      if (AGENT_TEXT_FIELDS.includes(n)) return { field: n };
      const byLabel = AGENT_TEXT_FIELDS.find(f => Object.values(I18N).some(d => (d['col.' + f] || '').toLowerCase() === n.toLowerCase()));
      if (byLabel) return { field: byLabel };
      const col = this.agentColumn(n);
      if (col && col.type !== 'image') return { col };
      throw new Error(`cannot edit "${name}" (use a text field or a custom column name)`);
    },
    agentApplyEdit(value, e, a, index) {
      const s = String(value ?? '');
      const val = this.agentTemplate(e.value ?? '', a, index);
      if (e.op === 'prepend') return val + s;
      if (e.op === 'append') return s + val;
      if (e.op !== 'replace' && e.op !== 'remove') throw new Error('unknown edit op ' + e.op);
      if (!e.find) throw new Error('edits: find is required for ' + e.op);
      const flags = 'g' + (e.ignore_case ? 'i' : '');
      const re = e.regex ? new RegExp(e.find, flags) : new RegExp(e.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      const rep = e.op === 'remove' ? '' : val;
      return e.regex ? s.replace(re, rep) : s.replace(re, () => rep);
    },
    agentDescribeEdits(edits) {
      return (edits || []).map(e => {
        const f = (() => { try { const x = this.agentEditTarget(e.field); return x.col ? x.col.name : t('col.' + x.field); } catch { return e.field; } })();
        return t('agent.edit.' + e.op, { f, a: e.find || '', b: e.value || '' });
      }).join('，');
    },

    // ---------- 技能和經驗 ----------
    agentNewId(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); },
    async agentRemember(content, replaceId, source) {
      content = String(content || '').trim();
      if (!content) return { error: 'empty memory' };
      const mems = this.kb.memories;
      const old = replaceId && mems.find(m => m.id === replaceId);
      if (old) Object.assign(old, { content, updated: Date.now() });
      else if (!mems.some(m => m.content === content)) {
        mems.push({ id: this.agentNewId('m'), content, enabled: true, source, created: Date.now(), updated: Date.now() });
        // 最多保留 100 條，超出時先刪最早的自動經驗
        while (mems.length > 100) mems.splice(Math.max(0, mems.findIndex(m => m.source !== 'user')), 1);
      }
      await this.agentSaveKb();
      return { memory: content, id: old ? old.id : mems[mems.length - 1].id };
    },
    async agentUpsertSkill(sk, source) {
      const name = String(sk.name || '').trim().slice(0, 40);
      const content = String(sk.content || '').trim();
      if (!name || !content) return { error: 'name and content are required' };
      const skills = this.kb.skills;
      const old = skills.find(s => s.name.toLowerCase() === name.toLowerCase());
      if (old) {
        if (old.content !== content) {
          old.history = [{ content: old.content, description: old.description, updated: old.updated }, ...(old.history || [])].slice(0, 10);
        }
        Object.assign(old, { content, description: String(sk.description || old.description || '').trim(), updated: Date.now() });
      } else {
        skills.push({ id: this.agentNewId('s'), name, description: String(sk.description || '').trim(), content,
          mode: sk.mode || (source === 'user' ? 'auto' : 'manual'), scope: 'all', source, uses: 0, created: Date.now(), updated: Date.now(), history: [] });
        while (skills.length > 100) skills.splice(Math.max(0, skills.findIndex(s => s.source !== 'user')), 1);
      }
      await this.agentSaveKb();
      return { skill: name, updated: !!old };
    },
    // 對話結束（新建 / 切換對話）後在後台總結經驗，寫進經驗和技能
    agentReflectCurrent() {
      const agent = this.agent;
      if (!this.agentCfg.agent_learn || !this.agentCfg.agent_reflect || !agent.chatId) return;
      const userTurns = agent.items.filter(m => m.role === 'user').length;
      const key = String(agent.chatId);
      if (userTurns < 2 || (this.kb.reflected[key] || 0) >= agent.items.length) return;
      this.agentReflect(JSON.parse(JSON.stringify(agent.items)), key, true).catch(() => {});
    },
    agentCompactTranscript(items) {
      const lines = [];
      for (const m of items) {
        if (m.role === 'user') lines.push(`用戶：${(m.text || '').slice(0, 1500)}${m.images?.length ? ' [圖片]' : ''}`);
        else {
          for (const tc of m.tools || []) lines.push(`  工具 ${tc.name} ${String(tc.args || '').slice(0, 400)} → ${tc.status} ${String(tc.summary || '').slice(0, 200)}`);
          if (m.text) lines.push(`助手：${m.text.slice(0, 1200)}`);
          if (m.error) lines.push(`  錯誤：${m.error}`);
        }
      }
      return lines.join('\n').slice(-14000);
    },
    async agentReflect(items, key, quiet) {
      const kb = this.kb;
      const prompt = `你是「郵箱管理」AI 助手的學習模塊。下面是用戶和助手的一段對話記錄（含工具調用）。請總結值得長期記住的東西，讓助手以後做得更好：
1. memories：用戶的偏好、習慣、說法的含義、對助手的糾正（例如「用戶說『第一列』通常指排在第一位」）。只記穩定、以後還用得上的；不要記郵箱地址、密碼、一次性的數據；已有經驗裡有的不要重複。
2. skills：對話裡完成了一個以後可能重複的多步任務、或用戶教了一種做法時，寫成技能：name 簡短；description 一句話說明什麼時候用；content 寫清楚步驟、要用的工具和參數要點、注意事項。已有同名技能時給出改進後的完整版本。
已有經驗：${JSON.stringify(kb.memories.map(m => m.content))}
已有技能：${JSON.stringify(kb.skills.map(s => ({ name: s.name, description: s.description })))}
只輸出一個 JSON 對象，不要其他文字：{"memories": ["..."], "skills": [{"name": "", "description": "", "content": ""}]}；沒有值得記的就輸出 {"memories": [], "skills": []}。`;
      const job = await agentCall('ai_chat_start', [{ role: 'system', content: prompt }, { role: 'user', content: this.agentCompactTranscript(items) }], null);
      let text = '';
      await pollAiJob(job, d => { text += d; });
      const m = /\{[\s\S]*\}/.exec(text.replace(/```(json)?/g, ''));
      if (!m) return { memories: 0, skills: 0 };
      let data;
      try { data = JSON.parse(m[0]); } catch { return { memories: 0, skills: 0 }; }
      let nm = 0, ns = 0;
      for (const c of (data.memories || []).slice(0, 5)) {
        const r = await this.agentRemember(typeof c === 'string' ? c : c?.content, null, 'auto');
        if (!r.error) nm++;
      }
      for (const s of (data.skills || []).slice(0, 3)) {
        const r = await this.agentUpsertSkill(s || {}, 'auto');
        if (!r.error) ns++;
      }
      kb.reflected[key] = items.length;
      const keys = Object.keys(kb.reflected);
      if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete kb.reflected[k];
      await this.agentSaveKb();
      if (nm || ns) this.toast(t('agent.learned', { m: nm, s: ns }));
      else if (!quiet) this.toast(t('agent.learnedNone'));
      return { memories: nm, skills: ns };
    },

    // ---------- 技能與經驗管理窗口 ----------
    openKb(tab) {
      this.kbEdit = { tab: tab || 'skills', skills: JSON.parse(JSON.stringify(this.kb.skills)), memories: JSON.parse(JSON.stringify(this.kb.memories)),
        open: {}, busy: false };
    },
    kbAddSkill() {
      const s = { id: this.agentNewId('s'), name: '', description: '', content: '', mode: 'auto', scope: 'all', source: 'user',
        uses: 0, created: Date.now(), updated: Date.now(), history: [] };
      this.kbEdit.skills.unshift(s);
      this.kbEdit.open[s.id] = true;
    },
    kbAddMemory() {
      this.kbEdit.memories.unshift({ id: this.agentNewId('m'), content: '', enabled: true, source: 'user', created: Date.now(), updated: Date.now() });
    },
    kbRollback(s, h) {
      s.history = [{ content: s.content, description: s.description, updated: s.updated }, ...s.history.filter(x => x !== h)].slice(0, 10);
      Object.assign(s, { content: h.content, description: h.description || s.description, updated: Date.now() });
    },
    async kbSave() {
      const e = this.kbEdit;
      this.kb.skills = e.skills.filter(s => s.name.trim() && s.content.trim()).map(s => ({ ...s, name: s.name.trim() }));
      this.kb.memories = e.memories.filter(m => m.content.trim()).map(m => ({ ...m, content: m.content.trim() }));
      await this.agentSaveKb();
      this.kbEdit = null;
      this.toast(t('kb.saved'));
    },
    async kbReflectNow() {
      if (!this.agent.items.some(m => m.role === 'user')) return this.toast(t('kb.noChat'), 'error');
      this.kbEdit.busy = true;
      try {
        await this.agentReflect(JSON.parse(JSON.stringify(this.agent.items)), String(this.agent.chatId || 'current'), false);
        this.openKb(this.kbEdit?.tab);
      } catch (err) { this.toast(errText(err), 'error'); if (this.kbEdit) this.kbEdit.busy = false; }
    },
    agentInsertSkill(s) {
      this.agent.input = `/${s.name} ` + this.agent.input.replace(/^\/\S+\s*/, '');
      this.agent.skillMenu = false;
      nextTick(() => this.$refs.agentInput?.focus());
    },
    async agentDelete(args) {
      const rows = this.agentRows(args.filter);
      if (!rows.length) return { deleted: 0 };
      const undoId = SELFMAIL ? '' : this.agentPushUndo(t('agent.tool.delete_accounts') + ' ' + rows.length, { rows: this.agentSnapshot(rows) });
      await agentCall('delete_accounts', rows.map(a => a.id));
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
        await agentCall('add_sheet', name);
        await this.refreshState();
        sheet = this.visibleSheets.find(s => s.name === name);
      }
      if (sheet.id === this.sheetId) return { moved: 0, sheet: name, note: 'already in this sheet' };
      const undoId = this.agentPushUndo(t('agent.tool.move_to_sheet') + ' ' + rows.length, { rows: this.agentSnapshot(rows) });
      await agentCall('move_accounts', rows.map(a => a.id), sheet.id);
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
          await agentCall('set_sheet_columns', this.sheetId, next);
          await this.refreshState();
          return { ok: true, column: next.find(c => c.id === col.id) };
        }
        case 'delete': {
          const col = needCustom();
          // 列的值還留在數據庫裡，撤銷時把列加回來就恢復了
          const undoId = this.agentPushUndo(t('agent.tool.manage_columns') + ' ' + col.name, { columns: { sheetId: this.sheetId, columns: JSON.parse(JSON.stringify(cols)) } });
          await agentCall('set_sheet_columns', this.sheetId, cols.filter(c => c.id !== col.id));
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
    // ---------- 操作電腦：統計文件裡的郵箱 ----------
    // 掃描結果（全部郵箱 + 原始行）只留在本地，給 AI 的是統計和 scan_id，密碼不會發給 AI
    async agentScan(args) {
      const r = await agentCall('fs_scan', args.path, args.pattern || '', args.recursive !== false);
      if (r.error) return r;
      const id = 'scan' + (Object.keys(this._agentScans || {}).length + 1);
      this._agentScans = { ...(this._agentScans || {}), [id]: { emails: r.emails, lines: r.lines, path: r.path } };
      const inSheet = new Set(this.accounts.map(a => a.email.toLowerCase()));
      const cur = r.emails.filter(e => inSheet.has(e));
      const other = r.emails.filter(e => !inSheet.has(e) && r.sheets[e]);
      const sheetNames = ids => [...new Set(ids)].map(sid => this.sheetName(this.sheets.find(s => s.id === sid) || { name: '?' }));
      const out = {
        scan_id: id, path: r.path, files_with_accounts: r.files.length, files_scanned: r.files_scanned,
        files: r.files.slice(0, 50), unique_emails: r.emails.length, duplicate_lines: r.duplicates,
        in_current_sheet: cur.length, in_other_sheets: other.length, not_in_sheet: r.emails.length - cur.length,
        not_in_any_sheet: r.emails.length - cur.length - other.length,
        domains: Object.entries(r.emails.reduce((m, e) => { const d = domainOf(e); m[d] = (m[d] || 0) + 1; return m; }, {}))
          .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([domain, count]) => ({ domain, count })),
        skipped_files: r.skipped.length ? r.skipped : undefined,
      };
      if (other.length) out.other_sheets = sheetNames(other.flatMap(e => r.sheets[e]));
      if (r.emails.length <= 100) out.emails = r.emails; else out.sample = r.emails.slice(0, 20);
      return out;
    },
    agentScanOrThrow(id) {
      const sc = this._agentScans?.[id];
      if (!sc) throw new Error(`scan "${id}" not found (scans are kept only until the app is closed), run fs_scan_accounts again`);
      return sc;
    },

    // ---------- 家庭組 ----------
    // 郵箱地址 → 賬號 id（先找當前列表，找不到再到所有列表裡找）
    async agentAccountIds(emails) {
      const ids = [], notFound = [];
      for (const raw of emails || []) {
        const e = String(raw || '').trim().toLowerCase();
        if (!e) continue;
        let id = this.accounts.find(a => a.email.toLowerCase() === e)?.id;
        if (!id) id = (await agentCall('find_accounts', e, 5)).find(r => r.email.toLowerCase() === e)?.id;
        if (id) { if (!ids.includes(id)) ids.push(id); } else notFound.push(raw);
      }
      return { ids, notFound };
    },
    agentFamilySnapshot(f) { return JSON.parse(JSON.stringify(f)); },
    async agentManageFamilies(args) {
      const find = () => {
        const f = this.families.find(x => x.name.toLowerCase() === String(args.name || '').trim().toLowerCase());
        if (!f) throw new Error(`no family "${args.name}", existing: ${this.families.map(x => x.name).join(', ') || '(none)'}`);
        return f;
      };
      const describe = f => ({ name: f.name, kind: f.kind || undefined, max_members: f.max_members || undefined, notes: f.notes || undefined,
        owner: this.famOwner(f)?.email || '', members: f.members.filter(m => m.role !== 'owner').map(m => m.email),
        count: f.members.length, over_limit: this.famOver(f) || undefined });
      const members = async () => {
        const { ids, notFound } = await this.agentAccountIds(args.members);
        if (args.filter) for (const a of this.agentRows(args.filter)) if (!ids.includes(a.id)) ids.push(a.id);
        return { ids, notFound };
      };
      const done = async (fid, extra = {}) => {
        await this.afterFamily();
        const f = this.familyMap[fid];
        return { family: f?.name, members: f?.members.length, owner: f ? this.famOwner(f)?.email || '' : undefined,
          over_limit: f && this.famOver(f) ? `${f.members.length}/${f.max_members}` : undefined, ...extra };
      };
      switch (args.action) {
        case 'list': return { families: this.families.map(describe) };
        case 'create': {
          if (!String(args.name || '').trim()) throw new Error('name is required');
          const { ids, notFound } = await members();
          let owner = null;
          if (args.owner) {
            const r = await this.agentAccountIds([args.owner]);
            if (!r.ids.length) throw new Error(`owner "${args.owner}" not found in any sheet`);
            owner = r.ids[0];
          }
          const fid = await agentCall('add_family', { name: args.name, kind: args.kind || '', notes: args.notes || '',
            max_members: args.max_members ?? 6, color: this.randomColor() }, owner, ids);
          const undoId = this.agentPushUndo(t('agent.tool.manage_families') + ' ' + args.name, { familyCreated: fid });
          return done(fid, { not_found: notFound.length ? notFound : undefined, undo_id: undoId });
        }
      }
      const f = find();
      const undoId = this.agentPushUndo(t('agent.tool.manage_families') + ' ' + f.name, { family: this.agentFamilySnapshot(f) });
      switch (args.action) {
        case 'update': {
          const data = {};
          if (args.new_name) data.name = args.new_name;
          for (const k of ['kind', 'notes', 'max_members']) if (args[k] !== undefined) data[k] = args[k];
          await agentCall('update_family', f.id, data);
          return done(f.id, { undo_id: undoId });
        }
        case 'delete': {
          await agentCall('delete_family', f.id);
          if (this.filters.family === f.id) this.filters.family = '';
          await this.afterFamily();
          return { deleted: f.name, undo_id: undoId };
        }
        case 'add_members': case 'remove_members': {
          const { ids, notFound } = await members();
          if (!ids.length) return { error: 'no matching accounts', not_found: notFound };
          await agentCall(args.action === 'add_members' ? 'family_add' : 'family_remove', f.id, ids);
          return done(f.id, { [args.action === 'add_members' ? 'added' : 'removed']: ids.length, not_found: notFound.length ? notFound : undefined, undo_id: undoId });
        }
        case 'set_owner': {
          let owner = null;
          if (args.owner) {
            const r = await this.agentAccountIds([args.owner]);
            if (!r.ids.length) throw new Error(`owner "${args.owner}" not found in any sheet`);
            owner = r.ids[0];
          }
          await agentCall('family_set_owner', f.id, owner);
          return done(f.id, { undo_id: undoId });
        }
      }
      this.agent.undo.pop();
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
          await agentCall('update_group', g.id, args.action === 'rename' ? String(args.new_name || g.name) : g.name,
            args.color ? this.agentColor(args.color) : g.color);
          await this.refreshState();
          return { ok: true };
        }
        case 'move': return this.agentMoveItem('groups', find(), args);
        case 'delete': {
          const g = find();
          await agentCall('delete_group', g.id);
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
      await agentCall('reorder', kind, rest);
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
          await agentCall('add_sheet', name);
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
          await agentCall('rename_sheet', s.id, String(args.new_name || '').trim() || s.name);
          await this.refreshState();
          return { ok: true };
        }
        case 'switch': {
          let s = this.agentSheet(name);
          if (!s && args.create) { await agentCall('add_sheet', name); await this.refreshState(); s = this.agentSheet(name); }
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
          const rows = await agentCall('list_accounts', s.id);
          const undoId = this.agentPushUndo(t('agent.tool.manage_sheets') + ' ' + this.sheetName(s),
            { rows, sheet: { name: s.name, columns: JSON.parse(JSON.stringify(s.columns)) } });
          await agentCall('delete_sheet', s.id);
          await this.reload();
          return { deleted: this.sheetName(s), accounts: rows.length, undo_id: undoId };
        }
      }
      return { error: 'unknown action ' + args.action };
    },

    // ---------- 2FA / 收信 / 複製 ----------
    async agent2fa(args) {
      const rows = this.agentRows(args.filter).filter(a => a.totp_secret).slice(0, 200);
      const codes = rows.length ? await agentCall('totp_codes', rows.map(a => a.totp_secret)) : {};
      return { seconds_left: 30 - (Math.floor(Date.now() / 1000) % 30),
        codes: rows.map(a => ({ email: a.email, code: codes[a.totp_secret] || '' })) };
    },
    async agentFetchMail(args) {
      const a = this.accounts.find(x => x.email.toLowerCase() === String(args.email || '').trim().toLowerCase());
      if (!a) return { error: `no account "${args.email}" in the current sheet` };
      const which = args.which === 'email' ? 'email' : 'recovery';
      const limit = Math.min(50, Math.max(1, parseInt(args.limit, 10) || 5));
      const r = await agentCall('fetch_mail', a.id, which, limit);
      return { address: r.address, total: r.total, messages: r.messages.slice(0, limit).map(m => ({
        from: m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr, subject: m.subject, date: this.fmtDate(m.date),
        folder: m.folder, codes: m.codes, text: (m.text || '').slice(0, 600) })) };
    },
    async agentCreateMailboxes(args, tc) {
      const gid = args.group ? await this.agentGroupId(args.group, true) : null;
      const r = await withProgress(pid => agentCall('selfmail_create', args.domain || '', args.names || [], parseInt(args.count, 10) || 0,
        args.prefix || '', args.password || '', gid, null, pid), p => { if (tc) tc.progress = p; });
      await this.loadAccounts();
      await this.refreshState();
      // 自檢：新建的郵箱是否都在列表裡、都進了分組
      const made = new Set(r.created.map(x => x.email.toLowerCase()));
      const rows = this.accounts.filter(a => made.has(a.email.toLowerCase()));
      const out = { created: r.created.length, emails: r.created.map(x => x.email), failed: r.failed, in_list: rows.length,
        note: 'passwords are saved in the table; use copy_to_clipboard to copy email----password' };
      if (gid) out.in_group = rows.filter(a => this.accGroups(a).includes(gid)).length;
      return out;
    },
    // 面板底部的實時狀態：思考中 / 正在準備指令 / 執行中（進度）/ 等待確認
    agentStatusText() {
      const a = this.agent;
      if (!a.busy) return '';
      const last = a.items[a.items.length - 1];
      if (!last || last.role !== 'assistant') return t('agent.st.thinking');
      const tc = last.tools.find(x => x.status === 'running' || x.status === 'confirm');
      if (tc?.status === 'confirm') return t('agent.st.confirm', { s: this.agentToolLabel(tc.name) });
      if (tc) return t('agent.st.running', { s: this.agentToolLabel(tc.name) }) + (tc.progress?.total ? ` ${tc.progress.done}/${tc.progress.total}` : '');
      if (last.streaming && last.tool) return t('agent.st.preparing', { s: this.agentToolLabel(last.tool), n: last.toolChars });
      if (last.streaming && last.text) return t('agent.st.writing');
      return t('agent.st.thinking');
    },
    agentSecs(start) { return Math.max(0, this.now - Math.floor(start / 1000)); },
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
