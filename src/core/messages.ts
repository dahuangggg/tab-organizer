import type { UndoReport } from './types';

export type Request =
  | { type: 'organize' }
  | { type: 'organizeByDomain'; tabIds: number[] }
  | { type: 'closeTabs'; tabIds: number[] }
  | { type: 'undo' }
  | { type: 'acceptRule'; pattern: string; projectId: string }
  | { type: 'dismissRule'; pattern: string; projectId: string }
  | { type: 'unlockAll' };

export type Response =
  | { ok: true; undo?: UndoReport | null; closed?: number; added?: number }
  | { ok: false; error: string };

export function send(req: Request): Promise<Response> {
  return chrome.runtime.sendMessage(req);
}
