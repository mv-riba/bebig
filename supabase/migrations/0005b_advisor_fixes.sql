-- 0005b: Security Advisor follow-up to 0005 (22 Nov 2026). Run after 0005, before 0006.
-- Changes permissions and settings only; no data is touched.

set local lock_timeout = '10s';

-- Fixed search_path on trigger functions (advisor: function_search_path_mutable)
alter function public.touch_server_updated_at() set search_path = public;
alter function public.check_extra_baby() set search_path = public;
alter function public.protect_server_columns() set search_path = public;
alter function public.protect_access_update() set search_path = public;
alter function public.protect_profile() set search_path = public;

-- Trigger functions are never called through the API. Triggers keep firing without EXECUTE.
revoke execute on function public.audit_access(), public.handle_new_baby(), public.handle_new_user(),
  public.handle_user_email_change() from public, anon, authenticated;

-- RLS helpers: signed-in users only (anon has no table access, so its policies never call them)
revoke execute on function public.is_member(uuid), public.is_owner(uuid) from public, anon;
grant execute on function public.is_member(uuid), public.is_owner(uuid) to authenticated;

-- Supabase's default grants include TRUNCATE (which bypasses RLS), TRIGGER and REFERENCES. The app uses none of them.
revoke truncate, trigger, references on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke truncate, trigger, references on tables from anon, authenticated;
