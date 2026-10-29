import { readLiveState } from './chrome-state';
import { newId, opLog, projects, urlRules } from './db';
import { isMovable } from './planner';
import { getSession, updateSession } from './session';
import {
  NO_GROUP,
  type Assignment,
  type ClosedTab,
  type GroupColor,
  type GroupSummary,
  type LiveState,
  type NewProjectProposal,
  type OpLogEntry,
  type Project,
  type TabMove,
  type UndoReport,
} from './types';
import { planUndo } from './undo';

/** Fallback expiry for a mark whose event never arrives (e.g. a move that did not change the group). */
const OWN_OP_TTL = 5_000;

/**
 * Mark tabs we are about to move so the correction listener ignores the event this causes. Each mark
 * covers one group change and is consumed by it, so a user drag right after organizing still counts.
 */
export async function markOwn(tabIds: number[]): Promise<void> {
  const until = Date.now() + OWN_OP_TTL;
  await updateSession('ownOps', (ops) => {
    const now = Date.now();
    const next: Record<number, number> = {};
    for (const [id, exp] of Object.entries(ops)) if (exp > now) next[Number(id)] = exp;
    for (const id of tabIds) next[id] = until;
    return next;
  });
}

interface Bucket {
  windowId: number;
  existingGroupId?: number;
  title: string;
  color: GroupColor;
  projectId?: string;
  tabIds: number[];
}

export interface ApplyResult {
  opLogId: string | null;
  groups: GroupSummary[];
  skippedChanged: number;
}

/**
 * Executes assignments against a fresh read of the browser. Tabs the user touched since planning
 * (moved window, grouped, closed, locked) are skipped. `persistNew` creates a project for each new
 * group; domain grouping passes false so it does not fill memory with site names.
 */
export async function applyAssignments(
  assignments: Assignment[],
  proposals: NewProjectProposal[],
  planned: LiveState,
  kind: OpLogEntry['kind'],
  persistNew = true,
): Promise<ApplyResult> {
  const fresh = await readLiveState();
  const freshTabs = new Map(fresh.tabs.map((t) => [t.id, t]));
  const plannedTabs = new Map(planned.tabs.map((t) => [t.id, t]));
  const groups = new Map(fresh.groups.map((g) => [g.id, g]));
  const locked = new Set(await getSession('lockedTabIds'));
  const links = await getSession('groupLinks');
  const proposalById = new Map(proposals.map((p) => [p.tempId, p]));
  const createdProjects = new Map<string, Project>();
  const projectCache = new Map<string, Project | undefined>();
  // A proposal named like an existing project is that project, not a second one.
  const byName = new Map((await projects.active()).map((p) => [p.name.trim().toLowerCase(), p]));
  let skippedChanged = 0;

  const getProject = async (id: string) => {
    if (!projectCache.has(id)) projectCache.set(id, await projects.get(id));
    return projectCache.get(id);
  };

  const buckets = new Map<string, Bucket>();
  const addTo = (b: Omit<Bucket, 'tabIds'>, key: string, tabId: number) => {
    const existing = buckets.get(key);
    if (existing) existing.tabIds.push(tabId);
    else buckets.set(key, { ...b, tabIds: [tabId] });
  };
  const groupForProject = (projectId: string, windowId: number) =>
    fresh.groups.find((g) => g.windowId === windowId && links[g.id] === projectId);

  for (const a of assignments) {
    const tab = freshTabs.get(a.tabId);
    const was = plannedTabs.get(a.tabId);
    if (!tab || !was || tab.windowId !== was.windowId || !isMovable(tab) || locked.has(tab.id)) {
      skippedChanged++;
      continue;
    }

    let project: Project | undefined;
    if (a.dest.kind === 'group') {
      const g = groups.get(a.dest.groupId);
      if (!g) {
        skippedChanged++;
        continue;
      }
      if (g.windowId === tab.windowId) {
        addTo({ windowId: tab.windowId, existingGroupId: g.id, title: g.title, color: g.color }, `${tab.windowId}|g${g.id}`, tab.id);
        continue;
      }
      // Same project in another window: a new group with the same name, never by moving windows.
      const linked = links[g.id] ? await getProject(links[g.id]) : undefined;
      if (linked) project = linked;
      else {
        addTo({ windowId: tab.windowId, title: g.title, color: g.color }, `${tab.windowId}|t${g.title}`, tab.id);
        continue;
      }
    } else if (a.dest.kind === 'project') {
      project = await getProject(a.dest.projectId);
    } else {
      const p = proposalById.get(a.dest.tempId);
      if (!p) {
        skippedChanged++;
        continue;
      }
      if (!persistNew) {
        addTo({ windowId: tab.windowId, title: p.name, color: p.color }, `${tab.windowId}|t${p.name}`, tab.id);
        continue;
      }
      project = createdProjects.get(p.tempId) ?? byName.get(p.name.trim().toLowerCase());
      if (!project) {
        const now = Date.now();
        project = { id: newId('p'), name: p.name, color: p.color, keywords: [], createdAt: now, lastActiveAt: now };
        createdProjects.set(p.tempId, project);
        byName.set(p.name.trim().toLowerCase(), project);
      }
    }

    if (!project) {
      skippedChanged++;
      continue;
    }
    const g = groupForProject(project.id, tab.windowId);
    if (g) addTo({ windowId: tab.windowId, existingGroupId: g.id, title: g.title, color: g.color, projectId: project.id }, `${tab.windowId}|g${g.id}`, tab.id);
    else addTo({ windowId: tab.windowId, title: project.name, color: project.color, projectId: project.id }, `${tab.windowId}|p${project.id}`, tab.id);
  }

  const allTabIds = [...buckets.values()].flatMap((b) => b.tabIds);
  if (allTabIds.length === 0) return { opLogId: null, groups: [], skippedChanged };
  await markOwn(allTabIds);

  for (const p of createdProjects.values()) await projects.put(p);

  const moves: TabMove[] = [];
  const summaries = new Map<string, GroupSummary>();
  const newLinks: Record<number, string> = {};
  const touchedProjects = new Set<string>();

  for (const b of buckets.values()) {
    try {
      const before = b.tabIds.map((id) => freshTabs.get(id)!);
      const tabIds = b.tabIds as [number, ...number[]];
      const groupId: number =
        b.existingGroupId !== undefined
          ? await chrome.tabs.group({ tabIds, groupId: b.existingGroupId })
          : await chrome.tabs.group({ tabIds, createProperties: { windowId: b.windowId } });
      if (b.existingGroupId === undefined) await chrome.tabGroups.update(groupId, { title: b.title, color: b.color });
      if (b.projectId) {
        newLinks[groupId] = b.projectId;
        touchedProjects.add(b.projectId);
      }
      for (const t of before) {
        moves.push({ tabId: t.id, windowId: t.windowId, beforeGroupId: t.groupId, beforeIndex: t.index, afterGroupId: groupId });
      }
      const key = `${b.title}|${b.existingGroupId === undefined ? 'new' : 'old'}`;
      const s = summaries.get(key) ?? { title: b.title, color: b.color, added: 0, isNew: b.existingGroupId === undefined };
      s.added += b.tabIds.length;
      summaries.set(key, s);
    } catch {
      skippedChanged += b.tabIds.length;
    }
  }

  await updateSession('groupLinks', (l) => ({ ...l, ...newLinks }));
  await updateSession('tabGroups', (tg) => {
    const next = { ...tg };
    for (const m of moves) next[m.tabId] = m.afterGroupId;
    return next;
  });
  const now = Date.now();
  for (const id of touchedProjects) {
    const p = createdProjects.get(id) ?? (await getProject(id));
    if (p) await projects.put({ ...p, lastActiveAt: now });
  }

  let opLogId: string | null = null;
  if (moves.length) {
    opLogId = newId('op');
    await opLog.add({ id: opLogId, at: now, kind, moves, closed: [], createdProjectIds: [...createdProjects.values()].map((p) => p.id) });
  }
  return { opLogId, groups: [...summaries.values()], skippedChanged };
}

/** Closes tabs the user ticked in the cleanup list. Active, pinned and audible tabs are never closed. */
export async function closeTabs(tabIds: number[]): Promise<{ closed: number; opLogId: string | null }> {
  const fresh = await readLiveState();
  const byId = new Map(fresh.tabs.map((t) => [t.id, t]));
  const closed: ClosedTab[] = [];
  for (const id of tabIds) {
    const t = byId.get(id);
    if (!t || t.active || t.pinned || t.audible) continue;
    closed.push({ tabId: t.id, url: t.url, title: t.title, windowId: t.windowId, index: t.index, groupId: t.groupId });
  }
  if (!closed.length) return { closed: 0, opLogId: null };
  await markOwn(closed.map((c) => c.tabId));
  await chrome.tabs.remove(closed.map((c) => c.tabId));
  const id = newId('op');
  await opLog.add({ id, at: Date.now(), kind: 'cleanup', moves: [], closed });
  return { closed: closed.length, opLogId: id };
}

async function reopen(c: ClosedTab, windowIds: Set<number>): Promise<boolean> {
  try {
    const recent = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
    const hit = recent.find((s) => s.tab?.url === c.url && s.tab.sessionId);
    if (hit?.tab?.sessionId) {
      await chrome.sessions.restore(hit.tab.sessionId);
      return true;
    }
    await chrome.tabs.create({ url: c.url, active: false, ...(windowIds.has(c.windowId) ? { windowId: c.windowId, index: c.index } : {}) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reverts the latest run that is not yet undone. Best effort: tabs the user changed afterwards
 * are left alone, closed pages come back by URL without their unsaved state.
 */
export async function undoLast(): Promise<UndoReport | null> {
  const entry = await opLog.lastUndoable();
  if (!entry) return null;
  const state = await readLiveState();
  const plan = planUndo(entry, state);

  let restored = 0;
  for (const a of plan.actions) {
    try {
      await markOwn([a.tabId]);
      if (a.toGroupId === NO_GROUP) await chrome.tabs.ungroup(a.tabId);
      else await chrome.tabs.group({ tabIds: [a.tabId], groupId: a.toGroupId });
      await markOwn([a.tabId]);
      const moved = await chrome.tabs.move(a.tabId, { index: a.index });
      // Dropping a tab between grouped tabs makes it join that group; take it out again.
      if (a.toGroupId === NO_GROUP && !Array.isArray(moved) && moved.groupId !== NO_GROUP) {
        await markOwn([a.tabId]);
        await chrome.tabs.ungroup(a.tabId);
      }
      restored++;
    } catch {
      // The tab or window went away between reading and acting.
    }
  }

  const windowIds = new Set(state.tabs.map((t) => t.windowId));
  let reopened = 0;
  for (const c of plan.reopen) if (await reopen(c, windowIds)) reopened++;

  await opLog.put({ ...entry, undone: true });
  const fresh = await readLiveState();

  // Projects born in the undone run go too, unless a group still shows them or a rule points at them.
  const links = await getSession('groupLinks');
  const liveLinked = new Set(fresh.groups.map((g) => links[g.id]).filter(Boolean));
  const ruled = new Set((await urlRules.all()).map((r) => r.projectId));
  for (const id of entry.createdProjectIds ?? []) {
    if (!liveLinked.has(id) && !ruled.has(id)) await projects.remove(id);
  }

  await updateSession('tabGroups', (tg) => {
    const next = { ...tg };
    for (const t of fresh.tabs) next[t.id] = t.groupId;
    return next;
  });
  return { restored, skippedModified: plan.skippedModified, missing: plan.missing, reopened };
}
