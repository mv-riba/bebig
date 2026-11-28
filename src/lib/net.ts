// fetch with a time limit for the server's answer.
//
// Why: after the phone wakes up or changes network, Chrome can reuse a connection that is quietly dead. A request sent
// on it gets no answer and no error, sometimes for minutes. Sync runs one at a time, so every later sync waited behind
// it and Home showed "Couldn't update" (seen on 28 Nov 2026: realtime reconnected straight away, but REST requests
// only came through 10–70 s later). With a limit, the stuck request fails, and the next sync starts on a fresh try.
//
// The limit covers only the wait for the response headers. Once the server has started answering, the connection is
// clearly alive, so a large first sync on a slow network is never cut off half-way through the body.
export const HEADERS_TIMEOUT_MS = 10_000;

export class RequestTimeout extends Error {
  timeout = true;
  constructor(url: string, ms: number) { super(`No answer from the server within ${Math.round(ms / 1000)} s`); this.name = 'RequestTimeout'; void url; }
}
export const isTimeout = (e: any) => !!e?.timeout;

export async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = HEADERS_TIMEOUT_MS, f: typeof fetch = fetch): Promise<Response> {
  const ctrl = new AbortController();
  const outer = init.signal;
  if (outer) { if (outer.aborted) ctrl.abort(); else outer.addEventListener('abort', () => ctrl.abort(), { once: true }); }
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms);
  try {
    return await f(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (timedOut) throw new RequestTimeout(url, ms);
    throw e;
  } finally {
    clearTimeout(t); // headers are in (or it failed): the body may take as long as it needs
  }
}
