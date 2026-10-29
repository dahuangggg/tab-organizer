import { NO_GROUP, type TabInfo } from '../src/core/types';

let nextId = 1;

export function tab(p: Partial<TabInfo> & { url: string }): TabInfo {
  const id = p.id ?? nextId++;
  return {
    id,
    windowId: 1,
    index: id,
    title: `Tab ${id}`,
    groupId: NO_GROUP,
    pinned: false,
    audible: false,
    active: false,
    incognito: false,
    ...p,
  };
}
