import type { TabMeta, TaskState } from './types';

/**
 * Per-browser-session state in chrome.storage.session. It survives service worker restarts but
 * not a browser restart, which matches tab and group ids: those are only valid for one session.
 */
interface SessionShape {
  tabMeta: Record<number, TabMeta>;
  lockedTabIds: number[];
  /** Chrome group id → our project id. */
  groupLinks: Record<number, string>;
  /** Last known group of each tab, to tell where a moved tab came from. */
  tabGroups: Record<number, number>;
  /** Tabs we are about to move ourselves, with an expiry time, so their events are not read as corrections. */
  ownOps: Record<number, number>;
  task: TaskState;
}

const DEFAULTS: SessionShape = {
  tabMeta: {},
  lockedTabIds: [],
  groupLinks: {},
  tabGroups: {},
  ownOps: {},
  task: { status: 'idle' },
};

export async function getSession<K extends keyof SessionShape>(key: K): Promise<SessionShape[K]> {
  const got = await chrome.storage.session.get(key);
  return (got[key] as SessionShape[K] | undefined) ?? structuredClone(DEFAULTS[key]);
}

const locks = new Map<string, Promise<unknown>>();

/** Read-modify-write without losing updates when several events interleave in the worker. */
export function updateSession<K extends keyof SessionShape>(
  key: K,
  fn: (v: SessionShape[K]) => SessionShape[K],
): Promise<SessionShape[K]> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(async () => {
    const v = fn(await getSession(key));
    await chrome.storage.session.set({ [key]: v });
    return v;
  });
  locks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

export function setSession<K extends keyof SessionShape>(key: K, value: SessionShape[K]): Promise<SessionShape[K]> {
  return updateSession(key, () => value);
}
