import type { ModelClient } from './models';
import {
  buildPrompt,
  ModelOutputError,
  OUTPUT_SCHEMA,
  parseModelOutput,
  type Candidate,
  type CorrectionExample,
  type PromptTab,
} from './prompt';
import type { NewProjectProposal } from './types';

export interface ClassifyOptions {
  template: string;
  threshold: number;
  candidates: Candidate[];
  examples: CorrectionExample[];
  onBatch?: (batch: number, total: number) => void;
  /** Called with each prompt before it is sent, e.g. to keep "上次发送内容". */
  onPrompt?: (prompt: { system: string; user: string }) => Promise<void> | void;
}

export interface Classified {
  tabIndex: number;
  /** A candidate id, or a proposal tempId (unique across batches). */
  target: string;
  confidence: number;
  reason?: string;
}

export interface ClassifyResult {
  assignments: Classified[];
  proposals: NewProjectProposal[];
  batches: number;
  /** Answers that were not valid JSON or broke the contract, retries included. */
  formatErrors: number;
  /** Set when a batch failed for another reason (network, HTTP); earlier batches still count. */
  error?: unknown;
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Sends tabs to the model in batches and validates every answer. Shared by "一键整理" and the M0
 * evaluation so both measure the same thing. `openerIndex` on input tabs is a global index; it is
 * kept only when the opener lands in the same batch.
 */
export async function classify(client: ModelClient, tabs: PromptTab[], opts: ClassifyOptions): Promise<ClassifyResult> {
  const assignments: Classified[] = [];
  const proposals: NewProjectProposal[] = [];
  const pool = [...opts.candidates];
  const indexes = chunk(
    tabs.map((_, i) => i),
    client.maxBatch,
  );
  let formatErrors = 0;

  /** One model call over some tabs (global indexes). Returns the indexes it did not answer for. */
  async function ask(batch: number[], tag: string): Promise<{ omitted: number[] } | { error: unknown }> {
    const local = new Map(batch.map((g, i) => [g, i]));
    const promptTabs = batch.map((g) => {
      const t = tabs[g];
      return { ...t, openerIndex: t.openerIndex === undefined ? undefined : local.get(t.openerIndex) };
    });
    const prompt = buildPrompt({ template: opts.template, candidates: pool, corrections: opts.examples, tabs: promptTabs });
    await opts.onPrompt?.(prompt);

    const candidateIds = new Set(pool.map((c) => c.id));
    let parsed: ReturnType<typeof parseModelOutput> | null = null;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      try {
        const raw = await client.complete(prompt.system, prompt.user, OUTPUT_SCHEMA);
        parsed = parseModelOutput(raw, { tabCount: batch.length, candidateIds, threshold: opts.threshold });
      } catch (e) {
        if (e instanceof ModelOutputError) formatErrors++;
        lastError = e;
      }
    }
    if (!parsed) {
      if (lastError instanceof ModelOutputError) return { omitted: [] }; // this batch stays undecided
      return { error: lastError };
    }

    // Keep tempIds unique across calls and let later calls reuse earlier proposals. A proposal named
    // like a project we already have is that project, not a second one.
    const norm = (n: string) => n.trim().toLowerCase();
    const rename = new Map<string, string>();
    for (const p of parsed.proposed) {
      const same = pool.find((c) => norm(c.name) === norm(p.name));
      if (same) {
        rename.set(p.tempId, same.id);
        continue;
      }
      const id = `new_${tag}_${p.tempId}`;
      rename.set(p.tempId, id);
      proposals.push({ ...p, tempId: id });
      pool.push({ id, name: p.name, keywords: [], sampleUrls: [] });
    }
    for (const a of parsed.assignments) {
      assignments.push({
        tabIndex: batch[a.tabIndex],
        target: rename.get(a.target) ?? a.target,
        confidence: a.confidence,
        reason: a.reason,
      });
    }
    return { omitted: parsed.omitted.map((i) => batch[i]) };
  }

  for (const [b, batch] of indexes.entries()) {
    opts.onBatch?.(b, indexes.length);
    const first = await ask(batch, String(b));
    if ('error' in first) return { assignments, proposals, batches: indexes.length, formatErrors, error: first.error };
    // Models sometimes stop listing tabs partway. Ask once more about the ones they skipped, with
    // the projects they just proposed as candidates. Tabs they answered null for stay ungrouped.
    if (first.omitted.length) {
      const again = await ask(first.omitted, `${b}r`);
      if ('error' in again) return { assignments, proposals, batches: indexes.length, formatErrors, error: again.error };
    }
  }
  return { assignments, proposals, batches: indexes.length, formatErrors };
}
