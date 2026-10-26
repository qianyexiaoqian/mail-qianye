// 本地 API 接口文檔（API 接口頁面用）：分類、路徑、參數、示例請求和示例返回。
// 標題、說明、參數說明在 i18n.js：apidoc.<id>.title / apidoc.<id>.desc / apidoc.p.<參數名>

const API_DOC_CATS = ['mail', 'meta', 'sys'];

const API_SAMPLE_ACCOUNT = {
  id: 12, email: 'user@gmail.com', password: 'Passw0rd!', totp_secret: 'JBSWY3DPEHPK3PXP', totp_code: '492039', totp_remaining: 17,
  recovery_email: 'user.rec@outlook.com', recovery_password: 'RecPw123', phone: '+1 555-123-4567', status: '正常', notes: '',
  sheet: '默認列表', groups: ['yutoux'], families: [{ name: 'Google 家庭 A', role: 'owner' }],
  backup_codes: ['1234 5678', '2345 6789'], backup_codes_used: 8, oauth_client_id: '', oauth_token: '',
  columns: { 國家: 'US', 編號: '7' }, created_at: 1790000000, updated_at: 1790000000,
};

// params：[參數名, 'yes' 必填 | 'one' 二選一 | '' 可選]
const API_DOCS = [
  {
    id: 'accounts', cat: 'mail', path: '/api/accounts', query: { group: 'yutoux' },
    params: [['sheet', ''], ['group', ''], ['family', ''], ['role', ''], ['status', ''], ['email', ''], ['search', ''], ['has_2fa', ''],
      ['fields', ''], ['limit', ''], ['offset', ''], ['format', ''], ['sep', '']],
    response: { total: 1, offset: 0, limit: 1000, count: 1, accounts: [API_SAMPLE_ACCOUNT] },
  },
  {
    id: 'accountsTxt', cat: 'mail', path: '/api/accounts', query: { format: 'txt', fields: 'email,password,totp_code' },
    params: [['format', 'yes'], ['fields', ''], ['sep', ''], ['sheet', ''], ['group', ''], ['email', ''], ['has_2fa', '']],
    responseText: 'user@gmail.com----Passw0rd!----492039\nuser2@gmail.com----Pw2----\n',
  },
  {
    id: 'account', cat: 'mail', path: '/api/account', query: { email: 'user@gmail.com' },
    params: [['email', 'one'], ['id', 'one']], response: API_SAMPLE_ACCOUNT,
  },
  {
    id: 'twofa', cat: 'mail', path: '/api/2fa', query: { email: 'user@gmail.com' },
    params: [['email', 'one'], ['secret', 'one']],
    response: { codes: [{ email: 'user@gmail.com', code: '492039', remaining: 17 }] },
  },
  {
    id: 'groups', cat: 'meta', path: '/api/groups', query: {}, params: [],
    response: { groups: [{ id: 1, name: 'yutoux', color: '#4f7cff', count: 35 }, { id: 2, name: 'GPT', color: '#30a46c', count: 12 }] },
  },
  {
    id: 'sheets', cat: 'meta', path: '/api/sheets', query: {}, params: [],
    response: { sheets: [{ id: 1, name: '默認列表', kind: 'normal', count: 120, columns: ['國家', '編號'] }] },
  },
  {
    id: 'families', cat: 'meta', path: '/api/families', query: {}, params: [],
    response: { families: [{ id: 1, name: 'Google 家庭 A', kind: 'Google One', max_members: 6, notes: '', owner: 'user@gmail.com',
      members: [{ email: 'user@gmail.com', role: 'owner' }, { email: 'kid@gmail.com', role: 'member' }] }] },
  },
  {
    id: 'health', cat: 'sys', path: '/api/health', query: {}, params: [],
    response: { ok: true, locked: true, readable: true, time: 1790000000 },
  },
  { id: 'auth', cat: 'sys', path: '', query: {}, params: [] },
];

// 狀態碼說明（認證與錯誤碼頁）
const API_STATUS_CODES = [200, 400, 401, 404, 405, 423, 500];
