import { NO_GROUP, type ClosedTab, type LiveState, type OpLogEntry } from './types';

export interface UndoAction {
  tabId: number;
  windowId: number;
  toGroupId: number;
  index: number;
}

export interface UndoPlan {
  actions: UndoAction[];
  reopen: ClosedTab[];
  skippedModified: number;
  missing: number;
}

/**
 * Undo reverts only what this run did. A tab is restored only if it is still exactly where we
 * put it; anything the user changed afterwards wins and is reported as skipped.
 */
export function planUndo(entry: OpLogEntry, state: LiveState): UndoPlan {
  const tabs = new Map(state.tabs.map((t) => [t.id, t]));
  const groups = new Map(state.groups.map((g) => [g.id, g]));
  const actions: UndoAction[] = [];
  let skippedModified = 0;
  let missing = 0;

  for (const m of entry.moves) {
    const tab = tabs.get(m.tabId);
    if (!tab) {
      missing++;
      continue;
    }
    if (tab.groupId !== m.afterGroupId || tab.windowId !== m.windowId) {
      skippedModified++;
      continue;
    }
    const before = m.beforeGroupId === NO_GROUP ? undefined : groups.get(m.beforeGroupId);
    const toGroupId = before && before.windowId === tab.windowId ? before.id : NO_GROUP;
    actions.push({ tabId: m.tabId, windowId: tab.windowId, toGroupId, index: m.beforeIndex });
  }
  actions.sort((a, b) => a.index - b.index);

  const reopen = entry.closed.filter((c) => !tabs.has(c.tabId));
  return { actions, reopen, skippedModified, missing };
}
