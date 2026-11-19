// Runtime configuration. Values are injected at build time (see build.mjs) from environment variables:
//   BEBIG_SUPABASE_URL, BEBIG_SUPABASE_ANON_KEY  — when unset, the app runs fully on-device ("local mode").
declare const __BEBIG_CONFIG__: { supabaseUrl: string; supabaseAnonKey: string; version: string };
export const config = typeof __BEBIG_CONFIG__ !== 'undefined' ? __BEBIG_CONFIG__ : { supabaseUrl: '', supabaseAnonKey: '', version: 'dev' };
