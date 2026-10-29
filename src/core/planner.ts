import { NO_GROUP, type Assignment, type LiveState, type TabInfo, type TabMeta, type UrlRule } from './types';
import { hostname, isBlankUrl, isWebUrl, sanitizeUrl, withoutHash } from './urls';

export interface PlanContext {
  rules: UrlRule[];
  lockedTabIds: Set<number>;
  tabMeta: Record<number, TabMeta>;
  isExcluded: (url: string) => boolean;
}

export interface DeterministicPlan {
  assignments: Assignment[];
  /** Tabs left for the model. */
  remaining: TabInfo[];
  /** Eligible tabs we chose not to touch (locked or excluded). */
  skipped: number[];
}

/**
 * Only ungrouped, unpinned, regular web tabs are ever moved. Tabs already in a group are the
 * user's (or a past run's) decision and stay put.
 */
export function isMovable(t: TabInfo): boolean {
  return t.groupId === NO_GROUP && !t.pinned && !t.incognito && isWebUrl(t.url) && !isBlankUrl(t.url);
}

/** Most specific rule wins: exact URL, then the longest path prefix, then domain. */
export function matchRule(url: string, rules: UrlRule[]): UrlRule | null {
  const exact = withoutHash(url);
  const clean = sanitizeUrl(url);
  const host = hostname(url);
  let best: UrlRule | null = null;
  let bestScore = -1;
  for (const r of rules) {
    let score = -1;
    if (r.kind === 'exact' && r.pattern === exact) score = 1_000_000;
    else if (r.kind === 'path' && (clean === r.pattern || clean.startsWith(`${r.pattern}/`))) score = 1000 + r.pattern.length;
    else if (r.kind === 'domain' && (host === r.pattern || host.endsWith(`.${r.pattern}`))) score = r.pattern.length;
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

export function planDeterministic(state: LiveState, ctx: PlanContext): DeterministicPlan {
  const assignments: Assignment[] = [];
  const skipped: number[] = [];
  const pending: TabInfo[] = [];

  for (const t of state.tabs) {
    if (!isMovable(t)) continue;
    if (ctx.lockedTabIds.has(t.id) || ctx.isExcluded(t.url)) {
      skipped.push(t.id);
      continue;
    }
    const rule = matchRule(t.url, ctx.rules);
    if (rule) assignments.push({ tabId: t.id, dest: { kind: 'project', projectId: rule.projectId }, source: 'rule' });
    else pending.push(t);
  }

  // A tab opened from a grouped tab, while that tab was in use, follows it. Repeat so chains resolve.
  const byId = new Map(state.tabs.map((t) => [t.id, t]));
  const assigned = new Map(assignments.map((a) => [a.tabId, a]));
  let remaining = pending;
  for (let changed = true; changed; ) {
    changed = false;
    const next: TabInfo[] = [];
    for (const t of remaining) {
      const meta = ctx.tabMeta[t.id];
      const openerId = t.openerTabId ?? meta?.openerTabId;
      const opener = openerId === undefined ? undefined : byId.get(openerId);
      let a: Assignment | null = null;
      if (meta?.openerRecent && opener) {
        if (opener.groupId !== NO_GROUP) a = { tabId: t.id, dest: { kind: 'group', groupId: opener.groupId }, source: 'opener' };
        else {
          const via = assigned.get(opener.id);
          if (via) a = { tabId: t.id, dest: via.dest, source: 'opener' };
        }
      }
      if (a) {
        assignments.push(a);
        assigned.set(t.id, a);
        changed = true;
      } else next.push(t);
    }
    remaining = next;
  }

  return { assignments, remaining, skipped };
}
