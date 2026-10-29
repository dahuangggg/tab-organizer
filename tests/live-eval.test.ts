/**
 * Live M0 evaluation against a real OpenAI-compatible endpoint. Skipped unless a key is configured.
 *
 *   .env.local (git-ignored):
 *     EVAL_API_KEY=sk-...
 *     EVAL_BASE_URL=https://api.openai.com/v1   # optional
 *     EVAL_MODEL=gpt-4o-mini                     # optional
 *     EVAL_SAMPLE=path/to/labeled.csv            # optional, defaults to tests/fixtures/sample.csv
 *
 *   npm run eval:live
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { domainBaseline, explain, modelArm, parseSample, type ArmResult, type SampleTab } from '../src/core/eval';
import { openAiClient } from '../src/core/models/openai';

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (existsSync('.env.local')) {
    for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return { ...env, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('EVAL_')) as [string, string][]) };
}

const env = loadEnv();
const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(5);

function report(tabs: SampleTab[], r: ArmResult): string {
  const m = r.metrics;
  const lines = [
    `${r.label}`,
    `  覆盖率 ${pct(m.coverage)}  错分率 ${pct(m.errorRate)} (${m.wrong}/${m.grouped})  漏分率 ${pct(m.missRate)} (${m.missed}/${m.projectTabs})  拆分 ${m.fragmentation}  耗时 ${(r.ms / 1000).toFixed(1)}s  格式失败 ${r.formatErrors}${r.batches ? `/${r.batches}批` : ''}`,
  ];
  if (r.error) lines.push(`  错误：${r.error}`);
  const { clusters, missed } = explain(tabs, r.prediction);
  for (const c of clusters) {
    lines.push(`  [${r.names[c.key] ?? c.key}] → ${c.matches ?? '无'}`);
    for (const t of c.tabs) lines.push(`    ${t.wrong ? '✗' : ' '} ${tabs[t.index].title}${t.wrong ? `（应为 ${tabs[t.index].expected}）` : ''}`);
  }
  if (missed.length) {
    lines.push('  [留在组外]');
    for (const i of missed) lines.push(`      ${tabs[i].title}（应为 ${tabs[i].expected}）`);
  }
  return lines.join('\n');
}

// Only via `npm run eval:live`, so `npm test` never calls a paid API even when a key is present.
describe.runIf(!!env.EVAL_API_KEY && process.env.EVAL_LIVE === '1')('live evaluation', () => {
  it(
    'runs the domain baseline and the configured model over the labeled sample',
    async () => {
      const samplePath = env.EVAL_SAMPLE || 'tests/fixtures/sample.csv';
      const tabs = parseSample(readFileSync(samplePath, 'utf8'));
      const cfg = {
        baseUrl: env.EVAL_BASE_URL || 'https://api.openai.com/v1',
        model: env.EVAL_MODEL || 'gpt-4o-mini',
        apiKey: env.EVAL_API_KEY,
      };
      const base = openAiClient(cfg, `${cfg.model} @ ${new URL(cfg.baseUrl).host}`, true);
      // Keep the raw answers next to the report, to see why a tab was dropped.
      const raw: string[] = [];
      const client = { ...base, complete: async (...a: Parameters<typeof base.complete>) => { const r = await base.complete(...a); raw.push(r); return r; } };

      const baseline = domainBaseline(tabs);
      const live = await modelArm('live', client, tabs, {
        template: DEFAULT_SETTINGS.template,
        threshold: DEFAULT_SETTINGS.threshold,
        domainOnly: false,
      });

      const text = [`样本：${samplePath}，${tabs.length} 个标签页`, report(tabs, baseline), report(tabs, live)].join('\n\n');
      console.log(`\n${text}\n`);
      writeFileSync('.eval-live-report.txt', `${text}\n`);
      writeFileSync('.eval-live-raw.txt', raw.join('\n\n---\n\n'));
      expect(live.error).toBeUndefined();
    },
    180_000,
  );
});
