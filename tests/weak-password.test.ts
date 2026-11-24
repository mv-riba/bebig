// Supabase's weak-password error lists every allowed character; the app shows a short message instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map<string, string>();
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
Object.assign(globalThis as any, { localStorage: storage, sessionStorage: { ...storage }, BroadcastChannel: undefined,
  window: { addEventListener() {} }, document: { addEventListener() {} } });
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
(globalThis as any).__BEBIG_CONFIG__ = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'k', version: 't' };

const { weakPasswordMessage } = await import('../src/lib/supabase.ts');

test('character rule gives a short message', () => {
  const m = weakPasswordMessage({ error_code: 'weak_password', msg: 'Password should contain at least one character of each: abcdef...', weak_password: { reasons: ['characters'] } });
  assert.match(m!, /at least 8 characters, include upper and lower case letters, a number, and a symbol/);
  assert.doesNotMatch(m!, /abcdef/);
});
test('leaked and length reasons', () => {
  assert.match(weakPasswordMessage({ error_code: 'weak_password', weak_password: { reasons: ['pwned'] } })!, /data leak/);
  assert.match(weakPasswordMessage({ error_code: 'weak_password', weak_password: { reasons: ['length'] } })!, /at least 8/);
});
test('other errors are left alone', () => {
  assert.equal(weakPasswordMessage({ error_code: 'invalid_credentials' }), null);
});
