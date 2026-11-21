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
| Backend | Supabase (Postgres + Auth), dependency-free client (`src/lib/supabase.ts`) | Row-level security on every table, server-clock sync cursors, last-write-wins per row |
| Calculations | `calc.ts`, `insights.ts`, `growth.ts` | Pure, deterministic, unit-tested. The assistant explains these numbers; it never makes them up |
| Growth | WHO Child Growth Standards LMS tables 0–24 months (`src/data/who-lms.json`) | Weekly tables to 13 weeks, monthly after; corrected age below 37 weeks; ±2 SD values verified against WHO’s published tables in tests |
| AI phrasing (optional) | Supabase Edge Function `assistant` | Only rephrases a verified answer; off unless the user consents; safety replies are never rephrased |

Times are stored in UTC; the baby’s IANA time zone controls display and daily totals (DST-safe; sleeps crossing midnight are split between days).

## Going live (GitHub Pages + your domain + Supabase)

1. **Supabase**: create a project (choose an EU region), then run the files in `supabase/migrations/` in order, 0001 → 0005 (SQL editor or `supabase db push`). `supabase/tests/` has a local Postgres check of the security rules (`psql -f supabase-stub.sql` then the migrations, then `0005_hardening.test.sql`). In Auth → URL configuration, set the site URL to your domain.
2. **Config**: `bebig.config.json` holds the Supabase URL, the public anon key and the custom domain (env vars `BEBIG_SUPABASE_URL` / `BEBIG_SUPABASE_ANON_KEY` override). In GitHub *Settings → Pages* choose “GitHub Actions” and set the custom domain.
3. **DNS**: for a subdomain add a `CNAME` record → `<github-user>.github.io`. For an apex domain add `A` records to GitHub Pages’ IPs. Then tick “Enforce HTTPS”.
4. Optional AI phrasing: `supabase functions deploy assistant` and `supabase secrets set ANTHROPIC_API_KEY=…`.

Every push to `main` runs the tests, builds and deploys.

## Open items before public release

- Clinical review of the stool-colour notices (`src/screens/LogPoo.tsx → healthNotice`) — required by the PRD.
- GDPR: lawful basis, DPIA, privacy policy, retention policy, DPAs with Supabase/AI provider.
- Invitation emails: invitations work in-app (invitee signs in with the invited email); sending an email needs an Edge Function + SMTP.
- Baby photos are stored as a small re-encoded JPEG on the profile row; move to Supabase Storage (private bucket) for scale.
- Cross-device sync is near-real-time (15 s polling + on focus); Supabase Realtime websockets are enabled in the schema for an upgrade.
- Breastfeeding timer state is per device (the sleep timer syncs across devices).
- Native iOS/Android store apps: the PWA installs to the home screen today; Expo/React Native can reuse `src/lib/*` unchanged.
