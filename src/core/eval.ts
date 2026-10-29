import { classify } from './classify';
import type { ModelClient } from './models';
import type { PromptTab } from './prompt';
import { hostname, parseUrl, siteOf } from './urls';

/**
 * M0 evaluation: the user exports real tabs, writes the project each one belongs to, and we compare
 * how the domain baseline and each model source would have grouped them.
 *
 * Labels: a project name; "-" when the tab is best left ungrouped; empty when not labeled (ignored).
 */
export const NO_PROJECT = '-';

export interface SampleTab {
  expected: string;
  title: string;
  /** origin + path; query and hash are dropped at export. */
  url: string;
}

const HEADER = ['expected', 'title', 'url'];

function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

/** UTF-8 with BOM so Excel and Numbers open Chinese titles correctly. */
export function toCsv(tabs: SampleTab[]): string {
  const rows = [HEADER, ...tabs.map((t) => [t.expected, t.title, t.url])];
  return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export function parseSample(text: string): SampleTab[] {
  const rows = parseCsv(text);
  const head = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const col = (name: string) => head.indexOf(name);
  const [e, t, u] = [col('expected'), col('title'), col('url')];
  if (e === -1 || t === -1 || u === -1) throw new Error('CSV 需要 expected、title、url 三列');
  return rows.slice(1).map((r) => ({ expected: (r[e] ?? '').trim(), title: r[t] ?? '', url: r[u] ?? '' }));
}

/** One label per tab: a cluster key, or null for "left ungrouped". */
export type Prediction = (string | null)[];

export interface Metrics {
  /** Tabs with any label (project or "-"). */
  labeled: number;
  /** Tabs labeled with a project. */
  projectTabs: number;
  /** Labeled tabs the method put in a group. */
  grouped: number;
  /** Grouped tabs in the wrong group, or grouped though labeled "-". */
  wrong: number;
  /** Project tabs left ungrouped. */
  missed: number;
  /** grouped / labeled */
  coverage: number;
  /** wrong / grouped */
  errorRate: number;
  /** missed / projectTabs */
  missRate: number;
  /** Extra groups a project was split into, summed over projects. */
  fragmentation: number;
}

function clusters(tabs: SampleTab[], pred: Prediction): { members: Map<string, number[]>; majority: Map<string, string | null> } {
  const members = new Map<string, number[]>();
  pred.forEach((c, i) => {
    if (c !== null) members.set(c, [...(members.get(c) ?? []), i]);
  });
  const majority = new Map<string, string | null>();
  for (const [c, idx] of members) {
    const counts = new Map<string, number>();
    for (const i of idx) {
      const l = tabs[i].expected;
      if (l && l !== NO_PROJECT) counts.set(l, (counts.get(l) ?? 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    majority.set(c, best ? best[0] : null);
  }
  return { members, majority };
}

export interface ClusterDetail {
  key: string;
  /** The project this cluster is matched to, or null when none of its tabs has a project label. */
  matches: string | null;
  tabs: { index: number; wrong: boolean }[];
}

/** For the report: each predicted group, which project it stands for, and which of its tabs are wrong. */
export function explain(tabs: SampleTab[], pred: Prediction): { clusters: ClusterDetail[]; missed: number[] } {
  const { members, majority } = clusters(tabs, pred);
  const out: ClusterDetail[] = [];
  for (const [key, idx] of members) {
    const m = majority.get(key) ?? null;
    out.push({
      key,
      matches: m,
      tabs: idx.map((i) => ({ index: i, wrong: !!tabs[i].expected && (tabs[i].expected === NO_PROJECT || tabs[i].expected !== m) })),
    });
  }
  const missed = tabs.flatMap((t, i) => (pred[i] === null && t.expected && t.expected !== NO_PROJECT ? [i] : []));
  return { clusters: out, missed };
}

/**
 * Clusters are matched to labels by majority: a cluster "is" the project most of its labeled tabs
 * belong to, and every other tab in it counts as wrong. Unlabeled tabs are ignored.
 */
export function score(tabs: SampleTab[], pred: Prediction): Metrics {
  const { majority } = clusters(tabs, pred);

  let labeled = 0;
  let projectTabs = 0;
  let grouped = 0;
  let wrong = 0;
  let missed = 0;
  const clustersPerProject = new Map<string, Set<string>>();
  tabs.forEach((t, i) => {
    const l = t.expected;
    if (!l) return;
    labeled++;
    const c = pred[i];
    if (l !== NO_PROJECT) projectTabs++;
    if (c === null) {
      if (l !== NO_PROJECT) missed++;
      return;
    }
    grouped++;
    if (l === NO_PROJECT || majority.get(c) !== l) wrong++;
    else clustersPerProject.set(l, (clustersPerProject.get(l) ?? new Set()).add(c));
  });
  const fragmentation = [...clustersPerProject.values()].reduce((n, s) => n + s.size - 1, 0);
  const ratio = (a: number, b: number) => (b === 0 ? 0 : a / b);
  return {
    labeled,
    projectTabs,
    grouped,
    wrong,
    missed,
    coverage: ratio(grouped, labeled),
    errorRate: ratio(wrong, grouped),
    missRate: ratio(missed, projectTabs),
    fragmentation,
  };
}

export interface ArmResult {
  id: string;
  label: string;
  ms: number;
  batches: number;
  formatErrors: number;
  error?: string;
  prediction: Prediction;
  /** Cluster key → display name. */
  names: Record<string, string>;
  metrics: Metrics;
}

/** The "简单规则" baseline: same site, at least two tabs. */
export function domainBaseline(tabs: SampleTab[]): ArmResult {
  const t0 = performance.now();
  const counts = new Map<string, number>();
  const sites = tabs.map((t) => (parseUrl(t.url) ? siteOf(t.url) : ''));
  for (const s of sites) if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  const prediction = sites.map((s) => (s && (counts.get(s) ?? 0) >= 2 ? s : null));
  const names = Object.fromEntries([...new Set(prediction.filter((p): p is string => p !== null))].map((s) => [s, s]));
  return {
    id: 'domain',
    label: '按域名（基线）',
    ms: Math.round(performance.now() - t0),
    batches: 0,
    formatErrors: 0,
    prediction,
    names,
    metrics: score(tabs, prediction),
  };
}

/** Runs one model source over the sample from a cold start: no projects, no corrections. */
export async function modelArm(
  id: string,
  client: ModelClient,
  tabs: SampleTab[],
  opts: { template: string; threshold: number; domainOnly: boolean; onBatch?: (b: number, total: number) => void },
): Promise<ArmResult> {
  const promptTabs: PromptTab[] = tabs.map((t) => ({
    domain: hostname(t.url),
    path: opts.domainOnly ? '' : (parseUrl(t.url)?.pathname ?? ''),
    title: t.title,
  }));
  const t0 = performance.now();
  const r = await classify(client, promptTabs, {
    template: opts.template,
    threshold: opts.threshold,
    candidates: [],
    examples: [],
    onBatch: opts.onBatch,
  });
  const ms = Math.round(performance.now() - t0);
  const prediction: Prediction = tabs.map(() => null);
  for (const a of r.assignments) prediction[a.tabIndex] = a.target;
  const names = Object.fromEntries(r.proposals.map((p) => [p.tempId, p.name]));
  return {
    id,
    label: client.label,
    ms,
    batches: r.batches,
    formatErrors: r.formatErrors,
    error: r.error === undefined ? undefined : r.error instanceof Error ? r.error.message : String(r.error),
    prediction,
    names,
    metrics: score(tabs, prediction),
  };
}

/** A model source that could not run at all, shown in the table with its reason. */
export function failedArm(id: string, label: string, tabs: SampleTab[], error: unknown): ArmResult {
  const prediction: Prediction = tabs.map(() => null);
  return {
    id,
    label,
    ms: 0,
    batches: 0,
    formatErrors: 0,
    error: error instanceof Error ? error.message : String(error),
    prediction,
    names: {},
    metrics: score(tabs, prediction),
  };
}
