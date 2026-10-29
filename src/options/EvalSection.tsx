import { useState } from 'preact/hooks';
import { readLiveState } from '../core/chrome-state';
import { domainBaseline, explain, failedArm, modelArm, NO_PROJECT, parseSample, toCsv, type ArmResult, type SampleTab } from '../core/eval';
import { getModelClient } from '../core/models';
import { endpointFor, sendsOffDevice, type ModelSource, type Settings } from '../core/settings';
import { isExcluded, isWebUrl, sanitizeUrl } from '../core/urls';

function download(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

interface ArmOption {
  id: ModelSource | 'domain';
  label: string;
}

export function EvalSection({ s }: { s: Settings }) {
  const [sample, setSample] = useState<SampleTab[] | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set(['domain', 'nano']));
  const [progress, setProgress] = useState<string | null>(null);
  const [results, setResults] = useState<ArmResult[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const arms: ArmOption[] = [
    { id: 'domain', label: '按域名（基线）' },
    { id: 'nano', label: '本地模型（Gemini Nano）' },
    ...(s.custom.baseUrl ? [{ id: 'custom' as const, label: `自定义接口（${s.custom.model}）` }] : []),
    ...(s.cloud.baseUrl && s.cloud.apiKey ? [{ id: 'cloud' as const, label: `云端提供商（${s.cloud.model}）` }] : []),
  ];
  const offDeviceArms = arms.filter((a) => picked.has(a.id) && (a.id === 'custom' || a.id === 'cloud') && sendsOffDevice({ ...s, modelSource: a.id }));

  async function exportTabs() {
    const state = await readLiveState();
    const rows = state.tabs
      .filter((t) => !t.incognito && isWebUrl(t.url) && !isExcluded(t.url, s.excludedDomains, s.useDefaultExclusions))
      .map((t) => ({ expected: '', title: t.title, url: sanitizeUrl(t.url) }));
    const seen = new Set<string>();
    const unique = rows.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));
    download(`tab-sample-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(unique), 'text/csv;charset=utf-8');
  }

  async function load(file: File) {
    setFileError(null);
    setResults([]);
    try {
      setSample(parseSample(await file.text()));
    } catch (e) {
      setSample(null);
      setFileError(e instanceof Error ? e.message : String(e));
    }
  }

  async function run() {
    if (!sample) return;
    const out: ArmResult[] = [];
    setResults([]);
    for (const arm of arms.filter((a) => picked.has(a.id))) {
      setProgress(`正在评测：${arm.label}`);
      if (arm.id === 'domain') {
        out.push(domainBaseline(sample));
      } else {
        try {
          const client = await getModelClient({ ...s, modelSource: arm.id });
          out.push({
            ...(await modelArm(arm.id, client, sample, {
              template: s.template,
              threshold: s.threshold,
              domainOnly: s.sendDomainOnly,
              onBatch: (b, total) => setProgress(`正在评测：${arm.label}（${b + 1}/${total}）`),
            })),
            label: arm.label,
          });
        } catch (e) {
          out.push(failedArm(arm.id, arm.label, sample, e));
        }
      }
      setResults([...out]);
    }
    setProgress(null);
  }

  const labeled = sample?.filter((t) => t.expected).length ?? 0;
  const projectsCount = new Set(sample?.filter((t) => t.expected && t.expected !== NO_PROJECT).map((t) => t.expected)).size;

  return (
    <section class="card stack" style={{ padding: 16 }}>
      <h2>效果评测（M0）</h2>
      <ol style={{ margin: 0, paddingLeft: 18 }} class="stack">
        <li>
          打开 30–50 个你平时真实在用的标签页，点
          <button style={{ margin: '0 6px' }} onClick={exportTabs}>
            导出当前标签页
          </button>
          得到一个 CSV。只含标题和去掉参数的网址；排除名单里的网站和无痕窗口不会导出。
        </li>
        <li>
          用表格软件打开，在 <code>expected</code> 列写每个标签页应该属于的项目名；最好留在组外的写 <code>-</code>；不想评的留空。
        </li>
        <li>载入标好的文件，选择要对比的方式，运行。结果只显示在这里，可以下载报告。</li>
      </ol>

      <label>
        载入已标注的 CSV
        <input type="file" accept=".csv,text/csv" onChange={(e) => (e.target as HTMLInputElement).files?.[0] && load((e.target as HTMLInputElement).files![0])} />
      </label>
      {fileError && <div class="notice">{fileError}</div>}
      {sample && (
        <div class="muted">
          共 {sample.length} 个标签页，已标注 {labeled} 个，涉及 {projectsCount} 个项目。
          {labeled < 20 && ' 标注少于 20 个时结果波动会很大。'}
        </div>
      )}

      <div class="stack">
        {arms.map((a) => (
          <label class="check" key={a.id}>
            <input
              type="checkbox"
              checked={picked.has(a.id)}
              onChange={() =>
                setPicked((p) => {
                  const n = new Set(p);
                  if (n.has(a.id)) n.delete(a.id);
                  else n.add(a.id);
                  return n;
                })
              }
            />
            <span>{a.label}</span>
          </label>
        ))}
      </div>
      {offDeviceArms.length > 0 && (
        <div class="notice">
          {offDeviceArms.map((a) => new URL(endpointFor({ ...s, modelSource: a.id as ModelSource })!.baseUrl).host).join('、')}
          ：评测时会把样本里的标题和网址路径发送过去，与一键整理发送的内容相同。
        </div>
      )}
      <div class="row">
        <button class="primary" disabled={!sample || labeled === 0 || picked.size === 0 || progress !== null} onClick={run}>
          运行评测
        </button>
        {progress && <span class="muted">{progress}…</span>}
      </div>

      {results.length > 0 && sample && (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr class="muted" style={{ textAlign: 'left' }}>
                <th>方式</th>
                <th title="已分组 / 已标注">覆盖率</th>
                <th title="分错的 / 已分组">错分率</th>
                <th title="该分没分的 / 属于项目的">漏分率</th>
                <th title="一个项目被拆成多个组的次数">拆分</th>
                <th>耗时</th>
                <th title="模型返回无法解析的次数（含重试）">格式失败</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td>
                    <button class="link" onClick={() => setOpen(open === r.id ? null : r.id)}>
                      {r.label}
                    </button>
                    {r.error && <div class="notice" style={{ fontSize: 12 }}>{r.error}</div>}
                  </td>
                  <td>{pct(r.metrics.coverage)}</td>
                  <td>
                    <b>{pct(r.metrics.errorRate)}</b> <span class="muted">({r.metrics.wrong})</span>
                  </td>
                  <td>{pct(r.metrics.missRate)}</td>
                  <td>{r.metrics.fragmentation}</td>
                  <td>{r.ms < 1000 ? `${r.ms} ms` : `${(r.ms / 1000).toFixed(1)} s`}</td>
                  <td>
                    {r.formatErrors}
                    {r.batches ? `/${r.batches} 批` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div class="muted" style={{ fontSize: 12 }}>
            先看错分率：产品原则是拿不准就不动，宁可少分也不要分错。点方式名可以看每个组里分了什么。
          </div>
          {open && <Details result={results.find((r) => r.id === open)!} sample={sample} />}
          <div>
            <button
              onClick={() =>
                download(
                  `tab-eval-${new Date().toISOString().slice(0, 16).replace(':', '')}.json`,
                  JSON.stringify(
                    {
                      at: new Date().toISOString(),
                      template: s.template,
                      threshold: s.threshold,
                      sampleSize: sample.length,
                      labeled,
                      arms: results.map((r) => ({ ...r, prediction: r.prediction.map((p) => (p === null ? null : (r.names[p] ?? p))) })),
                      tabs: sample,
                    },
                    null,
                    2,
                  ),
                  'application/json',
                )
              }
            >
              下载报告
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function Details({ result, sample }: { result: ArmResult; sample: SampleTab[] }) {
  const { clusters, missed } = explain(sample, result.prediction);
  return (
    <div class="stack">
      {clusters.map((c) => (
        <div key={c.key} class="card" style={{ background: 'var(--bg)' }}>
          <div>
            <b>{result.names[c.key] ?? c.key}</b> <span class="muted">→ 对应「{c.matches ?? '无'}」</span>
          </div>
          <ul class="plain" style={{ marginTop: 6 }}>
            {c.tabs.map((t) => (
              <li key={t.index} class="truncate" style={{ color: t.wrong ? 'var(--danger)' : undefined }}>
                {t.wrong ? '✗ ' : ''}
                {sample[t.index].title || sample[t.index].url}
                {t.wrong && <span class="muted">（应为「{sample[t.index].expected}」）</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {missed.length > 0 && (
        <div class="card" style={{ background: 'var(--bg)' }}>
          <b>漏分（留在组外）</b>
          <ul class="plain" style={{ marginTop: 6 }}>
            {missed.map((i) => (
              <li key={i} class="truncate">
                {sample[i].title || sample[i].url} <span class="muted">（应为「{sample[i].expected}」）</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
