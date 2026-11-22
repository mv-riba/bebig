// Runtime configuration. Values are injected at build time (see build.mjs) from environment variables:
//   BEBIG_SUPABASE_URL, BEBIG_SUPABASE_ANON_KEY  — when unset, the app runs fully on-device ("local mode").
//   earlyAccessUntil (bebig.config.json) — Plus is free for everyone until then. With cloud sync the server's
//   app_settings.early_access_until decides; this value is only the offline/local-mode fallback.
declare const __BEBIG_CONFIG__: { supabaseUrl: string; supabaseAnonKey: string; version: string; earlyAccessUntil?: string };
export const config = typeof __BEBIG_CONFIG__ !== 'undefined' ? __BEBIG_CONFIG__ : { supabaseUrl: '', supabaseAnonKey: '', version: 'dev', earlyAccessUntil: '2027-03-31T21:00:00Z' };
