import { describe, expect, it } from 'vitest';
import { domainBaseline, explain, modelArm, parseSample, score, toCsv, type SampleTab } from '../src/core/eval';
import type { ModelClient } from '../src/core/models';

const t = (expected: string, title: string, url: string): SampleTab => ({ expected, title, url });

describe('sample CSV', () => {
  it('round-trips commas, quotes, newlines and Chinese through a BOM-prefixed file', () => {
    const tabs = [t('标签插件', 'Fix "grouping", part 1', 'https://github.com/a/b'), t('', '多行\n标题', 'https://x.com/p'), t('-', '', 'https://y.com/')];
    const csv = toCsv(tabs);
    expect(csv.startsWith('﻿expected,title,url')).toBe(true);
    expect(parseSample(csv)).toEqual(tabs);
  });

  it('accepts columns in any order and rejects files without them', () => {
    expect(parseSample('url,expected,title\nhttps://a.com/,P,A\n')).toEqual([t('P', 'A', 'https://a.com/')]);
    expect(() => parseSample('name,link\na,b')).toThrow('expected');
  });
});

describe('scoring', () => {
  const tabs = [
    t('A', 'a1', 'https://a.com/1'),
    t('A', 'a2', 'https://a.com/2'),
    t('A', 'a3', 'https://b.com/3'),
    t('B', 'b1', 'https://b.com/1'),
    t('B', 'b2', 'https://c.com/2'),
    t('-', 'misc', 'https://d.com/'),
    t('', 'unlabeled', 'https://e.com/'),
  ];

  it('matches clusters to projects by majority and counts errors, misses and splits', () => {
    // x = A's group (with one B inside), y = A split off, misc wrongly grouped; b2 missed.
    const m = score(tabs, ['x', 'x', 'y', 'x', null, 'z', 'x']);
    expect(m).toMatchObject({ labeled: 6, projectTabs: 5, grouped: 5, wrong: 2, missed: 1, fragmentation: 1 });
    expect(m.errorRate).toBeCloseTo(2 / 5);
    expect(m.coverage).toBeCloseTo(5 / 6);
    expect(m.missRate).toBeCloseTo(1 / 5);
  });

  it('leaving everything ungrouped makes no errors but misses every project tab', () => {
    const m = score(tabs, tabs.map(() => null));
    expect(m).toMatchObject({ grouped: 0, wrong: 0, errorRate: 0, missRate: 1, coverage: 0 });
  });

  it('explains which tabs in a cluster are wrong', () => {
    const e = explain(tabs, ['x', 'x', 'y', 'x', null, 'z', null]);
    const x = e.clusters.find((c) => c.key === 'x')!;
    expect(x.matches).toBe('A');
    expect(x.tabs.filter((m) => m.wrong).map((m) => m.index)).toEqual([3]);
    expect(e.clusters.find((c) => c.key === 'z')!.tabs[0].wrong).toBe(true);
    expect(e.missed).toEqual([4]);
  });

  it('the domain baseline groups same-site tabs only', () => {
    const r = domainBaseline(tabs);
    expect(r.prediction).toEqual(['a.com', 'a.com', 'b.com', 'b.com', null, null, null]);
    expect(r.metrics.wrong).toBe(1);
  });
});

describe('model arm', () => {
  it('runs the shared classifier in batches and counts format failures', async () => {
    const tabs = Array.from({ length: 5 }, (_, i) => t(i < 3 ? 'A' : 'B', i < 3 ? `Alpha ${i}` : `Beta ${i}`, `https://s.com/${i}`));
    let call = 0;
    const client: ModelClient = {
      label: 'fake',
      maxBatch: 3,
      sendsOffDevice: false,
      async complete(_system, user) {
        call++;
        if (call === 2) return 'not json'; // second batch fails once, then succeeds on retry
        const lines = user.slice(user.indexOf('<<<TABS') + 7, user.indexOf('TABS>>>')).trim().split('\n');
        const reuse = user.includes('new_0_n1') ? 'new_0_n1' : 'n1';
        return JSON.stringify({
          projects: [
            { id: 'n1', name: 'Alpha', color: 'blue' },
            { id: 'n2', name: 'Beta', color: 'green' },
          ],
          tabs: lines.map((l, i) => [i, l.includes('Alpha') ? reuse : 'n2', 0.9]),
        });
      },
    };
    const r = await modelArm('fake', client, tabs, { template: '', threshold: 0.6, domainOnly: false });
    expect(r.batches).toBe(2);
    expect(r.formatErrors).toBe(1);
    expect(r.error).toBeUndefined();
    expect(r.metrics).toMatchObject({ grouped: 5, wrong: 0, fragmentation: 0 });
    expect(new Set(r.prediction.slice(0, 3)).size).toBe(1);
  });
});

describe('skipped tabs', () => {
  it('asks again about tabs the model left out, offering its own new projects', async () => {
    const tabs = Array.from({ length: 4 }, (_, i) => t('A', `Alpha ${i}`, `https://s.com/${i}`));
    const prompts: string[] = [];
    const client: ModelClient = {
      label: 'fake',
      maxBatch: 10,
      sendsOffDevice: false,
      async complete(_system, user) {
        prompts.push(user);
        if (prompts.length === 1) {
          // Answers only the first two tabs.
          return JSON.stringify({ projects: [{ id: 'new-1', name: 'Alpha', color: 'blue' }], tabs: [[0, 'new-1', 0.9], [1, 'new-1', 0.9]] });
        }
        const id = user.match(/- (new_\S+): Alpha/)![1];
        return JSON.stringify({ projects: [], tabs: [[0, id, 0.9], [1, id, 0.9]] });
      },
    };
    const r = await modelArm('fake', client, tabs, { template: '', threshold: 0.6, domainOnly: false });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Alpha 2');
    expect(prompts[1]).not.toContain('Alpha 0');
    expect(new Set(r.prediction)).toEqual(new Set(['new_0_new-1']));
    expect(r.metrics.missed).toBe(0);
  });
});

describe('repeated proposals', () => {
  it('treats a re-proposed project with a known name as the same project', async () => {
    const tabs = Array.from({ length: 4 }, (_, i) => t('A', `Alpha ${i}`, `https://s.com/${i}`));
    let n = 0;
    const client: ModelClient = {
      label: 'fake',
      maxBatch: 2,
      sendsOffDevice: false,
      async complete() {
        n++;
        return JSON.stringify({ projects: [{ id: 'new-1', name: n === 1 ? 'Alpha' : ' alpha ', color: 'blue' }], tabs: [[0, 'new-1', 0.9], [1, 'new-1', 0.9]] });
      },
    };
    const r = await modelArm('fake', client, tabs, { template: '', threshold: 0.6, domainOnly: false });
    expect(new Set(r.prediction).size).toBe(1);
    expect(r.metrics.fragmentation).toBe(0);
  });
});
