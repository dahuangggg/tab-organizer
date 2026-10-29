import { useEffect, useState } from 'preact/hooks';
import { send, type Request } from '../core/messages';
import type { CleanupItem, OrganizeResult, TaskState, UndoReport } from '../core/types';
import { GROUP_COLOR_CSS } from '../ui/colors';

const STALE_AFTER = 3 * 60_000;

function useTask(): TaskState {
  const [task, setTask] = useState<TaskState>({ status: 'idle' });
  useEffect(() => {
    void chrome.storage.session.get('task').then((v) => v.task && setTask(v.task as TaskState));
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes.task) setTask((changes.task.newValue as TaskState) ?? { status: 'idle' });
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);
  return task;
}

function undoText(r: UndoReport): string {
  const parts = [`已撤销 ${r.restored} 个标签页`];
  if (r.reopened) parts.push(`重新打开 ${r.reopened} 个`);
  if (r.skippedModified) parts.push(`${r.skippedModified} 个因之后被你修改过，未撤销`);
  if (r.missing) parts.push(`${r.missing} 个已关闭`);
  return parts.join('，');
}

export function App() {
  const task = useTask();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const running = task.status === 'running';
  const stale = running && Date.now() - task.startedAt > STALE_AFTER;

  async function act(req: Request, onOk?: (r: Awaited<ReturnType<typeof send>>) => string | null) {
    setBusy(true);
    setMessage(null);
    try {
      const r = await send(req);
      if (!r.ok) setMessage(r.error);
      else if (onOk) setMessage(onOk(r));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ width: 360, padding: 12 }} class="stack">
      <div class="spread">
        <h1>AI 标签整理</h1>
        <button class="link" onClick={() => chrome.runtime.openOptionsPage()}>
          设置
        </button>
      </div>

      <button
        class="primary"
        style={{ width: '100%', padding: '8px 10px' }}
        disabled={(running && !stale) || busy}
        onClick={() => act({ type: 'organize' })}
      >
        {running && !stale ? `${task.step}…` : '一键整理'}
      </button>
      <div class="muted" style={{ fontSize: 12 }}>
        只整理还没分组的标签页，已有分组不会被改动。快捷键 Alt+G。
      </div>

      {stale && <div class="notice">上次整理似乎卡住了，可以再点一次。</div>}
      {task.status === 'error' && <div class="notice">{task.message}</div>}
      {task.status === 'done' && <ResultView result={task.result} busy={busy} act={act} />}

      {message && <div class="card">{message}</div>}

      <div class="spread" style={{ paddingTop: 4 }}>
        <button
          disabled={busy || (running && !stale)}
          onClick={() => act({ type: 'undo' }, (r) => (r.ok && r.undo ? undoText(r.undo) : '没有可撤销的整理。'))}
        >
          撤销上次整理
        </button>
      </div>
    </div>
  );
}

function ResultView({
  result,
  busy,
  act,
}: {
  result: OrganizeResult;
  busy: boolean;
  act: (req: Request, onOk?: (r: Awaited<ReturnType<typeof send>>) => string | null) => Promise<void>;
}) {
  const total = result.groups.reduce((n, g) => n + g.added, 0);
  const nothing = total === 0 && result.undecidedTabIds.length === 0;

  return (
    <div class="stack">
      {result.notice && <div class="notice">{result.notice}</div>}

      <div class="card stack">
        {nothing ? (
          <div>没有需要整理的标签页。</div>
        ) : (
          <>
            <div class="muted">已整理 {total} 个标签页</div>
            <ul class="plain">
              {result.groups.map((g) => (
                <li class="row" key={`${g.title}${g.isNew}`}>
                  <span class="dot" style={{ background: GROUP_COLOR_CSS[g.color] }} />
                  <span class="truncate" style={{ flex: 1 }}>
                    {g.title || '（未命名）'}
                  </span>
                  {g.isNew && <span class="tag">新建</span>}
                  <span>+{g.added}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {result.skippedChanged > 0 && (
          <div class="muted">{result.skippedChanged} 个标签页在整理期间被你改动过，已跳过。</div>
        )}
        {result.undecidedTabIds.length > 0 && (
          <div class="spread">
            <span>{result.undecidedTabIds.length} 个标签页无法判断，留在组外</span>
            <button
              disabled={busy}
              onClick={() =>
                act({ type: 'organizeByDomain', tabIds: result.undecidedTabIds }, (r) =>
                  r.ok ? (r.added ? `按域名整理了 ${r.added} 个标签页。` : '剩下的标签页来自不同网站，没有可合并的。') : null,
                )
              }
            >
              按域名整理剩余
            </button>
          </div>
        )}
      </div>

      {result.ruleSuggestions.map((s) => (
        <div class="card stack" key={s.pattern}>
          <div>
            以后把 <code class="truncate">{s.pattern.replace(/^https?:\/\//, '')}</code> 下的页面都归到「{s.projectName}」？
          </div>
          <div class="row">
            <button disabled={busy} onClick={() => act({ type: 'acceptRule', pattern: s.pattern, projectId: s.projectId })}>
              好
            </button>
            <button disabled={busy} onClick={() => act({ type: 'dismissRule', pattern: s.pattern, projectId: s.projectId })}>
              不用
            </button>
          </div>
        </div>
      ))}

      {result.cleanup.length > 0 && <CleanupView items={result.cleanup} busy={busy} act={act} />}
    </div>
  );
}

function CleanupView({
  items,
  busy,
  act,
}: {
  items: CleanupItem[];
  busy: boolean;
  act: (req: Request, onOk?: (r: Awaited<ReturnType<typeof send>>) => string | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(() => new Set(items.map((i) => i.tabId)));
  const dup = items.filter((i) => i.reason === 'duplicate').length;
  const blank = items.length - dup;
  const summary = [dup && `${dup} 个重复页`, blank && `${blank} 个空白页`].filter(Boolean).join('、');

  const toggle = (id: number) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div class="card stack">
      <div class="spread">
        <span>发现 {summary}</span>
        <button class="link" onClick={() => setOpen(!open)}>
          {open ? '收起' : '查看并清理'}
        </button>
      </div>
      {open && (
        <>
          <ul class="plain">
            {items.map((i) => (
              <li key={i.tabId}>
                <label class="check">
                  <input type="checkbox" checked={picked.has(i.tabId)} onChange={() => toggle(i.tabId)} />
                  <span class="truncate">
                    <span class="tag">{i.reason === 'duplicate' ? '重复' : '空白'}</span> {i.title || i.url}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div class="muted" style={{ fontSize: 12 }}>
            关闭后可以撤销，但页面里未保存的内容不保证能恢复。
          </div>
          <button
            disabled={busy || picked.size === 0}
            onClick={() => act({ type: 'closeTabs', tabIds: [...picked] }, (r) => (r.ok ? `已关闭 ${r.closed ?? 0} 个标签页。` : null))}
          >
            关闭所选（{picked.size}）
          </button>
        </>
      )}
    </div>
  );
}
