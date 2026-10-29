// End-to-end check of the built extension in Chrome for Testing, against a fake model server.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const [, , distDir, chromePath, outArg] = process.argv;
if (!chromePath) {
  console.error('Usage: node scripts/e2e.mjs <dist> <path to Chrome for Testing> [outDir]\nRun `npm run e2e:chrome` to download it.');
  process.exit(2);
}
const outDir = path.resolve(outArg ?? '.e2e');
fs.mkdirSync(outDir, { recursive: true });
const PORT = 18765;
const origin = `http://127.0.0.1:${PORT}`;
const log = (...a) => console.log('[e2e]', ...a);
const prompts = [];

// Fake OpenAI-compatible model: Alpha/Beta titles get projects, "Mystery" stays undecided.
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { messages } = JSON.parse(body);
      const user = messages.find((m) => m.role === 'user').content;
      prompts.push(user);
      const block = user.slice(user.indexOf('<<<TABS') + 7, user.indexOf('TABS>>>'));
      const lines = block.trim().split('\n');
      const candidates = [...user.matchAll(/^- (p_[^:]+|g_\d+): (.+?)(?: \(|$)/gm)].map((m) => ({ id: m[1], name: m[2] }));
      const alphaId = candidates.find((c) => c.name === 'Alpha 项目')?.id;
      const mine = candidates.find((c) => c.name === 'Mine');
      const projects = [];
      if (!alphaId) projects.push({ id: 'new-a', name: 'Alpha 项目', color: 'blue' });
      projects.push({ id: 'new-b', name: 'Beta', color: 'green' });
      const tabs = lines.map((l) => {
        const i = Number(l.split('.')[0]);
        if (l.includes('Alpha')) return [i, alphaId ?? 'new-a', 0.9];
        if (l.includes('Beta')) return [i, 'new-b', 0.85];
        if (l.includes('Gamma')) return [i, mine?.id ?? null, 0.9];
        return [i, null, 0.2];
      });
      const content = JSON.stringify({ projects, tabs });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
    return;
  }
  const title = decodeURIComponent(new URL(req.url, origin).searchParams.get('t') ?? 'page');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>${title}</title><meta name="description" content="desc of ${title}"><p>${title}</p><a id="l" href="/delta/1?t=Delta%20linked" target="_blank">link</a>`);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// Test build: grant the fake model host at install, since a headless run cannot click the permission prompt.
const testDist = path.join(outDir, 'dist-test');
fs.rmSync(testDist, { recursive: true, force: true });
fs.cpSync(distDir, testDist, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(testDist, 'manifest.json'), 'utf8'));
mf.host_permissions = ['http://127.0.0.1/*'];
fs.writeFileSync(path.join(testDist, 'manifest.json'), JSON.stringify(mf));

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  pipe: true,
  enableExtensions: [testDist],
  args: ['--no-first-run', '--no-default-browser-check'],
  userDataDir: path.join(outDir, 'profile'),
});

let failures = 0;
const check = (cond, msg) => {
  if (cond) log('PASS', msg);
  else {
    failures++;
    log('FAIL', msg);
  }
};

try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
  const extId = new URL(swTarget.url()).host;
  const sw = await swTarget.worker();
  log('extension', extId);

  await sw.evaluate(async (base) => {
    await chrome.storage.local.set({
      settings: { modelSource: 'custom', custom: { baseUrl: base, model: 'fake', apiKey: '' }, threshold: 0.6 },
    });
  }, `${origin}/v1`);

  const open = async (t, p = '/x') => {
    const page = await browser.newPage();
    await page.goto(`${origin}${p}?t=${encodeURIComponent(t)}`);
    return page;
  };
  await open('Alpha spec', '/alpha/1');
  const alphaPage = await open('Alpha notes', '/alpha/2');
  await open('Beta plan', '/beta/1');
  await open('Beta budget', '/beta/2');
  await open('Mystery page', '/m/1');
  await open('Gamma one', '/gamma/1');
  await open('Gamma two', '/gamma/2');
  await open('Alpha spec', '/alpha/1'); // duplicate of the first
  await browser.newPage(); // about:blank

  // The user already has a group of their own.
  const mineGroupId = await sw.evaluate(async (o) => {
    const tabs = await chrome.tabs.query({ url: `${o}/gamma/1*` });
    const id = await chrome.tabs.group({ tabIds: [tabs[0].id] });
    await chrome.tabGroups.update(id, { title: 'Mine', color: 'red' });
    return id;
  }, origin);

  const popup = await browser.newPage();
  await popup.setViewport({ width: 384, height: 640 });
  await popup.goto(`chrome-extension://${extId}/popup/index.html`);

  const waitTask = async () => {
    for (let i = 0; i < 100; i++) {
      const t = await sw.evaluate(async () => (await chrome.storage.session.get('task')).task);
      if (t && (t.status === 'done' || t.status === 'error')) return t;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('organize timed out');
  };

  // Before organizing, nothing is grouped except the user's group.
  const before = await sw.evaluate(async () => (await chrome.tabGroups.query({})).length);
  check(before === 1, 'opening tabs does not group anything');

  await popup.click('button.primary');
  const task = await waitTask();
  check(task.status === 'done', `organize finished (${task.status}${task.message ? `: ${task.message}` : ''})`);
  const r = task.result;
  log('result', JSON.stringify({ groups: r.groups, undecided: r.undecidedTabIds.length, cleanup: r.cleanup.map((c) => c.reason), notice: r.notice }));

  const groups = await sw.evaluate(async () => {
    const gs = await chrome.tabGroups.query({});
    const tabs = await chrome.tabs.query({});
    return gs.map((g) => ({ id: g.id, title: g.title, color: g.color, tabs: tabs.filter((t) => t.groupId === g.id).map((t) => t.title).sort() }));
  });
  log('groups', JSON.stringify(groups));
  const byTitle = Object.fromEntries(groups.map((g) => [g.title, g]));
  check(byTitle['Alpha 项目']?.tabs.join() === 'Alpha notes,Alpha spec,Alpha spec', 'Alpha tabs grouped into a new project group');
  check(byTitle['Beta']?.tabs.join() === 'Beta budget,Beta plan', 'Beta tabs grouped');
  check(byTitle['Mine']?.id === mineGroupId && byTitle['Mine'].color === 'red', 'user group keeps its id, title and colour');
  check(byTitle['Mine']?.tabs.join() === 'Gamma one,Gamma two', 'model can add a tab to the user group without renaming it');
  check(r.undecidedTabIds.length === 1, 'Mystery tab left undecided');
  check(r.cleanup.some((c) => c.reason === 'duplicate') && r.cleanup.some((c) => c.reason === 'blank'), 'duplicate and blank suggested, not closed');
  const tabCount = await sw.evaluate(async () => (await chrome.tabs.query({})).length);
  check(tabCount === 11, `no tab was closed by organizing (${tabCount} tabs)`);
  check(prompts.length === 1 && !prompts[0].includes('?t='), 'prompt sent once, without query strings');

  await popup.reload();
  await new Promise((res) => setTimeout(res, 300));
  await popup.screenshot({ path: path.join(outDir, 'popup-after-organize.png') });

  // The user drags a Beta tab into the Alpha group: recorded as a correction, tab locked.
  await sw.evaluate(async (o) => {
    const [t] = await chrome.tabs.query({ url: `${o}/beta/2*` });
    const [alpha] = await chrome.tabGroups.query({ title: 'Alpha 项目' });
    await chrome.tabs.group({ tabIds: [t.id], groupId: alpha.id });
  }, origin);
  await new Promise((res) => setTimeout(res, 500));
  const learned = await popup.evaluate(async () => {
    const locked = (await chrome.storage.session.get('lockedTabIds')).lockedTabIds ?? [];
    const db = await new Promise((res) => {
      const rq = indexedDB.open('tab-organizer');
      rq.onsuccess = () => res(rq.result);
    });
    const all = await new Promise((res) => {
      const rq = db.transaction('corrections').objectStore('corrections').getAll();
      rq.onsuccess = () => res(rq.result);
    });
    return { locked: locked.length, corrections: all.map((c) => `${c.fromGroupTitle}->${c.toGroupTitle}:${c.trust}`) };
  });
  log('learned', JSON.stringify(learned));
  check(learned.corrections.includes('Beta->Alpha 项目:high'), 'manual move recorded as a high-trust correction');
  check(!learned.corrections.some((c) => /->(Alpha 项目|Beta):/.test(c) && !c.startsWith('Beta->')), "the extension's own grouping was not recorded as corrections");
  check(learned.locked === 1, 'tab moved out of a group is locked for the session');

  // Undo: everything we placed goes back, except the tab the user moved afterwards.
  const undo = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'undo' }));
  log('undo', JSON.stringify(undo));
  check(undo.ok && undo.undo.skippedModified === 1, 'undo skips the tab the user changed afterwards');
  const afterUndo = await sw.evaluate(async () => {
    const gs = await chrome.tabGroups.query({});
    const tabs = await chrome.tabs.query({});
    return gs.map((g) => ({ title: g.title, tabs: tabs.filter((t) => t.groupId === g.id).map((t) => t.title).sort() }));
  });
  log('after undo', JSON.stringify(afterUndo));
  const au = Object.fromEntries(afterUndo.map((g) => [g.title, g.tabs.join()]));
  check(au['Mine'] === 'Gamma one', 'undo removes only our addition from the user group');
  check(au['Alpha 项目'] === 'Beta budget', "the user's own move survives undo");
  check(!('Beta' in au), 'groups we created are gone once empty');

  // Cleanup only closes what the user ticks, and can be undone.
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'organize' }));
  const t2 = await waitTask();
  const dup = t2.result.cleanup.find((c) => c.reason === 'duplicate');
  const closed = await popup.evaluate((id) => chrome.runtime.sendMessage({ type: 'closeTabs', tabIds: [id] }), dup.tabId);
  check(closed.ok && closed.closed === 1, 'closing a ticked duplicate closes exactly one tab');
  const reopened = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'undo' }));
  check(reopened.ok && reopened.undo.reopened === 1, 'undo reopens the closed duplicate');

  // "按域名整理剩余": the explicit fallback.
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'organize' }));
  const und = (await waitTask()).result.undecidedTabIds;
  const dom = await popup.evaluate((ids) => chrome.runtime.sendMessage({ type: 'organizeByDomain', tabIds: ids }), und);
  log('domain', JSON.stringify(dom), 'undecided', und.length);
  check(dom.ok, 'organize-by-domain runs only when asked');

  // A tab opened from a link in a grouped tab follows it without asking the model.
  const alphaGroup = await sw.evaluate(async (o) => (await chrome.tabs.query({ url: `${o}/alpha/2*` }))[0].groupId, origin);
  await alphaPage.bringToFront();
  await alphaPage.click('#l');
  await new Promise((res) => setTimeout(res, 800));
  const promptsBefore = prompts.length;
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'organize' }));
  await waitTask();
  const delta = await sw.evaluate(async (o) => (await chrome.tabs.query({ url: `${o}/delta/1*` }))[0]?.groupId, origin);
  check(alphaGroup !== -1 && delta === alphaGroup, 'link-opened tab follows its grouped opener');
  check(!prompts.slice(promptsBefore).some((p) => p.includes('Delta linked')), 'the model was not asked about the link-opened tab');

  const names = await popup.evaluate(async () => {
    const db = await new Promise((res) => {
      const rq = indexedDB.open('tab-organizer');
      rq.onsuccess = () => res(rq.result);
    });
    return new Promise((res) => {
      const rq = db.transaction('projects').objectStore('projects').getAll();
      rq.onsuccess = () => res(rq.result.map((p) => p.name));
    });
  });
  log('projects', JSON.stringify(names));
  check(new Set(names).size === names.length, 'no duplicate projects after undo and re-organize');

  const options = await browser.newPage();
  await options.setViewport({ width: 900, height: 1400 });
  await options.goto(`chrome-extension://${extId}/options/index.html`);
  await new Promise((res) => setTimeout(res, 500));

  // M0 evaluation: export, label, load, run.
  const cdp = await options.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: outDir });
  const clickButton = (text) =>
    options.evaluate((t) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === t).click(), text);
  await clickButton('导出当前标签页');
  let csvFile;
  for (let i = 0; i < 50 && !csvFile; i++) {
    await new Promise((res) => setTimeout(res, 100));
    csvFile = fs.readdirSync(outDir).find((f) => /^tab-sample-.*\.csv$/.test(f));
  }
  check(!!csvFile, 'evaluation sample exported as CSV');
  const exported = fs.readFileSync(path.join(outDir, csvFile), 'utf8');
  check(exported.startsWith('\uFEFFexpected,title,url') && !exported.includes('?t='), 'export has a BOM, the three columns and no query strings');
  const label = (title) =>
    /Alpha|Delta/.test(title) ? 'Alpha' : /Beta/.test(title) ? 'Beta' : /Gamma/.test(title) ? 'Gamma' : /Mystery/.test(title) ? '-' : '';
  const lines = exported.replace(/^\uFEFF/, '').trim().split('\r\n');
  const labeledCsv = [lines[0], ...lines.slice(1).map((l) => `${label(l)}${l}`)].join('\r\n');
  const labeledPath = path.join(outDir, 'labeled.csv');
  fs.writeFileSync(labeledPath, labeledCsv);
  const input = await options.$('input[type=file]');
  await input.uploadFile(labeledPath);
  await new Promise((res) => setTimeout(res, 300));
  await options.evaluate(() => {
    const box = [...document.querySelectorAll('label.check')].find((l) => l.textContent.includes('自定义接口（fake）'));
    box.querySelector('input').click();
  });
  await clickButton('运行评测');
  let rows = [];
  for (let i = 0; i < 100; i++) {
    await new Promise((res) => setTimeout(res, 150));
    rows = await options.evaluate(() => [...document.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.trim())));
    const done = await options.evaluate(() => ![...document.querySelectorAll('span.muted')].some((e) => e.textContent.startsWith('正在评测')));
    if (rows.length === 3 && done) break;
  }
  log('eval rows', JSON.stringify(rows));
  const row = (prefix) => rows.find((r) => r[0].startsWith(prefix));
  check(rows.length === 3, 'baseline, local model and custom endpoint all reported');
  check(row('按域名')?.[2].startsWith('0%') === false, 'domain baseline makes errors on a single-site sample');
  check(row('自定义接口')?.[2].startsWith('0%'), 'fake model has zero wrong groupings');
  check(!!row('本地模型') || !!row('Gemini'), 'local model row present (with its availability error if unsupported)');
  await options.screenshot({ path: path.join(outDir, 'options.png'), fullPage: true });
  const errors = [];
  options.on('pageerror', (e) => errors.push(e.message));
  popup.on('pageerror', (e) => errors.push(e.message));
  await options.reload();
  await popup.reload();
  await new Promise((res) => setTimeout(res, 500));
  check(errors.length === 0, `no page errors (${errors.join('; ')})`);
} catch (e) {
  failures++;
  log('ERROR', e.stack ?? e);
} finally {
  await browser.close();
  server.close();
}
log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
