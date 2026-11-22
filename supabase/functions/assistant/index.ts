// Supabase Edge Function (Deno): optional LLM phrasing for the assistant.
// The client sends the question plus the answer already computed deterministically from records.
// The model may only rephrase that verified answer — it never receives raw records and never adds numbers.
// Requires: ANTHROPIC_API_KEY secret. The caller must be signed in, a member of the baby's profile, have consented
// on the server (profiles.ai_consent_at, migration 0005), and the baby must have Bebig Plus with today's quota left
// (use_ai_quota(baby), migration 0006 — free plans get the verified answer unchanged).
// Anything that isn't allowed gets the verified answer back unchanged, so the app never breaks.
// Deploy: supabase functions deploy assistant
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'; // pinned: a new upstream release can't change this function silently

const ALLOWED_ORIGINS = ['https://bebig.app', 'http://localhost:5173'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SYSTEM = `You rephrase answers for Bebig, a newborn routine-tracking app.
Rules: Use ONLY the facts in VERIFIED_ANSWER. Do not add, change or estimate any number, time or date.
Keep "Estimate" wording for predictions. Never give medical advice, diagnoses, feeding amounts, or sleep-training advice;
if the question is medical, say you can't assess health and suggest contacting a healthcare professional.
Be warm, brief (max 3 sentences), plain language.`;

Deno.serve(async req => {
  const origin = req.headers.get('Origin') ?? '';
  const cors = { 'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0], 'Access-Control-Allow-Headers': 'authorization, content-type, apikey', Vary: 'Origin' };
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401, headers: cors });
  let body: any;
  try { body = await req.json(); } catch { return new Response('Bad request', { status: 400, headers: cors }); }
  const { baby_id, question, verified_answer, kind } = body ?? {};
  if (typeof baby_id !== 'string' || !UUID.test(baby_id) || typeof question !== 'string' || typeof verified_answer !== 'string')
    return new Response('Bad request', { status: 400, headers: cors });
  // membership check: is_member() also covers paused caregivers (baby_profiles' select would let a creator through)
  const { data: member } = await supabase.rpc('is_member', { b: baby_id });
  if (member !== true) return new Response('Forbidden', { status: 403, headers: cors });
  if (kind === 'safety') return Response.json({ content: verified_answer }, { headers: cors }); // safety copy is never rephrased
  // server-side consent + Plus plan + daily quota (counts this request)
  const { data: allowed } = await supabase.rpc('use_ai_quota', { b: baby_id });
  if (allowed !== true) return Response.json({ content: verified_answer }, { headers: cors });

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(7000), // the app gives up after 8 s and shows the verified answer
    headers: { 'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 300, system: SYSTEM,
      messages: [{ role: 'user', content: `QUESTION: ${question.slice(0, 500)}\nVERIFIED_ANSWER: ${verified_answer.slice(0, 2000)}` }] }),
  }).catch(() => null);
  if (!r?.ok) return Response.json({ content: verified_answer }, { headers: cors }); // fall back to the verified answer
  const j = await r.json().catch(() => null);
  const text = j?.content?.[0]?.text;
  return Response.json({ content: typeof text === 'string' && text.trim() ? text : verified_answer }, { headers: cors });
});
