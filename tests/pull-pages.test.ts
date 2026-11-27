// Paged sync pulls (QA H2): one request returns at most Max rows (1000), so a burst of changes must still arrive in full.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllPages, pageQuery, PAGE, MAX_PAGES, OVERLAP_MS } from '../src/lib/pull-pages.ts';

type Row = { feed_id: string; server_updated_at: string };
const MAX_ROWS = 1000;

/** A tiny stand-in for PostgREST: understands the filters pull-pages sends, orders by (time, id), caps at MAX_ROWS. */
function fakeServer(all: Row[]) {
  const calls: string[] = [];
  const get = async (q: string) => {
    calls.push(q);
    const params = new URLSearchParams(q.slice(q.indexOf('?') + 1));
    let rows = [...all];
    const gt = params.get('server_updated_at');
    if (gt) { const t = gt.replace(/^gt\./, ''); rows = rows.filter(r => new Date(r.server_updated_at) > new Date(t)); }
    const or = params.get('or');
    if (or) {
      const m = or.match(/^\(server_updated_at\.gt\."([^"]+)",and\(server_updated_at\.eq\."([^"]+)",feed_id\.gt\."([^"]+)"\)\)$/);
      assert.ok(m, 'keyset filter has the expected shape: ' + or);
      const [, ts, , id] = m!; const t = new Date(ts).getTime();
      rows = rows.filter(r => { const rt = new Date(r.server_updated_at).getTime(); return rt > t || (rt === t && r.feed_id > id); });
    }
    assert.equal(params.get('order'), 'server_updated_at.asc,feed_id.asc');
    rows.sort((a, b) => new Date(a.server_updated_at).getTime() - new Date(b.server_updated_at).getTime() || (a.feed_id < b.feed_id ? -1 : 1));
    return rows.slice(0, Math.min(Number(params.get('limit')), MAX_ROWS));
  };
  return { get, calls };
}
const id = (i: number) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
const at = (base: string, ms: number) => new Date(new Date(base).getTime() + ms).toISOString();

test('a burst of 2,500 rows with the same time all arrive (the old pull returned the same 1,000 every time)', async () => {
  const ts = '2026-11-27T08:00:00.000Z';
  const all = Array.from({ length: 2500 }, (_, i) => ({ feed_id: id(i), server_updated_at: ts }));
  const s = fakeServer(all);
  const r = await fetchAllPages(s.get, 'feeding_entries', 'feed_id', ts);
  assert.equal(r.complete, true);
  assert.equal(new Set(r.rows.map(x => x.feed_id)).size, 2500, 'every row once');
  assert.equal(r.rows.length, 2500, 'no row twice');
  assert.equal(s.calls.length, 3);
});

test('rows spread over time arrive in order, and an exact multiple of a page asks once more to be sure', async () => {
  const base = '2026-11-27T07:00:00.000Z';
  const all = Array.from({ length: 2000 }, (_, i) => ({ feed_id: id(i), server_updated_at: at(base, Math.floor(i / 3) * 1000) }));
  const s = fakeServer(all);
  const r = await fetchAllPages(s.get, 'feeding_entries', 'feed_id', undefined);
  assert.equal(r.complete, true);
  assert.deepEqual(r.rows.map(x => x.feed_id), all.map(x => x.feed_id));
  assert.equal(s.calls.length, 3, '1000 + 1000 + an empty last page');
});

test('the first page still starts 5 minutes before the cursor, so late commits are not missed', async () => {
  const cursor = '2026-11-27T08:00:00.000Z';
  const late = { feed_id: id(1), server_updated_at: at(cursor, -2 * 60000) }; // committed after this phone's last pull
  const old = { feed_id: id(2), server_updated_at: at(cursor, -OVERLAP_MS - 1000) };
  const s = fakeServer([old, late]);
  const r = await fetchAllPages(s.get, 'feeding_entries', 'feed_id', cursor);
  assert.deepEqual(r.rows.map(x => x.feed_id), [late.feed_id]);
});

test('a very large backlog stops after MAX_PAGES and says it is not complete', async () => {
  const ts = '2026-11-27T08:00:00.000Z';
  const all = Array.from({ length: PAGE * MAX_PAGES + 10 }, (_, i) => ({ feed_id: id(i), server_updated_at: ts }));
  const s = fakeServer(all);
  const r = await fetchAllPages(s.get, 'feeding_entries', 'feed_id', undefined);
  assert.equal(r.complete, false);
  assert.equal(r.rows.length, PAGE * MAX_PAGES);
});

test('timestamps with microseconds and a +00:00 offset are quoted and survive the URL', () => {
  const q = pageQuery('feeding_entries', 'feed_id', undefined, { feed_id: id(7), server_updated_at: '2026-11-27T08:00:00.123456+00:00' });
  const or = new URLSearchParams(q.slice(q.indexOf('?') + 1)).get('or')!;
  assert.equal(or, `(server_updated_at.gt."2026-11-27T08:00:00.123456+00:00",and(server_updated_at.eq."2026-11-27T08:00:00.123456+00:00",feed_id.gt."${id(7)}"))`);
  assert.ok(PAGE <= MAX_ROWS, 'a page must not be bigger than the project Max rows');
});
