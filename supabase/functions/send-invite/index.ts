// Supabase Edge Function (Deno): emails a caregiver invitation through Resend.
// The app first saves the invitation (a pending baby_access row, synced like any other change), then calls this
// with that row's access_id. The email always goes to the address on the row, never to one supplied by the caller,
// and only the profile's owner can trigger it.
// Ownership, limits (1 email per invitation per 24 h, 20 per owner per 24 h) and the audit record live in the database
// (claim_invite_email, migration 0011), called as the signed-in user: this function never uses the service-role key.
// Requires: migration 0011, and the RESEND_API_KEY secret (Resend → API Keys, "Sending access", domain bebig.app).
// SUPABASE_URL and SUPABASE_ANON_KEY are provided by Supabase automatically.
// Deploy: supabase functions deploy send-invite   (or Dashboard → Edge Functions → Deploy a new function)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'; // pinned, as in the assistant function

const ALLOWED_ORIGINS = ['https://bebig.app', 'http://localhost:5173'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const firstName = (s: string) => s.trim().split(/\s+/)[0] || s.trim();

function emailHtml(inviter: string, baby: string, to: string) {
  const i = esc(inviter), b = esc(baby), t = esc(to);
  return `<div style="font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background:#F8F5FB; padding:32px 16px; color:#2E2A3B">
  <div style="max-width:480px; margin:0 auto; background:#FFFFFF; border-radius:20px; padding:32px 28px; border:1px solid #EDE8F4">
    <h1 style="margin:0 0 12px; font-size:22px; color:#2E2A3B">You’re invited to Bebig</h1>
    <p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#4C475A"><strong>${i}</strong> has invited you to help keep track of ${b}’s day on Bebig, so everyone who looks after ${b} can log feeds, sleep and nappies and see what the others logged.</p>
    <p style="margin:0 0 24px; font-size:15px; line-height:1.5; color:#4C475A">To accept, sign in or create a free account with this email address: <strong>${t}</strong>. The invitation is waiting for you there.</p>
    <p style="margin:0 0 24px"><a href="https://bebig.app/" style="display:inline-block; background:#6A5BAE; color:#FFFFFF; text-decoration:none; font-weight:700; padding:13px 26px; border-radius:999px; font-size:15px">Open Bebig</a></p>
    <p style="margin:0; font-size:12px; color:#6B6579">Not expecting this? You can ignore this email. Nothing happens unless you create an account and accept.</p>
  </div>
  <p style="text-align:center; font-size:12px; color:#6B6579; margin:16px 0 0">Bebig · bebig.app</p>
</div>`;
}
const emailText = (inviter: string, baby: string, to: string) =>
  `${inviter} has invited you to help keep track of ${baby}'s day on Bebig.\n\nTo accept, sign in or create a free account at https://bebig.app/ with this email address: ${to}. The invitation is waiting for you there.\n\nNot expecting this? You can ignore this email.`;

Deno.serve(async req => {
  const origin = req.headers.get('Origin') ?? '';
  const cors = { 'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0], 'Access-Control-Allow-Headers': 'authorization, content-type, apikey', Vary: 'Origin' };
  const reply = (status: string, code = 200) => Response.json({ status }, { status: code, headers: cors });
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return reply('method_not_allowed', 405);

  const asUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return reply('unauthorized', 401);
  let body: any;
  try { body = await req.json(); } catch { return reply('bad_request', 400); }
  const access_id = body?.access_id;
  if (typeof access_id !== 'string' || !UUID.test(access_id)) return reply('bad_request', 400);

  // ownership, pending status and limits are checked (and the send recorded) by the database: migration 0011
  const { data, error } = await asUser.rpc('claim_invite_email', { p_access_id: access_id });
  const claim = Array.isArray(data) ? data[0] : data;
  if (error || !claim) return reply('error', 500);
  const CODES: Record<string, number> = { not_found: 404, forbidden: 403, not_pending: 409, already_sent: 429, daily_limit: 429 };
  if (claim.status !== 'ok') return reply(claim.status, CODES[claim.status] ?? 400);
  const inviter = (claim.inviter_name || 'Someone').slice(0, 80);
  const babyName = firstName(claim.baby_name || 'your baby').slice(0, 40);
  const to: string = claim.invited_email;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Bebig <no-reply@bebig.app>', to: [to], reply_to: user.email ? [user.email] : undefined,
      subject: `${inviter} invited you to Bebig`,
      html: emailHtml(inviter, babyName, to), text: emailText(inviter, babyName, to),
    }),
  }).catch(() => null);
  if (!r?.ok) {
    console.error('resend', r?.status, await r?.text().catch(() => ''));
    await asUser.rpc('release_invite_email', { p_access_id: access_id }); // let the owner try again
    return reply('send_failed', 502);
  }
  return reply('sent');
});
