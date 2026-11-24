# Bebig

Newborn routine & development tracker — mobile-first progressive web app (iOS, Android, desktop browsers).

**Record effortlessly. Understand patterns. Plan with confidence.**

## Run locally

```bash
npm install
npm run dev        # http://localhost:5173 (watch + live rebuild)
npm test           # unit tests: time zones/DST, daily totals, WHO percentiles, insights, assistant safety
npm run build      # production bundle in dist/
```

Without Supabase settings the app runs in **local mode**: accounts and records live in the browser on that device. Open a second tab, sign up as another person and accept an invitation to try shared access — changes appear in the other tab instantly. On the sign-up screen, “Explore with sample data” creates a demo baby with 10 days of records, so you can see insights and predictions straight away.

## Architecture

| Layer | Choice | Notes |
|---|---|---|
| UI | React 19 + TypeScript, bundled by esbuild | Installable PWA, service worker for offline use |
| Data on device | Local-first store (`src/lib/store.ts`) | Instant saves, outbox for offline, client UUIDs make retries safe (no duplicate entries) |
| Backend | Supabase (Postgres + Auth), dependency-free client (`src/lib/supabase.ts`) | Row-level security on every table, server-clock sync cursors, last-write-wins per row (sleep-timer taps are server actions: first Stop wins) |
| Calculations | `calc.ts`, `insights.ts`, `growth.ts` | Pure, deterministic, unit-tested. The assistant explains these numbers; it never makes them up |
| Growth | WHO Child Growth Standards LMS tables 0–24 months (`src/data/who-lms.json`) | Weekly tables to 13 weeks, monthly after; corrected age below 37 weeks; ±2 SD values verified against WHO’s published tables in tests |
| AI phrasing (optional) | Supabase Edge Function `assistant` | Only rephrases a verified answer; off unless the user consents; safety replies are never rephrased |

Times are stored in UTC; the baby’s IANA time zone controls display and daily totals (DST-safe; sleeps crossing midnight are split between days).

## Going live (GitHub Pages + your domain + Supabase)

1. **Supabase**: create a project (choose an EU region), then run the files in `supabase/migrations/` in order, 0001 → 0008 (SQL editor or `supabase db push`). `supabase/tests/` has a local Postgres check of the security rules (`psql -f supabase-stub.sql` then the migrations, then `0005_hardening.test.sql`; after 0006, `0006_entitlements.test.sql`; after 0007, `0007_limits.test.sql`; after 0008, `0008_sleep_actions.test.sql` and `0008_timers.test.sql` — each on a fresh database). In Auth → URL configuration, set the site URL to your domain.
2. **Config**: `bebig.config.json` holds the Supabase URL, the public anon key and the custom domain (env vars `BEBIG_SUPABASE_URL` / `BEBIG_SUPABASE_ANON_KEY` override). In GitHub *Settings → Pages* choose “GitHub Actions” and set the custom domain.
3. **DNS**: for a subdomain add a `CNAME` record → `<github-user>.github.io`. For an apex domain add `A` records to GitHub Pages’ IPs. Then tick “Enforce HTTPS”.
4. Optional AI phrasing: `supabase functions deploy assistant` and `supabase secrets set ANTHROPIC_API_KEY=…`.

Every push to `main` runs the tests, builds and deploys.

## Bebig Plus (freemium)

Logging, partner sync, health notices, growth charts, summaries, 7-day trends, history and export are always free. Plus (one plan per family: it covers every baby the owner's account owns, and everyone who cares for them) adds predictions, AI-phrased answers, more caregivers and, later, long-range trends and a doctor report.

- Rules: `src/lib/plans.ts` (tested in `tests/plans.test.ts`); UI: `src/ui/plus.tsx`; server: `supabase/migrations/0006_entitlements.sql`.
- **Early access:** Plus is free for everyone until `app_settings.early_access_until` (set to 1 January 2027 00:00 Helsinki, i.e. `2026-12-31T22:00:00Z`; the 0006 seed was 1 April 2027). Change it in the SQL editor; `earlyAccessUntil` in `bebig.config.json` is only the offline/local-mode fallback.
- **Trial:** 14 days, once per family, unlocked after 10 days of logging; no payment details.
- **Caregivers:** the free plan includes the owner + one caregiver (the "free slot", first to accept unless the owner picks someone else). Others need Plus; when Plus/trial/early access ends they're **paused, not removed** (`is_member()` lets them back in automatically when Plus returns).
- **Server enforcement:** AI phrasing needs Plus (`use_ai_quota(baby)`), invitations beyond the plan's caregiver limit are refused, and paused caregivers can't read the profile. Entitlement rows are written only by server code — Play Billing verification will add them (`source = 'play'`).
- Deploy order: run 0006 → redeploy the `assistant` function → deploy the app. Before 0006 is run the app keeps working and treats everyone as early access.

## Open items before public release

- Clinical review of the stool-colour notices (`src/screens/LogPoo.tsx → healthNotice`) — required by the PRD.
- GDPR: lawful basis, DPIA, privacy policy, retention policy, DPAs with Supabase/AI provider.
- Invitation emails: invitations work in-app (invitee signs in with the invited email); sending an email needs an Edge Function + SMTP.
- Baby photos are stored as a small re-encoded JPEG on the profile row; move to Supabase Storage (private bucket) for scale.
- Cross-device sync: a sleep started, paused or stopped on one phone shows on the others within seconds (Supabase Realtime triggers a sync); everything else syncs every 15 s and on focus.
- Sleep timer taps are applied on the server in order (migration 0008): when two caregivers stop the same sleep, the first Stop sets the end time and the other is told who stopped it (with a one-tap "Use my time"); a phone that hadn't seen the stop can't reopen it; two timers started at once become one.
- Breastfeeding and extras timers are shared too (migration 0008, table `running_timers`): every caregiver sees a running timer (Home shows a running feed timer on the Feed card) and can pause, switch side, stop or discard it. The same rules apply: the first Stop saves the entry and a second Stop doesn't save it twice.
- Breastfeeding timer state is per device (the sleep timer syncs across devices).
- Native iOS/Android store apps: the PWA installs to the home screen today; Expo/React Native can reuse `src/lib/*` unchanged.
