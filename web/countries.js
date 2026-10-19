// 國家/地區數據：二位代碼:三位代碼:貨幣:電話區號
const COUNTRY_DATA = `AD:AND:EUR:376 AE:ARE:AED:971 AF:AFG:AFN:93 AG:ATG:XCD:1268 AI:AIA:XCD:1264 AL:ALB:ALL:355 AM:ARM:AMD:374
AO:AGO:AOA:244 AQ:ATA::672 AR:ARG:ARS:54 AS:ASM:USD:1684 AT:AUT:EUR:43 AU:AUS:AUD:61 AW:ABW:AWG:297 AX:ALA:EUR:358
AZ:AZE:AZN:994 BA:BIH:BAM:387 BB:BRB:BBD:1246 BD:BGD:BDT:880 BE:BEL:EUR:32 BF:BFA:XOF:226 BG:BGR:BGN:359 BH:BHR:BHD:973
BI:BDI:BIF:257 BJ:BEN:XOF:229 BL:BLM:EUR:590 BM:BMU:BMD:1441 BN:BRN:BND:673 BO:BOL:BOB:591 BQ:BES:USD:599 BR:BRA:BRL:55
BS:BHS:BSD:1242 BT:BTN:BTN:975 BV:BVT:NOK:47 BW:BWA:BWP:267 BY:BLR:BYN:375 BZ:BLZ:BZD:501 CA:CAN:CAD:1 CC:CCK:AUD:61
CD:COD:CDF:243 CF:CAF:XAF:236 CG:COG:XAF:242 CH:CHE:CHF:41 CI:CIV:XOF:225 CK:COK:NZD:682 CL:CHL:CLP:56 CM:CMR:XAF:237
CN:CHN:CNY:86 CO:COL:COP:57 CR:CRI:CRC:506 CU:CUB:CUP:53 CV:CPV:CVE:238 CW:CUW:ANG:599 CX:CXR:AUD:61 CY:CYP:EUR:357
CZ:CZE:CZK:420 DE:DEU:EUR:49 DJ:DJI:DJF:253 DK:DNK:DKK:45 DM:DMA:XCD:1767 DO:DOM:DOP:1809 DZ:DZA:DZD:213 EC:ECU:USD:593
EE:EST:EUR:372 EG:EGY:EGP:20 EH:ESH:MAD:212 ER:ERI:ERN:291 ES:ESP:EUR:34 ET:ETH:ETB:251 FI:FIN:EUR:358 FJ:FJI:FJD:679
FK:FLK:FKP:500 FM:FSM:USD:691 FO:FRO:DKK:298 FR:FRA:EUR:33 GA:GAB:XAF:241 GB:GBR:GBP:44 GD:GRD:XCD:1473 GE:GEO:GEL:995
GF:GUF:EUR:594 GG:GGY:GBP:44 GH:GHA:GHS:233 GI:GIB:GIP:350 GL:GRL:DKK:299 GM:GMB:GMD:220 GN:GIN:GNF:224 GP:GLP:EUR:590
GQ:GNQ:XAF:240 GR:GRC:EUR:30 GS:SGS:GBP:500 GT:GTM:GTQ:502 GU:GUM:USD:1671 GW:GNB:XOF:245 GY:GUY:GYD:592 HK:HKG:HKD:852
HM:HMD:AUD:672 HN:HND:HNL:504 HR:HRV:EUR:385 HT:HTI:HTG:509 HU:HUN:HUF:36 ID:IDN:IDR:62 IE:IRL:EUR:353 IL:ISR:ILS:972
IM:IMN:GBP:44 IN:IND:INR:91 IO:IOT:USD:246 IQ:IRQ:IQD:964 IR:IRN:IRR:98 IS:ISL:ISK:354 IT:ITA:EUR:39 JE:JEY:GBP:44
JM:JAM:JMD:1876 JO:JOR:JOD:962 JP:JPN:JPY:81 KE:KEN:KES:254 KG:KGZ:KGS:996 KH:KHM:KHR:855 KI:KIR:AUD:686 KM:COM:KMF:269
KN:KNA:XCD:1869 KP:PRK:KPW:850 KR:KOR:KRW:82 KW:KWT:KWD:965 KY:CYM:KYD:1345 KZ:KAZ:KZT:7 LA:LAO:LAK:856 LB:LBN:LBP:961
LC:LCA:XCD:1758 LI:LIE:CHF:423 LK:LKA:LKR:94 LR:LBR:LRD:231 LS:LSO:LSL:266 LT:LTU:EUR:370 LU:LUX:EUR:352 LV:LVA:EUR:371
LY:LBY:LYD:218 MA:MAR:MAD:212 MC:MCO:EUR:377 MD:MDA:MDL:373 ME:MNE:EUR:382 MF:MAF:EUR:590 MG:MDG:MGA:261 MH:MHL:USD:692
MK:MKD:MKD:389 ML:MLI:XOF:223 MM:MMR:MMK:95 MN:MNG:MNT:976 MO:MAC:MOP:853 MP:MNP:USD:1670 MQ:MTQ:EUR:596 MR:MRT:MRU:222
MS:MSR:XCD:1664 MT:MLT:EUR:356 MU:MUS:MUR:230 MV:MDV:MVR:960 MW:MWI:MWK:265 MX:MEX:MXN:52 MY:MYS:MYR:60 MZ:MOZ:MZN:258
NA:NAM:NAD:264 NC:NCL:XPF:687 NE:NER:XOF:227 NF:NFK:AUD:672 NG:NGA:NGN:234 NI:NIC:NIO:505 NL:NLD:EUR:31 NO:NOR:NOK:47
NP:NPL:NPR:977 NR:NRU:AUD:674 NU:NIU:NZD:683 NZ:NZL:NZD:64 OM:OMN:OMR:968 PA:PAN:PAB:507 PE:PER:PEN:51 PF:PYF:XPF:689
PG:PNG:PGK:675 PH:PHL:PHP:63 PK:PAK:PKR:92 PL:POL:PLN:48 PM:SPM:EUR:508 PN:PCN:NZD:64 PR:PRI:USD:1787 PS:PSE:ILS:970
PT:PRT:EUR:351 PW:PLW:USD:680 PY:PRY:PYG:595 QA:QAT:QAR:974 RE:REU:EUR:262 RO:ROU:RON:40 RS:SRB:RSD:381 RU:RUS:RUB:7
RW:RWA:RWF:250 SA:SAU:SAR:966 SB:SLB:SBD:677 SC:SYC:SCR:248 SD:SDN:SDG:249 SE:SWE:SEK:46 SG:SGP:SGD:65 SH:SHN:SHP:290
SI:SVN:EUR:386 SJ:SJM:NOK:47 SK:SVK:EUR:421 SL:SLE:SLE:232 SM:SMR:EUR:378 SN:SEN:XOF:221 SO:SOM:SOS:252 SR:SUR:SRD:597
SS:SSD:SSP:211 ST:STP:STN:239 SV:SLV:USD:503 SX:SXM:ANG:1721 SY:SYR:SYP:963 SZ:SWZ:SZL:268 TC:TCA:USD:1649 TD:TCD:XAF:235
TF:ATF:EUR:262 TG:TGO:XOF:228 TH:THA:THB:66 TJ:TJK:TJS:992 TK:TKL:NZD:690 TL:TLS:USD:670 TM:TKM:TMT:993 TN:TUN:TND:216
TO:TON:TOP:676 TR:TUR:TRY:90 TT:TTO:TTD:1868 TV:TUV:AUD:688 TW:TWN:TWD:886 TZ:TZA:TZS:255 UA:UKR:UAH:380 UG:UGA:UGX:256
UM:UMI:USD:1 US:USA:USD:1 UY:URY:UYU:598 UZ:UZB:UZS:998 VA:VAT:EUR:379 VC:VCT:XCD:1784 VE:VEN:VES:58 VG:VGB:USD:1284
VI:VIR:USD:1340 VN:VNM:VND:84 VU:VUT:VUV:678 WF:WLF:XPF:681 WS:WSM:WST:685 YE:YEM:YER:967 YT:MYT:EUR:262 ZA:ZAF:ZAR:27
ZM:ZMB:ZMW:260 ZW:ZWE:ZWL:263`.split(/\s+/).map(row => {
  const [code, a3, currency, dial] = row.split(':');
  return { code, a3, currency, dial };
});
const COUNTRY_CODES = COUNTRY_DATA.map(c => c.code);
const POPULAR_COUNTRIES = ['US', 'GB', 'JP', 'KR', 'CN', 'HK', 'TW', 'SG', 'DE', 'FR', 'CA', 'AU', 'RU', 'IN', 'BR', 'VN', 'TH', 'ID', 'PH', 'MY'];
// 常見別名（小寫）
const COUNTRY_ALIASES = { uk: 'GB', england: 'GB', britain: 'GB', usa: 'US', america: 'US', 美國: 'US', 美国: 'US', 英國: 'GB', 英国: 'GB',
  韓國: 'KR', 韩国: 'KR', 南韓: 'KR', 港: 'HK', 台: 'TW', 臺灣: 'TW', 台湾: 'TW' };

const NAME_LOCALES = ['en', 'zh-Hant', 'zh-Hans', 'ja'];
const _displayNames = {};
function countryName(code, lang) {
  if (!code) return '';
  lang = lang || (typeof ui !== 'undefined' ? ui.lang : 'en');
  try {
    _displayNames[lang] ||= new Intl.DisplayNames([lang], { type: 'region' });
    return _displayNames[lang].of(code) || code;
  } catch { return code; }
}
function flag(code) {
  if (!/^[A-Z]{2}$/.test(code || '')) return '';
  return String.fromCodePoint(...[...code].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

// 搜索索引：四種語言的名稱 + 各種代碼，只建一次
let _countryIndex = null;
function countryIndex() {
  if (_countryIndex) return _countryIndex;
  _countryIndex = COUNTRY_DATA.map(c => ({
    ...c,
    lc: { code: c.code.toLowerCase(), a3: c.a3.toLowerCase(), currency: c.currency.toLowerCase() },
    names: NAME_LOCALES.map(l => countryName(c.code, l).toLowerCase()),
  }));
  return _countryIndex;
}

function isSubsequence(q, s) {
  let i = 0;
  for (const ch of s) if (ch === q[i]) i++;
  return i === q.length;
}

/* 給一個關鍵詞打分，越高越匹配，0 = 不匹配。
   支持：二位/三位代碼、貨幣（usd、jpy）、電話區號（+81 / 81）、四種語言的名稱、別名，
   以及打錯或多打的代碼（jpr → JP，usd → US）。 */
function countryScore(c, q) {
  if (!q) return 0;
  const { code, a3, currency } = c.lc;
  if (q === code) return 100;
  if (COUNTRY_ALIASES[q] === c.code) return 96;
  if (q === a3) return 95;
  if (q === currency) return currency.startsWith(code) ? 92 : 75;  // 本國貨幣優先（USD → 美國）
  const digits = q.replace(/^\+/, '');
  if (/^\d+$/.test(digits)) return digits === c.dial ? 90 : (c.dial.startsWith(digits) ? 30 : 0);
  let best = 0;
  for (const n of c.names) {
    if (n === q) return 98;
    if (n.startsWith(q)) best = Math.max(best, 70);
    else if (n.includes(q)) best = Math.max(best, 50);
  }
  if (q.length >= 3 && /^[a-z]+$/.test(q) && q.startsWith(code)) best = Math.max(best, 60);
  if (q.length === 2 && a3.startsWith(q)) best = Math.max(best, 45);
  if (q.length >= 2 && /^[a-z]+$/.test(q) && (isSubsequence(q, a3) || isSubsequence(q, c.names[0]))) best = Math.max(best, 20);
  return best;
}

// 按匹配度排序的國家列表；q 為空時常用國家在前
function searchCountries(q, lang) {
  q = (q || '').trim().toLowerCase();
  const idx = countryIndex();
  if (!q) {
    const rest = idx.filter(c => !POPULAR_COUNTRIES.includes(c.code))
      .sort((a, b) => countryName(a.code, lang).localeCompare(countryName(b.code, lang), lang));
    return [...POPULAR_COUNTRIES.map(code => idx.find(c => c.code === code)), ...rest];
  }
  return idx.map(c => ({ c, s: countryScore(c, q) })).filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || (POPULAR_COUNTRIES.includes(b.c.code) - POPULAR_COUNTRIES.includes(a.c.code)))
    .map(x => x.c);
}

/* 篩選欄用：一個輸入框可以寫多個國家，用 / , 空格分隔，例如 "usd/jp/韓國"。
   每個關鍵詞取最高分的那些國家（"korea" 會同時匹配南北韓）。 */
function resolveCountries(input) {
  const tokens = (input || '').toLowerCase().split(/[\/,，、;；|\s]+/).filter(Boolean);
  const idx = countryIndex();
  const result = [];
  for (const tk of tokens) {
    let top = 0, hits = [];
    for (const c of idx) {
      const s = countryScore(c, tk);
      if (s > top) { top = s; hits = [c.code]; } else if (s && s === top) hits.push(c.code);
    }
    // 代碼 / 貨幣 / 區號精確命中時全收（eur → 所有歐元區），模糊命中最多取 8 個
    if (top >= 20) for (const h of top >= 75 ? hits : hits.slice(0, 8)) if (!result.includes(h)) result.push(h);
  }
  return result;
}
