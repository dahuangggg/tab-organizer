import { NO_GROUP, type GroupColor, type LiveState, type TabInfo } from './types';
import { pageCache } from './db';
import { parseUrl } from './urls';

export function toTabInfo(t: chrome.tabs.Tab): TabInfo | null {
  if (t.id === undefined) return null;
  return {
    id: t.id,
    windowId: t.windowId,
    index: t.index,
    url: t.url ?? t.pendingUrl ?? '',
    title: t.title ?? '',
    groupId: t.groupId ?? NO_GROUP,
    pinned: t.pinned,
    audible: t.audible ?? false,
    active: t.active,
    incognito: t.incognito,
    openerTabId: t.openerTabId,
    lastAccessed: t.lastAccessed,
  };
}

/** Always read fresh before planning and again before applying: the user may change things meanwhile. */
export async function readLiveState(): Promise<LiveState> {
  const [tabs, groups] = await Promise.all([chrome.tabs.query({}), chrome.tabGroups.query({})]);
  return {
    tabs: tabs.map(toTabInfo).filter((t): t is TabInfo => t !== null),
    groups: groups.map((g) => ({ id: g.id, windowId: g.windowId, title: g.title ?? '', color: g.color as GroupColor })),
  };
}

export function hostPattern(url: string): string | null {
  const u = parseUrl(url);
  return u ? `${u.protocol}//${u.hostname}/*` : null;
}

/**
 * Meta description plus the first 500 characters of visible text. Only runs when summaries are on
 * and the user granted access to that site; never throws.
 */
export async function fetchSummary(tab: TabInfo): Promise<string | undefined> {
  const cached = await pageCache.get(tab.url);
  if (cached) return cached.text;
  const pattern = hostPattern(tab.url);
  if (!pattern || !(await chrome.permissions.contains({ origins: [pattern] }))) return undefined;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
        const desc = meta?.getAttribute('content') ?? '';
        const body = (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 500);
        return `${desc} ${body}`.trim().slice(0, 500);
      },
    });
    const text = typeof res?.result === 'string' ? res.result : '';
    if (!text) return undefined;
    await pageCache.put({ url: tab.url, text, fetchedAt: Date.now() });
    return text;
  } catch {
    // Discarded tabs, error pages and the Web Store cannot be scripted.
    return undefined;
  }
}
