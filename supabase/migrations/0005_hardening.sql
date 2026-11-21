-- 0005: security hardening (audit of 21 Nov 2026 — see "Bebig security audit & Play Store launch plan").
-- Safe to run once on the live project after 0001–0004. Every change keeps existing data.
--
--  H1  created_by / created_at can no longer be changed through the API (stops a caregiver making
--      themselves "creator" of a baby and keeping read access after being removed).
--  H2  Deleting an account works for caregivers: their entries stay with the baby, attribution becomes
--      empty ("Former caregiver"); invitations and audit entries holding their email are removed/scrubbed.
--  L1  Owners can only revoke an invitation; they can't attach someone's account or accept on their behalf.
--  L3  profiles.email is kept in step with the verified auth email and can't be edited directly.
--  L4  Audit log retention: 12 months (scheduled automatically when pg_cron is enabled).
--  M1  Server-side AI consent + a daily per-user request quota for the `assistant` function.
--  M3  Baby photos must be small inline images (no external URLs that could track viewers).

-- ---------- H1 / L2: server-maintained columns ----------
-- The API roles (anon, authenticated) can't change these; internal operations (foreign-key actions,
-- security definer functions, the dashboard) run as the table owner and are unaffected.
create or replace function public.protect_server_columns() returns trigger language plpgsql as $$
begin
  if current_user in ('anon', 'authenticated') then
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['baby_profiles','feeding_entries','poo_entries','sleep_entries','growth_measurements','extra_trackers','extra_entries'] loop
    execute format('drop trigger if exists %1$s_protect on public.%1$s', t);
    execute format('create trigger %1$s_protect before update on public.%1$s for each row execute function public.protect_server_columns()', t);
  end loop;
end $$;

-- ---------- H2: deleting a user keeps the baby's history ----------
-- created_by / updated_by / invited_by become nullable and are cleared when that user is deleted.
do $$ declare r record; begin
  for r in
    select c.conrelid::regclass as tbl, c.conname, a.attname
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.contype = 'f' and c.confrelid = 'auth.users'::regclass and c.connamespace = 'public'::regnamespace
      and a.attname in ('created_by', 'updated_by', 'invited_by')
  loop
    execute format('alter table %s alter column %I drop not null', r.tbl, r.attname);
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
    execute format('alter table %s add constraint %I foreign key (%I) references auth.users(id) on delete set null', r.tbl, r.conname, r.attname);
  end loop;
end $$;

-- ---------- L1: owners may only revoke ----------
create or replace function public.protect_access_update() returns trigger language plpgsql as $$
begin
  if current_user in ('anon', 'authenticated') then
    -- identity of an invitation is fixed; accepting/declining only happens through respond_invitation()
    new.baby_id := old.baby_id;
    new.user_id := old.user_id;
    new.invited_email := old.invited_email;
    new.invited_by := old.invited_by;
    new.created_at := old.created_at;
    if new.invitation_status is distinct from old.invitation_status and new.invitation_status <> 'revoked' then
      new.invitation_status := old.invitation_status;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists access_protect on public.baby_access;
create trigger access_protect before update on public.baby_access for each row execute function public.protect_access_update();

-- ---------- M1 + L3: profiles ----------
alter table public.profiles add column if not exists ai_consent_at timestamptz;

create or replace function public.protect_profile() returns trigger language plpgsql as $$
begin
  if current_user in ('anon', 'authenticated') then
    new.user_id := old.user_id;
    new.email := old.email;
    new.created_at := old.created_at;
    -- consent time is recorded by the server, not taken from the device
    if new.ai_consent_at is not null and old.ai_consent_at is null then new.ai_consent_at := now();
    elsif new.ai_consent_at is not null then new.ai_consent_at := old.ai_consent_at; end if;
  end if;
  return new;
end $$;
drop trigger if exists profiles_protect on public.profiles;
create trigger profiles_protect before update on public.profiles for each row execute function public.protect_profile();

create or replace function public.handle_user_email_change() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set email = lower(new.email), updated_at = now() where user_id = new.id;
  return new;
end $$;
drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row when (new.email is distinct from old.email and new.email is not null) execute function public.handle_user_email_change();

-- daily AI quota (server-side only; no API access to the table)
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  requests integer not null default 0,
  primary key (user_id, day)
);
alter table public.ai_usage enable row level security; -- no policies: only security definer functions touch it

-- true when the caller has consented to AI phrasing and is within today's quota (counts the request)
create or replace function public.use_ai_quota() returns boolean language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null then return false; end if;
  if not exists (select 1 from profiles where user_id = auth.uid() and ai_consent_at is not null) then return false; end if;
  insert into ai_usage (user_id, day, requests) values (auth.uid(), current_date, 1)
  on conflict (user_id, day) do update set requests = ai_usage.requests + 1
  returning requests into n;
  return n <= 60;
end $$;

-- ---------- M3: photos ----------
alter table public.baby_profiles drop constraint if exists baby_photo_inline;
alter table public.baby_profiles add constraint baby_photo_inline check (
  photograph_url is null or (photograph_url ~ '^data:image/(jpeg|png|webp);base64,' and length(photograph_url) <= 400000)
) not valid;

-- ---------- H2 + L4: account deletion & audit log ----------
create or replace function public.delete_my_account() returns void language plpgsql security definer set search_path = public, auth as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(auth.jwt()->>'email');
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  -- babies this user owns are deleted with all their records (the app warns about this)
  delete from baby_profiles where baby_id in (
    select baby_id from baby_access where user_id = v_uid and role = 'owner' and invitation_status = 'accepted');
  -- memberships and every invitation addressed to this email
  delete from baby_access where user_id = v_uid or invited_email = v_email;
  -- audit entries: keep the event, drop who it was
  update audit_log set actor = null, detail = coalesce(detail, '{}'::jsonb) - 'email'
    where actor = v_uid or detail->>'email' = v_email;
  -- entries they logged on other babies stay, with created_by/updated_by cleared by the foreign keys
  delete from auth.users where id = v_uid;
end $$;

create or replace function public.purge_old_audit_log() returns void language sql security definer set search_path = public as $$
  delete from audit_log where at < now() - interval '12 months' $$;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('bebig-purge-audit-log', '17 3 * * *', 'select public.purge_old_audit_log()');
  end if;
end $$;

-- ---------- function privileges ----------
-- Supabase grants new functions to anon by default; only signed-in users may call these.
revoke all on function public.use_ai_quota(), public.delete_my_account(), public.respond_invitation(uuid, boolean), public.purge_old_audit_log() from public, anon;
revoke all on function public.purge_old_audit_log() from authenticated;
grant execute on function public.use_ai_quota(), public.delete_my_account(), public.respond_invitation(uuid, boolean) to authenticated;
