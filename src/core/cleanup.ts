import { NO_GROUP, type CleanupItem, type TabInfo } from './types';
import { isBlankUrl, isWebUrl } from './urls';

/** Tabs we never suggest closing: the user is looking at it, pinned it, or it is playing sound. */
function protectedTab(t: TabInfo): boolean {
  return t.active || t.pinned || t.audible;
}

/**
 * Suggestions only — nothing here closes a tab. Duplicates must match the full URL, hash included,
 * because hash-routed apps put different pages behind the same path.
 */
export function findCleanup(tabs: TabInfo[]): CleanupItem[] {
  const items: CleanupItem[] = [];

  for (const t of tabs) {
    if (!t.incognito && isBlankUrl(t.url) && !protectedTab(t)) {
      items.push({ tabId: t.id, title: t.title || '空白页', url: t.url, reason: 'blank' });
    }
  }

  const byUrl = new Map<string, TabInfo[]>();
  for (const t of tabs) {
    if (t.incognito || !isWebUrl(t.url)) continue;
    const list = byUrl.get(t.url) ?? [];
    list.push(t);
    byUrl.set(t.url, list);
  }
  for (const list of byUrl.values()) {
    if (list.length < 2) continue;
    const keep = [...list].sort(keepOrder)[0];
    for (const t of list) {
      if (t.id === keep.id || protectedTab(t)) continue;
      items.push({ tabId: t.id, title: t.title, url: t.url, reason: 'duplicate', keepTabId: keep.id });
    }
  }
  return items;
}

/** Prefer keeping the copy that is protected, already grouped, or most recently used. */
function keepOrder(a: TabInfo, b: TabInfo): number {
  const score = (t: TabInfo) => (protectedTab(t) ? 4 : 0) + (t.groupId !== NO_GROUP ? 2 : 0);
  return score(b) - score(a) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0);
}
