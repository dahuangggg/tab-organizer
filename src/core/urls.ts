const BLANK_URLS = new Set([
  'about:blank',
  'chrome://newtab/',
  'chrome://new-tab-page/',
  'chrome-search://local-ntp/local-ntp.html',
]);

export function isBlankUrl(url: string): boolean {
  return url === '' || BLANK_URLS.has(url);
}

export function isWebUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

export function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function hostname(url: string): string {
  return parseUrl(url)?.hostname.replace(/^www\./, '') ?? '';
}

/** What is sent to a model: no query, no hash. */
export function sanitizeUrl(url: string, domainOnly = false): string {
  const u = parseUrl(url);
  if (!u) return '';
  if (domainOnly) return u.hostname;
  return `${u.origin}${u.pathname}`;
}

/** URL without hash. Used for exact-URL rules, which should survive in-page anchors. */
export function withoutHash(url: string): string {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

/**
 * The key two corrections must share before we suggest a path rule:
 * origin + the first two path segments (e.g. github.com/acme/tab-tool).
 */
export function pathKey(url: string): string | null {
  const u = parseUrl(url);
  if (!u || !isWebUrl(url)) return null;
  const segs = u.pathname.split('/').filter(Boolean).slice(0, 2);
  if (segs.length === 0) return null;
  return `${u.origin}/${segs.join('/')}`;
}

/**
 * A rough registrable domain for "organize the rest by domain": the last two labels,
 * or three when the second-to-last label is a common second-level suffix (co.uk, com.cn).
 */
export function siteOf(url: string): string {
  const host = hostname(url);
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const sld = parts[parts.length - 2];
  const take = ['co', 'com', 'net', 'org', 'gov', 'edu', 'ac'].includes(sld) ? 3 : 2;
  return parts.slice(-take).join('.');
}

const DEFAULT_SENSITIVE = [
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
  'mail.qq.com',
  'mail.163.com',
  'mail.126.com',
  'mail.yahoo.com',
  'paypal.com',
  'alipay.com',
  'pay.weixin.qq.com',
  'chase.com',
  'bankofamerica.com',
  'wellsfargo.com',
  'icbc.com.cn',
  'ccb.com',
  'cmbchina.com',
  'boc.cn',
  'abchina.com',
  'mychart.org',
];

const SENSITIVE_HOST_PATTERNS = [/(^|\.)bank\./, /bank(ing)?\b/, /(^|\.)health\./, /(^|\.)hospital/, /(^|\.)clinic/];

/** Matches a hostname against `example.com` style entries, subdomains included. */
function hostMatches(host: string, entry: string): boolean {
  const e = entry.trim().toLowerCase().replace(/^\*\./, '').replace(/^www\./, '');
  return e !== '' && (host === e || host.endsWith(`.${e}`));
}

/** True when a tab must never be read, summarized or sent anywhere. Checked before any data is collected. */
export function isExcluded(url: string, userExcluded: string[], useDefaults: boolean): boolean {
  const host = hostname(url).toLowerCase();
  if (!host) return false;
  if (userExcluded.some((e) => hostMatches(host, e))) return true;
  if (!useDefaults) return false;
  return DEFAULT_SENSITIVE.some((e) => hostMatches(host, e)) || SENSITIVE_HOST_PATTERNS.some((p) => p.test(host));
}

const LOW_INFO_TITLES =
  /^(untitled|dashboard|home|homepage|loading|new tab|inbox|overview|welcome|无标题|未命名|新标签页|首页|主页|加载中|控制台|工作台)\b/i;
const APP_DEFAULT_TITLES = /^(google (docs|sheets|slides|drive)|notion|figma|飞书云文档|飞书|lark|腾讯文档|语雀|jira|confluence)$/i;

/** Titles that tell the model almost nothing; only these tabs get a page summary when summaries are on. */
export function isLowInfoTitle(title: string, url: string): boolean {
  const t = title.trim();
  if (t.length <= 3) return true;
  if (t === url || t === hostname(url) || t === sanitizeUrl(url)) return true;
  return LOW_INFO_TITLES.test(t) || APP_DEFAULT_TITLES.test(t);
}
