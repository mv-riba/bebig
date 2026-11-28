import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithTimeout, isTimeout } from '../src/lib/net.ts';

// A fetch that never answers until it's aborted, like a request sent on a dead connection.
const hangingFetch = ((_url: string, init: RequestInit = {}) => new Promise((_res, rej) => {
  init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
})) as unknown as typeof fetch;

test('a request with no answer fails after the time limit, as a timeout', async () => {
  const t0 = Date.now();
  await assert.rejects(fetchWithTimeout('https://x/rest/v1/feeds', {}, 50, hangingFetch), (e: any) => isTimeout(e) && /within/.test(e.message));
  assert.ok(Date.now() - t0 < 1000);
});

test('an answer in time is returned, and a slow body is not cut off afterwards', async () => {
  let signal: AbortSignal | undefined;
  const ok = ((_u: string, init: RequestInit = {}) => { signal = init.signal ?? undefined; return Promise.resolve(new Response('[]')); }) as unknown as typeof fetch;
  const r = await fetchWithTimeout('https://x/rest/v1/feeds', {}, 50, ok);
  await new Promise(res => setTimeout(res, 100)); // past the limit
  assert.equal(signal?.aborted, false);
  assert.equal(await r.text(), '[]');
});

test('other network errors pass through unchanged (not reported as timeouts)', async () => {
  const offline = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
  await assert.rejects(fetchWithTimeout('https://x', {}, 50, offline), (e: any) => e instanceof TypeError && !isTimeout(e));
});

test("the caller's own abort still works and isn't reported as a timeout", async () => {
  const c = new AbortController();
  const p = fetchWithTimeout('https://x', { signal: c.signal }, 5000, hangingFetch);
  c.abort();
  await assert.rejects(p, (e: any) => !isTimeout(e));
});
