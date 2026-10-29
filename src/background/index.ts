import { closeTabs, undoLast } from '../core/actions';
import { readLiveState } from '../core/chrome-state';
import { acceptRule, dismissRule, onGroupRenamed, onTabGroupChanged, seedTabGroups } from '../core/learning';
import type { Request, Response } from '../core/messages';
import { organize, organizeByDomain } from '../core/organize';
import { getSession, setSession, updateSession } from '../core/session';
import type { OrganizeResult } from '../core/types';
import { isWebUrl } from '../core/urls';

const OPENER_RECENT = 5 * 60_000;

// A task marked running by a previous worker instance died with it; say so instead of spinning forever.
let runningHere = false;
void getSession('task').then((t) => {
  if (t.status === 'running' && !runningHere) void setSession('task', { status: 'error', message: '上次整理被中断，请重试。' });
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.storage.session.set({ bootAt: Date.now() });
});

chrome.runtime.onInstalled.addListener(async () => {
  await seedTabGroups((await readLiveState()).tabs);
});

// --- recording only: nothing here groups or closes a tab -------------------------------------

chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.id === undefined) return;
  let openerRecent = false;
  // Chrome also sets an opener on blank new tabs (Ctrl+T); whatever the user types there is unrelated.
  const openedToLink = isWebUrl(tab.pendingUrl ?? tab.url ?? '');
  if (tab.openerTabId !== undefined && openedToLink) {
    try {
      const opener = await chrome.tabs.get(tab.openerTabId);
      openerRecent = opener.active || Date.now() - (opener.lastAccessed ?? 0) < OPENER_RECENT;
    } catch {
      // opener already closed
    }
  }
  const id = tab.id;
  await updateSession('tabMeta', (m) => ({ ...m, [id]: { openedAt: Date.now(), openerTabId: tab.openerTabId, openerRecent } }));
  await updateSession('tabGroups', (tg) => ({ ...tg, [id]: tab.groupId ?? -1 }));
});

chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  if (change.groupId !== undefined) void onTabGroupChanged(tab, change.groupId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const drop = <T extends Record<number, unknown>>(m: T): T => {
    const { [tabId]: _, ...rest } = m;
    return rest as T;
  };
  await updateSession('tabMeta', drop);
  await updateSession('tabGroups', drop);
  await updateSession('ownOps', drop);
  await updateSession('lockedTabIds', (ids) => ids.filter((id) => id !== tabId));
});

chrome.tabGroups.onUpdated.addListener((group) => void onGroupRenamed(group));
chrome.tabGroups.onRemoved.addListener(async (group) => {
  await updateSession('groupLinks', (l) => {
    const { [group.id]: _, ...rest } = l;
    return rest;
  });
});

// --- user-triggered actions --------------------------------------------------------------------

async function runOrganize(): Promise<void> {
  const cur = await getSession('task');
  if (cur.status === 'running' && runningHere) return;
  runningHere = true;
  const startedAt = Date.now();
  // Extension API calls keep the worker alive while a slow model answers.
  const keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
  try {
    const result = await organize((step) => void setSession('task', { status: 'running', startedAt, step }));
    await setSession('task', { status: 'done', result });
    await setBadge(result);
  } catch (e) {
    await setSession('task', { status: 'error', message: e instanceof Error ? e.message : String(e) });
  } finally {
    clearInterval(keepAlive);
    runningHere = false;
  }
}

async function setBadge(r: OrganizeResult): Promise<void> {
  const n = r.undecidedTabIds.length + r.cleanup.length;
  await chrome.action.setBadgeText({ text: n ? String(n) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
}

/** Keep the last result in sync after follow-up actions so the popup does not offer stale items. */
async function patchResult(fn: (r: OrganizeResult) => OrganizeResult): Promise<void> {
  const t = await getSession('task');
  if (t.status !== 'done') return;
  const result = fn(t.result);
  await setSession('task', { status: 'done', result });
  await setBadge(result);
}

async function handle(req: Request): Promise<Response> {
  switch (req.type) {
    case 'organize':
      void runOrganize();
      return { ok: true };
    case 'organizeByDomain': {
      const r = await organizeByDomain(req.tabIds);
      const added = r.groups.reduce((n, g) => n + g.added, 0);
      const fresh = await readLiveState();
      const stillLoose = new Set(fresh.tabs.filter((t) => t.groupId === -1).map((t) => t.id));
      await patchResult((res) => ({ ...res, undecidedTabIds: res.undecidedTabIds.filter((id) => stillLoose.has(id)) }));
      return { ok: true, added };
    }
    case 'closeTabs': {
      const r = await closeTabs(req.tabIds);
      const fresh = new Set((await readLiveState()).tabs.map((t) => t.id));
      await patchResult((res) => ({ ...res, cleanup: res.cleanup.filter((c) => fresh.has(c.tabId)) }));
      return { ok: true, closed: r.closed };
    }
    case 'undo': {
      const undo = await undoLast();
      if (undo) {
        await setSession('task', { status: 'idle' });
        await chrome.action.setBadgeText({ text: '' });
      }
      return { ok: true, undo };
    }
    case 'acceptRule':
      await acceptRule(req.pattern, req.projectId);
      await patchResult((res) => ({ ...res, ruleSuggestions: res.ruleSuggestions.filter((s) => s.pattern !== req.pattern) }));
      return { ok: true };
    case 'dismissRule':
      await dismissRule(req.pattern, req.projectId);
      await patchResult((res) => ({ ...res, ruleSuggestions: res.ruleSuggestions.filter((s) => s.pattern !== req.pattern) }));
      return { ok: true };
    case 'unlockAll':
      await setSession('lockedTabIds', []);
      return { ok: true };
  }
}

chrome.runtime.onMessage.addListener((req: Request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  handle(req)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return true;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'organize') void runOrganize();
});
