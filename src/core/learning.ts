import { corrections, newId, projects, urlRules } from './db';
import { matchRule } from './planner';
import type { CorrectionExample } from './prompt';
import { getSession, updateSession } from './session';
import { getSettings } from './settings';
import { NO_GROUP, type Correction, type LiveState, type Project, type RuleSuggestion, type TabInfo, type Trust } from './types';
import { hostname, isExcluded, isWebUrl, pathKey } from './urls';

/** Chrome restores tabs and groups at startup; those events are not the user's choices. */
const STARTUP_GRACE = 15_000;
/** Many group changes in one second look like a bulk action (another extension, a restore), not a drag. */
const BURST_WINDOW = 1000;
const BURST_LIMIT = 5;

const recentChanges: number[] = [];

async function groupTitle(groupId: number): Promise<string | null> {
  if (groupId === NO_GROUP) return null;
  try {
    return (await chrome.tabGroups.get(groupId)).title ?? '';
  } catch {
    return null;
  }
}

/**
 * Called on every tabs.onUpdated with a groupId change. Our own moves are filtered through the
 * persisted ownOps list. Everything else is recorded as a possible preference; only high-trust
 * events are used later, and moving a tab out of a group locks it for this browser session.
 */
export async function onTabGroupChanged(tab: chrome.tabs.Tab, newGroupId: number): Promise<void> {
  if (tab.id === undefined) return;
  const tabId = tab.id;
  let fromGroupId = NO_GROUP;
  await updateSession('tabGroups', (tg) => {
    fromGroupId = tg[tabId] ?? NO_GROUP;
    return { ...tg, [tabId]: newGroupId };
  });
  if (fromGroupId === newGroupId) return;

  let own = false;
  await updateSession('ownOps', (ops) => {
    own = (ops[tabId] ?? 0) > Date.now();
    const { [tabId]: _, ...rest } = ops;
    return rest;
  });
  if (own) return;

  const { bootAt } = (await chrome.storage.session.get('bootAt')) as { bootAt?: number };
  if (bootAt && Date.now() - bootAt < STARTUP_GRACE) return;

  const now = Date.now();
  recentChanges.push(now);
  while (recentChanges.length && now - recentChanges[0] > BURST_WINDOW) recentChanges.shift();
  const trust: Trust = recentChanges.length > BURST_LIMIT ? 'low' : 'high';

  const url = tab.url ?? '';
  const settings = await getSettings();
  if (!isWebUrl(url) || tab.incognito || isExcluded(url, settings.excludedDomains, settings.useDefaultExclusions)) return;

  const links = await getSession('groupLinks');
  const c: Correction = {
    at: now,
    url,
    title: tab.title ?? '',
    fromGroupTitle: await groupTitle(fromGroupId),
    toGroupTitle: await groupTitle(newGroupId),
    toProjectId: newGroupId === NO_GROUP ? null : (links[newGroupId] ?? null),
    kind: newGroupId === NO_GROUP ? 'ungroup' : 'move',
    trust,
  };
  await corrections.add(c);

  if (trust === 'high' && fromGroupId !== NO_GROUP) {
    await updateSession('lockedTabIds', (ids) => (ids.includes(tabId) ? ids : [...ids, tabId]));
  }
}

/** Fills in the group cache for tabs it does not know yet, e.g. right after install. */
export async function seedTabGroups(tabs: TabInfo[]): Promise<void> {
  await updateSession('tabGroups', (tg) => {
    const next = { ...tg };
    for (const t of tabs) if (!(t.id in next)) next[t.id] = t.groupId;
    return next;
  });
}

/** Up to 10 high-trust corrections, same-site ones first, as few-shot examples. */
export async function correctionExamples(tabs: TabInfo[], projectNames: Map<string, string>): Promise<CorrectionExample[]> {
  const domains = new Set(tabs.map((t) => hostname(t.url)));
  const usable = (await corrections.recent())
    .filter((c) => c.trust === 'high' && c.kind === 'move' && c.toGroupTitle)
    .map((c) => ({ c, same: domains.has(hostname(c.url)) }));
  usable.sort((a, b) => Number(b.same) - Number(a.same));
  return usable.slice(0, 10).map(({ c }) => ({
    domain: hostname(c.url),
    title: c.title,
    toName: (c.toProjectId && projectNames.get(c.toProjectId)) || c.toGroupTitle || '',
  }));
}

/**
 * When the same path was moved into the same project at least twice, ask once whether to make it a
 * rule. Nothing becomes a rule without the user's yes.
 */
export async function ruleSuggestions(): Promise<RuleSuggestion[]> {
  const [all, rules, list] = await Promise.all([corrections.recent(), urlRules.all(), projects.active()]);
  const { dismissedRules = [] } = (await chrome.storage.local.get('dismissedRules')) as { dismissedRules?: string[] };
  const names = new Map(list.map((p) => [p.id, p.name]));
  const counts = new Map<string, { pattern: string; projectId: string; n: number }>();
  for (const c of all) {
    if (c.trust !== 'high' || !c.toProjectId || !names.has(c.toProjectId)) continue;
    const key = pathKey(c.url);
    if (!key) continue;
    const id = `${key}→${c.toProjectId}`;
    const e = counts.get(id) ?? { pattern: key, projectId: c.toProjectId, n: 0 };
    e.n++;
    counts.set(id, e);
  }
  const out: RuleSuggestion[] = [];
  for (const [id, e] of counts) {
    if (e.n < 2 || dismissedRules.includes(id)) continue;
    if (matchRule(e.pattern, rules)?.projectId === e.projectId) continue;
    out.push({ pattern: e.pattern, projectId: e.projectId, projectName: names.get(e.projectId)! });
  }
  return out.slice(0, 3);
}

export async function acceptRule(pattern: string, projectId: string): Promise<void> {
  await urlRules.put({ id: newId('r'), kind: 'path', pattern, projectId, createdAt: Date.now() });
}

export async function dismissRule(pattern: string, projectId: string): Promise<void> {
  const { dismissedRules = [] } = (await chrome.storage.local.get('dismissedRules')) as { dismissedRules?: string[] };
  await chrome.storage.local.set({ dismissedRules: [...dismissedRules, `${pattern}→${projectId}`] });
}

/**
 * After a browser restart Chrome brings groups back with new ids. Relink a group only when its
 * title and colour both match exactly one project — a name alone is not enough.
 */
export async function relinkGroups(state: LiveState, list: Project[]): Promise<Record<number, string>> {
  return updateSession('groupLinks', (links) => {
    const next: Record<number, string> = {};
    const live = new Set(state.groups.map((g) => g.id));
    for (const [gid, pid] of Object.entries(links)) if (live.has(Number(gid))) next[Number(gid)] = pid;
    for (const g of state.groups) {
      if (next[g.id]) continue;
      const matches = list.filter((p) => p.name === g.title && p.color === g.color);
      if (matches.length === 1) next[g.id] = matches[0].id;
    }
    return next;
  });
}

/** A user renaming a group we linked renames the project too. */
export async function onGroupRenamed(group: chrome.tabGroups.TabGroup): Promise<void> {
  const links = await getSession('groupLinks');
  const pid = links[group.id];
  if (!pid || !group.title) return;
  const p = await projects.get(pid);
  if (p && (p.name !== group.title || p.color !== group.color)) {
    await projects.put({ ...p, name: group.title, color: group.color as Project['color'] });
  }
}
