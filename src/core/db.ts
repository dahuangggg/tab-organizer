import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Correction, OpLogEntry, PageSummary, Project, UrlRule } from './types';

interface Schema extends DBSchema {
  projects: { key: string; value: Project };
  urlRules: { key: string; value: UrlRule; indexes: { byProject: string } };
  corrections: { key: number; value: Correction; indexes: { byAt: number } };
  pageCache: { key: string; value: PageSummary };
  opLog: { key: string; value: OpLogEntry; indexes: { byAt: number } };
}

const MAX_CORRECTIONS = 500;
const MAX_OPLOG = 10;
const PAGE_TTL = 30 * 24 * 3600_000;

let dbp: Promise<IDBPDatabase<Schema>> | null = null;

function db(): Promise<IDBPDatabase<Schema>> {
  dbp ??= openDB<Schema>('tab-organizer', 1, {
    upgrade(d) {
      d.createObjectStore('projects', { keyPath: 'id' });
      d.createObjectStore('urlRules', { keyPath: 'id' }).createIndex('byProject', 'projectId');
      d.createObjectStore('corrections', { keyPath: 'id', autoIncrement: true }).createIndex('byAt', 'at');
      d.createObjectStore('pageCache', { keyPath: 'url' });
      d.createObjectStore('opLog', { keyPath: 'id' }).createIndex('byAt', 'at');
    },
  });
  return dbp;
}

export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export const projects = {
  async all(): Promise<Project[]> {
    return (await db()).getAll('projects');
  },
  async active(): Promise<Project[]> {
    return (await this.all()).filter((p) => !p.archived);
  },
  async get(id: string): Promise<Project | undefined> {
    return (await db()).get('projects', id);
  },
  async put(p: Project): Promise<void> {
    await (await db()).put('projects', p);
  },
  async remove(id: string): Promise<void> {
    const d = await db();
    const tx = d.transaction(['projects', 'urlRules'], 'readwrite');
    await tx.objectStore('projects').delete(id);
    for (const key of await tx.objectStore('urlRules').index('byProject').getAllKeys(id)) {
      await tx.objectStore('urlRules').delete(key);
    }
    await tx.done;
  },
};

export const urlRules = {
  async all(): Promise<UrlRule[]> {
    return (await db()).getAll('urlRules');
  },
  async put(r: UrlRule): Promise<void> {
    await (await db()).put('urlRules', r);
  },
  async remove(id: string): Promise<void> {
    await (await db()).delete('urlRules', id);
  },
};

export const corrections = {
  async add(c: Correction): Promise<void> {
    const d = await db();
    await d.add('corrections', c);
    const count = await d.count('corrections');
    if (count > MAX_CORRECTIONS) {
      const tx = d.transaction('corrections', 'readwrite');
      let cursor = await tx.store.index('byAt').openCursor();
      for (let extra = count - MAX_CORRECTIONS; cursor && extra > 0; extra--) {
        await cursor.delete();
        cursor = await cursor.continue();
      }
      await tx.done;
    }
  },
  async recent(limit = MAX_CORRECTIONS): Promise<Correction[]> {
    const all = await (await db()).getAllFromIndex('corrections', 'byAt');
    return all.slice(-limit).reverse();
  },
};

export const pageCache = {
  async get(url: string): Promise<PageSummary | undefined> {
    const hit = await (await db()).get('pageCache', url);
    return hit && Date.now() - hit.fetchedAt < PAGE_TTL ? hit : undefined;
  },
  async put(s: PageSummary): Promise<void> {
    await (await db()).put('pageCache', s);
  },
  async clear(): Promise<void> {
    await (await db()).clear('pageCache');
  },
};

export const opLog = {
  async add(e: OpLogEntry): Promise<void> {
    const d = await db();
    await d.put('opLog', e);
    const keys = await d.getAllKeysFromIndex('opLog', 'byAt');
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_OPLOG))) await d.delete('opLog', k);
  },
  async put(e: OpLogEntry): Promise<void> {
    await (await db()).put('opLog', e);
  },
  async lastUndoable(): Promise<OpLogEntry | undefined> {
    const all = await (await db()).getAllFromIndex('opLog', 'byAt');
    return all.reverse().find((e) => !e.undone);
  },
};

/** "清空全部记忆": projects, rules, corrections, page summaries and the operation log. */
export async function clearAll(): Promise<void> {
  const d = await db();
  await Promise.all((['projects', 'urlRules', 'corrections', 'pageCache', 'opLog'] as const).map((s) => d.clear(s)));
}
