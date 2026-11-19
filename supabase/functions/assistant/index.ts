// Supabase Edge Function (Deno): optional LLM phrasing for the assistant.
// The client sends the question plus the answer already computed deterministically from records.
// The model may only rephrase that verified answer — it never receives raw records and never adds numbers.
// Requires: ANTHROPIC_API_KEY secret; caller must be signed in and have ai_consent enabled in the app.
// Deploy: supabase functions deploy assistant
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SYSTEM = `You rephrase answers for Bebig, a newborn routine-tracking app.
Rules: Use ONLY the facts in VERIFIED_ANSWER. Do not add, change or estimate any number, time or date.
Keep "Estimate" wording for predictions. Never give medical advice, diagnoses, feeding amounts, or sleep-training advice;
if the question is medical, say you can't assess health and suggest contacting a healthcare professional.
Be warm, brief (max 3 sentences), plain language.`;

Deno.serve(async req => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey' };
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401, headers: cors });
  const { baby_id, question, verified_answer, kind } = await req.json();
  // membership check through RLS: the select only succeeds for authorised members
  const { data: baby } = await supabase.from('baby_profiles').select('baby_id').eq('baby_id', baby_id).maybeSingle();
  if (!baby) return new Response('Forbidden', { status: 403, headers: cors });
  if (kind === 'safety') return Response.json({ content: verified_answer }, { headers: cors }); // safety copy is never rephrased

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 300, system: SYSTEM,
      messages: [{ role: 'user', content: `QUESTION: ${String(question).slice(0, 500)}\nVERIFIED_ANSWER: ${String(verified_answer).slice(0, 2000)}` }] }),
  });
  if (!r.ok) return Response.json({ content: verified_answer }, { headers: cors }); // fall back to the verified answer
  const j = await r.json();
  return Response.json({ content: j.content?.[0]?.text ?? verified_answer }, { headers: cors });
});
