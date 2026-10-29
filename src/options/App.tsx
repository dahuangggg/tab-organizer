import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { clearAll, pageCache, projects as projectStore, urlRules } from '../core/db';
import { send } from '../core/messages';
import { downloadNano, nanoAvailability, type NanoAvailability } from '../core/models/nano';
import { setSession } from '../core/session';
import {
  DEFAULT_SETTINGS,
  getSettings,
  originPattern,
  saveSettings,
  sendsOffDevice,
  type EndpointConfig,
  type ModelSource,
  type Settings,
} from '../core/settings';
import { GROUP_COLORS, type GroupColor, type Project, type UrlRule } from '../core/types';
import { GROUP_COLOR_CSS, GROUP_COLOR_NAME } from '../ui/colors';
import { EvalSection } from './EvalSection';

const ALL_SITES = ['https://*/*', 'http://*/*'];

function Section({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="card stack" style={{ padding: 16 }}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function App() {
  const [s, setS] = useState<Settings | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    void getSettings().then(setS);
  }, []);

  if (!s) return null;

  const save = async (patch: Partial<Settings>, msg = '已保存') => {
    setS(await saveSettings(patch));
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '24px 16px 64px' }} class="stack">
      <h1 style={{ fontSize: 20 }}>AI 标签整理 · 设置</h1>
      <p class="muted">
        插件只在你点「一键整理」时工作。默认不向云端发送浏览数据；选择本地模型时，Chrome 第一次可能需要联网下载模型。
      </p>
      {toast && <div class="notice">{toast}</div>}
      <ModelSection s={s} save={save} />
      <OrganizeSection s={s} save={save} />
      <SummarySection s={s} save={save} />
      <PrivacySection s={s} save={save} />
      <MemorySection notify={setToast} />
      <EvalSection s={s} />
    </div>
  );
}

type Save = (patch: Partial<Settings>, msg?: string) => Promise<void>;

const SOURCES: { id: ModelSource; label: string; hint: string }[] = [
  { id: 'nano', label: '本地模型（Gemini Nano）', hint: '在这台电脑上运行，不发送数据。需要 Chrome 支持并下载模型。' },
  { id: 'custom', label: '自定义接口', hint: 'OpenAI 兼容格式，例如本机的 Ollama（http://localhost:11434/v1）。' },
  { id: 'cloud', label: '云端提供商', hint: 'OpenAI 兼容接口。整理时会把下方列出的字段发送到该服务。' },
  { id: 'none', label: '不用模型', hint: '只按你确认过的规则和打开关系整理，其余留在组外。' },
];

function ModelSection({ s, save }: { s: Settings; save: Save }) {
  const [source, setSource] = useState<ModelSource>(s.modelSource);
  const [custom, setCustom] = useState<EndpointConfig>(s.custom);
  const [cloud, setCloud] = useState<EndpointConfig>(s.cloud);
  const [consent, setConsent] = useState(s.cloudConsentAt !== null);
  const [error, setError] = useState<string | null>(null);

  const draft: Settings = { ...s, modelSource: source, custom, cloud };
  const offDevice = sendsOffDevice(draft);
  const endpoint = source === 'cloud' ? cloud : source === 'custom' ? custom : null;
  const host = endpoint ? (() => { try { return new URL(endpoint.baseUrl).host; } catch { return endpoint.baseUrl; } })() : '';

  async function onSave() {
    setError(null);
    if (endpoint) {
      const pattern = originPattern(endpoint.baseUrl);
      if (!pattern || !endpoint.model) return setError('请填写有效的接口地址和模型名。');
      // Must run inside the click: Chrome only shows the permission prompt for a user gesture.
      const granted = await chrome.permissions.request({ origins: [pattern] });
      if (!granted) return setError('没有获得访问该地址的授权，模型无法调用。');
    }
    if (offDevice && !consent) return setError('请先勾选确认会发送的内容。');
    await save({
      modelSource: source,
      custom,
      cloud,
      cloudConsentAt: offDevice ? Date.now() : s.cloudConsentAt,
    });
  }

  return (
    <Section title="模型来源">
      {SOURCES.map((o) => (
        <label class="check" key={o.id}>
          <input type="radio" name="source" checked={source === o.id} onChange={() => setSource(o.id)} />
          <span>
            {o.label}
            <div class="muted">{o.hint}</div>
          </span>
        </label>
      ))}

      {source === 'nano' && <NanoStatus />}
      {source === 'custom' && <EndpointFields value={custom} onChange={setCustom} keyOptional />}
      {source === 'cloud' && <EndpointFields value={cloud} onChange={setCloud} />}

      {offDevice && (
        <div class="notice stack">
          <div>选择这个来源后，每次一键整理会把以下内容发送到 <b>{host}</b>：</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>还没分组的标签页标题</li>
            <li>{s.sendDomainOnly ? '标签页的域名' : '去掉参数和 # 后的网址'}</li>
            <li>已有项目和分组的名称、示例网址，以及你的整理模板和手动调整过的示例</li>
            <li>{s.summaryEnabled && s.summaryToCloud ? '标题信息量低的页面摘要（已允许）' : '页面摘要不会发送（除非在「页面摘要」里单独允许）'}</li>
          </ul>
          <div>不会发送：书签、浏览历史、排除名单里的网站、无痕窗口。</div>
          <label class="check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent((e.target as HTMLInputElement).checked)} />
            <span>我了解并同意发送以上内容</span>
          </label>
        </div>
      )}

      {error && <div class="notice">{error}</div>}
      <div class="row">
        <button class="primary" onClick={onSave}>
          保存模型设置
        </button>
        {source === 'cloud' && s.cloud.apiKey && (
          <button
            class="danger"
            onClick={() => {
              setCloud({ ...cloud, apiKey: '' });
              void save({ cloud: { ...s.cloud, apiKey: '' } }, '已删除 key');
            }}
          >
            删除已保存的 key
          </button>
        )}
      </div>
    </Section>
  );
}

function EndpointFields({ value, onChange, keyOptional }: { value: EndpointConfig; onChange: (v: EndpointConfig) => void; keyOptional?: boolean }) {
  const field = (k: keyof EndpointConfig) => (e: Event) => onChange({ ...value, [k]: (e.target as HTMLInputElement).value.trim() });
  return (
    <div class="stack">
      <label>
        接口地址
        <input type="url" value={value.baseUrl} onInput={field('baseUrl')} placeholder="https://api.openai.com/v1" />
      </label>
      <label>
        模型名
        <input type="text" value={value.model} onInput={field('model')} />
      </label>
      <label>
        API key{keyOptional ? '（可不填）' : ''}
        <input type="password" value={value.apiKey} onInput={field('apiKey')} autocomplete="off" />
      </label>
      <div class="muted" style={{ fontSize: 12 }}>
        key 保存在本机的扩展存储里，这里没有加密。建议使用权限和额度受限的 key。
      </div>
    </div>
  );
}

const NANO_TEXT: Record<NanoAvailability, string> = {
  available: '可用',
  downloadable: '需要下载模型',
  downloading: '正在下载',
  unavailable: '这台电脑上的 Chrome 不支持',
};

function NanoStatus() {
  const [state, setState] = useState<NanoAvailability | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void nanoAvailability().then(setState);
  }, []);
  if (!state) return null;
  return (
    <div class="stack">
      <div>
        状态：{NANO_TEXT[state]}
        {progress !== null && progress < 1 && `（${Math.round(progress * 100)}%）`}
      </div>
      {(state === 'downloadable' || state === 'downloading') && (
        <button
          onClick={async () => {
            setError(null);
            try {
              await downloadNano(setProgress);
              setState(await nanoAvailability());
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          下载本地模型
        </button>
      )}
      {error && <div class="notice">{error}</div>}
      <div class="muted" style={{ fontSize: 12 }}>
        中文标题的效果因 Chrome 版本而异，建议先用几次看看结果。
      </div>
    </div>
  );
}

function OrganizeSection({ s, save }: { s: Settings; save: Save }) {
  const [template, setTemplate] = useState(s.template);
  return (
    <Section title="整理偏好">
      <label>
        整理模板（用自然语言描述你想怎么分组）
        <textarea value={template} onInput={(e) => setTemplate((e.target as HTMLTextAreaElement).value)} />
      </label>
      <label>
        归组门槛：{s.threshold.toFixed(2)}
        <input
          type="range"
          min="0.3"
          max="0.95"
          step="0.05"
          value={s.threshold}
          style={{ width: '100%' }}
          onChange={(e) => void save({ threshold: Number((e.target as HTMLInputElement).value) })}
        />
        <div class="muted" style={{ fontSize: 12 }}>
          越高越保守：模型越有把握才归组，留在组外的标签页会更多。默认 {DEFAULT_SETTINGS.threshold}。
        </div>
      </label>
      <div>
        <button onClick={() => void save({ template })}>保存模板</button>
      </div>
    </Section>
  );
}

function SummarySection({ s, save }: { s: Settings; save: Save }) {
  const [warn, setWarn] = useState<string | null>(null);

  async function toggle(on: boolean) {
    setWarn(null);
    if (on) {
      const granted = await chrome.permissions.request({ origins: ALL_SITES });
      if (!granted) return setWarn('没有获得读取网页内容的授权，摘要功能保持关闭。');
      await save({ summaryEnabled: true }, '已开启页面摘要');
      return;
    }
    await save({ summaryEnabled: false, summaryToCloud: false }, '已关闭页面摘要并清空缓存');
    await pageCache.clear();
    await chrome.permissions.remove({ origins: ALL_SITES });
    const cfg = s.modelSource === 'cloud' ? s.cloud : s.modelSource === 'custom' ? s.custom : null;
    const pattern = cfg && originPattern(cfg.baseUrl);
    if (pattern && !(await chrome.permissions.contains({ origins: [pattern] }))) {
      setWarn('撤销网页权限时，模型接口的授权也一起被撤销了，请在「模型来源」里重新保存一次。');
    }
  }

  return (
    <Section title="页面摘要（可选）">
      <div class="muted">
        开启后，整理时只对「Untitled」「Dashboard」这类标题信息量低的页面，读取页面描述和正文前 500 字，帮助判断分组。需要授权读取网站内容。
      </div>
      <label class="check">
        <input type="checkbox" checked={s.summaryEnabled} onChange={(e) => void toggle((e.target as HTMLInputElement).checked)} />
        <span>开启页面摘要</span>
      </label>
      <label class="check">
        <input
          type="checkbox"
          disabled={!s.summaryEnabled}
          checked={s.summaryToCloud}
          onChange={(e) => void save({ summaryToCloud: (e.target as HTMLInputElement).checked })}
        />
        <span>
          允许把摘要发送到云端或远程接口
          <div class="muted">不勾选时，摘要只给本地模型使用。</div>
        </span>
      </label>
      {warn && <div class="notice">{warn}</div>}
    </Section>
  );
}

function PrivacySection({ s, save }: { s: Settings; save: Save }) {
  const [domains, setDomains] = useState(s.excludedDomains.join('\n'));
  const [sent, setSent] = useState<{ at: number; to: string; system: string; user: string } | null>(null);
  const [showSent, setShowSent] = useState(false);

  useEffect(() => {
    void chrome.storage.local.get('lastSent').then((v) => setSent((v.lastSent as typeof sent) ?? null));
  }, []);

  return (
    <Section title="隐私">
      <label class="check">
        <input type="checkbox" checked={s.sendDomainOnly} onChange={(e) => void save({ sendDomainOnly: (e.target as HTMLInputElement).checked })} />
        <span>发送给模型时只带域名，不带网址路径</span>
      </label>
      <label class="check">
        <input
          type="checkbox"
          checked={s.useDefaultExclusions}
          onChange={(e) => void save({ useDefaultExclusions: (e.target as HTMLInputElement).checked })}
        />
        <span>
          自动排除常见敏感网站（网银、邮箱、支付、医疗类）
          <div class="muted">排除的网站不会被读取、摘要或发送。名单只能降低风险，不能保证覆盖所有敏感网站。</div>
        </span>
      </label>
      <label>
        自定义排除的域名（每行一个，含子域名）
        <textarea value={domains} onInput={(e) => setDomains((e.target as HTMLTextAreaElement).value)} placeholder="example.com" />
      </label>
      <div>
        <button
          onClick={() =>
            void save({
              excludedDomains: domains
                .split('\n')
                .map((d) => d.trim())
                .filter(Boolean),
            })
          }
        >
          保存排除名单
        </button>
      </div>

      <div class="spread">
        <span>
          上次发送到模型的内容：{sent ? `${new Date(sent.at).toLocaleString()} → ${sent.to}` : '无'}
        </span>
        {sent && (
          <span class="row">
            <button class="link" onClick={() => setShowSent(!showSent)}>
              {showSent ? '收起' : '查看'}
            </button>
            <button
              class="link"
              onClick={async () => {
                await chrome.storage.local.remove('lastSent');
                setSent(null);
              }}
            >
              删除
            </button>
          </span>
        )}
      </div>
      {sent && showSent && <pre class="sent">{`${sent.system}\n\n${sent.user}`}</pre>}
      <div class="muted" style={{ fontSize: 12 }}>
        这份记录只保存在本机，不包含 key。只有发送到云端或远程接口时才会记录。
      </div>
    </Section>
  );
}

function MemorySection({ notify }: { notify: (m: string) => void }) {
  const [list, setList] = useState<Project[]>([]);
  const [rules, setRules] = useState<UrlRule[]>([]);

  const reload = async () => {
    setList((await projectStore.all()).sort((a, b) => b.lastActiveAt - a.lastActiveAt));
    setRules(await urlRules.all());
  };
  useEffect(() => {
    void reload();
  }, []);

  const names = new Map(list.map((p) => [p.id, p.name]));

  return (
    <Section title="记忆">
      <div class="muted">项目来自整理结果和你的手动调整。改名或删除只影响以后的整理，不会改动已经打开的分组。</div>
      {list.length === 0 && <div class="muted">还没有项目。</div>}
      <ul class="plain">
        {list.map((p) => (
          <li class="row" key={p.id}>
            <span class="dot" style={{ background: GROUP_COLOR_CSS[p.color] }} />
            <input
              type="text"
              value={p.name}
              style={{ flex: 1 }}
              onChange={async (e) => {
                const name = (e.target as HTMLInputElement).value.trim().slice(0, 20);
                if (name) await projectStore.put({ ...p, name });
                await reload();
              }}
            />
            <select
              value={p.color}
              onChange={async (e) => {
                await projectStore.put({ ...p, color: (e.target as HTMLSelectElement).value as GroupColor });
                await reload();
              }}
            >
              {GROUP_COLORS.map((c) => (
                <option value={c} key={c}>
                  {GROUP_COLOR_NAME[c]}
                </option>
              ))}
            </select>
            <button
              onClick={async () => {
                await projectStore.put({ ...p, archived: !p.archived });
                await reload();
              }}
            >
              {p.archived ? '恢复' : '归档'}
            </button>
            <button
              class="danger"
              onClick={async () => {
                await projectStore.remove(p.id);
                await reload();
              }}
            >
              删除
            </button>
          </li>
        ))}
      </ul>

      <h2 style={{ marginTop: 16 }}>已确认的网址规则</h2>
      {rules.length === 0 && <div class="muted">还没有规则。手动调整两次同一路径后，整理结果里会询问是否添加。</div>}
      <ul class="plain">
        {rules.map((r) => (
          <li class="spread" key={r.id}>
            <span class="truncate">
              {r.pattern.replace(/^https?:\/\//, '')} → {names.get(r.projectId) ?? '（已删除的项目）'}
            </span>
            <button
              class="danger"
              onClick={async () => {
                await urlRules.remove(r.id);
                await reload();
              }}
            >
              删除
            </button>
          </li>
        ))}
      </ul>

      <div class="row" style={{ marginTop: 12 }}>
        <button
          onClick={async () => {
            await send({ type: 'unlockAll' });
            notify('已解除所有锁定的标签页');
          }}
        >
          解除所有锁定的标签页
        </button>
        <button
          class="danger"
          onClick={async () => {
            if (!confirm('清空所有项目、规则、手动调整记录、页面摘要和撤销记录？')) return;
            await clearAll();
            await setSession('groupLinks', {});
            await chrome.storage.local.remove(['dismissedRules', 'lastSent']);
            await reload();
            notify('已清空全部记忆');
          }}
        >
          清空全部记忆
        </button>
      </div>
    </Section>
  );
}
