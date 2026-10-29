import { applyAssignments } from './actions';
import { fetchSummary, readLiveState } from './chrome-state';
import { findCleanup } from './cleanup';
import { projects, urlRules } from './db';
import { correctionExamples, relinkGroups, ruleSuggestions } from './learning';
import { getModelClient, ModelUnavailableError, type ModelClient } from './models';
import { isMovable, planDeterministic } from './planner';
import { classify } from './classify';
import type { Candidate, PromptTab } from './prompt';
import { getSession } from './session';
import { getSettings, type Settings } from './settings';
import {
  type Assignment,
  type LiveState,
  type NewProjectProposal,
  type OrganizeResult,
  type Project,
  type TabInfo,
  type TabMeta,
} from './types';
import { isExcluded, isLowInfoTitle, sanitizeUrl, siteOf, hostname } from './urls';

function buildCandidates(state: LiveState, list: Project[], links: Record<number, string>, rulesByProject: Map<string, string[]>): Candidate[] {
  const out: Candidate[] = [];
  const known = new Set(list.map((p) => p.id));
  for (const p of list) {
    const urls = state.tabs
      .filter((t) => links[t.groupId] === p.id)
      .map((t) => sanitizeUrl(t.url))
      .concat(rulesByProject.get(p.id) ?? []);
    out.push({ id: `p_${p.id}`, name: p.name, keywords: p.keywords, sampleUrls: [...new Set(urls)].slice(0, 3) });
  }
  // Groups that are not linked to a project (the user's own, or from before install) are candidates too.
  for (const g of state.groups) {
    if (links[g.id] && known.has(links[g.id])) continue;
    const urls = state.tabs.filter((t) => t.groupId === g.id).map((t) => sanitizeUrl(t.url));
    out.push({ id: `g_${g.id}`, name: g.title || '（未命名分组）', keywords: [], sampleUrls: [...new Set(urls)].slice(0, 3) });
  }
  return out;
}

interface ModelStage {
  assignments: Assignment[];
  proposals: NewProjectProposal[];
  /** Set when a batch failed; earlier batches still count. */
  error?: unknown;
}

async function runModel(
  client: ModelClient,
  tabs: TabInfo[],
  settings: Settings,
  candidates: Candidate[],
  examples: Awaited<ReturnType<typeof correctionExamples>>,
  tabMeta: Record<number, TabMeta>,
  report: (step: string) => void,
): Promise<ModelStage> {
  const useSummary = settings.summaryEnabled && (!client.sendsOffDevice || settings.summaryToCloud);
  const indexOf = new Map(tabs.map((t, i) => [t.id, i]));
  const promptTabs: PromptTab[] = [];
  for (const t of tabs) {
    promptTabs.push({
      domain: hostname(t.url),
      path: settings.sendDomainOnly ? '' : new URL(t.url).pathname,
      title: t.title,
      summary: useSummary && isLowInfoTitle(t.title, t.url) ? await fetchSummary(t) : undefined,
      openerIndex: t.openerTabId === undefined ? undefined : indexOf.get(t.openerTabId),
      openedAt: tabMeta[t.id]?.openedAt,
    });
  }

  const r = await classify(client, promptTabs, {
    template: settings.template,
    threshold: settings.threshold,
    candidates,
    examples,
    onBatch: (b, total) => report(total > 1 ? `模型判断中（${b + 1}/${total}）` : '模型判断中'),
    onPrompt: async (prompt) => {
      if (client.sendsOffDevice) {
        await chrome.storage.local.set({ lastSent: { at: Date.now(), to: client.label, system: prompt.system, user: prompt.user } });
      }
    },
  });

  const assignments = r.assignments.map((a): Assignment => {
    const dest: Assignment['dest'] = a.target.startsWith('p_')
      ? { kind: 'project', projectId: a.target.slice(2) }
      : a.target.startsWith('g_')
        ? { kind: 'group', groupId: Number(a.target.slice(2)) }
        : { kind: 'new', tempId: a.target };
    return { tabId: tabs[a.tabIndex].id, dest, source: 'model', confidence: a.confidence, reason: a.reason };
  });
  return { assignments, proposals: r.proposals, error: r.error };
}

/** The whole "一键整理" run. Only ever called from an explicit user action. */
export async function organize(report: (step: string) => void): Promise<OrganizeResult> {
  report('读取标签页');
  const settings = await getSettings();
  const state = await readLiveState();
  const list = await projects.active();
  const links = await relinkGroups(state, list);
  const activeIds = new Set(list.map((p) => p.id));
  const rules = (await urlRules.all()).filter((r) => activeIds.has(r.projectId));
  const tabMeta = await getSession('tabMeta');
  const excluded = (url: string) => isExcluded(url, settings.excludedDomains, settings.useDefaultExclusions);

  const det = planDeterministic(state, {
    rules,
    lockedTabIds: new Set(await getSession('lockedTabIds')),
    tabMeta,
    isExcluded: excluded,
  });

  let notice: string | undefined;
  let model: ModelStage = { assignments: [], proposals: [] };
  if (det.remaining.length) {
    try {
      const client = await getModelClient(settings);
      const rulesByProject = new Map<string, string[]>();
      for (const r of rules) rulesByProject.set(r.projectId, [...(rulesByProject.get(r.projectId) ?? []), r.pattern]);
      const candidates = buildCandidates(state, list, links, rulesByProject);
      const examples = await correctionExamples(det.remaining, new Map(list.map((p) => [p.id, p.name])));
      model = await runModel(client, det.remaining, settings, candidates, examples, tabMeta, report);
      if (model.error) throw model.error;
    } catch (e) {
      notice =
        e instanceof ModelUnavailableError
          ? e.message
          : `模型调用失败（${e instanceof Error ? e.message : String(e)}），没判断的标签页留在组外。`;
    }
  }

  report('正在分组');
  const all = [...det.assignments, ...model.assignments];
  const applied = await applyAssignments(all, model.proposals, state, 'organize');

  const after = await readLiveState();
  const decided = new Set(all.map((a) => a.tabId));
  const undecidedTabIds = det.remaining.filter((t) => !decided.has(t.id)).map((t) => t.id);

  return {
    at: Date.now(),
    opLogId: applied.opLogId,
    groups: applied.groups,
    undecidedTabIds: undecidedTabIds.filter((id) => after.tabs.some((t) => t.id === id && isMovable(t))),
    skippedChanged: applied.skippedChanged,
    cleanup: findCleanup(after.tabs),
    ruleSuggestions: await ruleSuggestions(),
    notice,
  };
}

/** The explicit "按域名整理剩余标签页" button. Sites with a single tab stay ungrouped. */
export async function organizeByDomain(tabIds: number[]) {
  const state = await readLiveState();
  const wanted = new Set(tabIds);
  const locked = new Set(await getSession('lockedTabIds'));
  const bySite = new Map<string, TabInfo[]>();
  for (const t of state.tabs) {
    if (!wanted.has(t.id) || !isMovable(t) || locked.has(t.id)) continue;
    const key = `${t.windowId}|${siteOf(t.url)}`;
    bySite.set(key, [...(bySite.get(key) ?? []), t]);
  }
  const proposals: NewProjectProposal[] = [];
  const assignments: Assignment[] = [];
  let i = 0;
  for (const [key, tabs] of bySite) {
    if (tabs.length < 2) continue;
    const tempId = `site_${i}`;
    proposals.push({ tempId, name: key.split('|')[1], color: (['grey', 'blue', 'green', 'purple', 'cyan'] as const)[i++ % 5] });
    for (const t of tabs) assignments.push({ tabId: t.id, dest: { kind: 'new', tempId }, source: 'domain' });
  }
  return applyAssignments(assignments, proposals, state, 'domain', false);
}
