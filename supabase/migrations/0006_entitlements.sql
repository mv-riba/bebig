-- 0006: Bebig Plus entitlements (freemium foundations — see "Bebig monetisation plan").
-- Safe to run once after 0001–0005. No existing data changes.
--
-- Model
--   * Plus belongs to the family: the account that owns the baby profiles. One subscription covers every baby that
--     account owns, and everyone who cares for those babies.
--   * Rows in `entitlements` are written only by the server: security definer functions here (trials) and, later,
--     the Play Billing verification Edge Function (service role). Members can read their baby's rows.
--   * Early access: while app_settings.early_access_until is in the future, every baby has Plus.
--     Change the date in the dashboard (SQL: update app_settings set value = '"2027-04-30T00:00:00Z"' where key = 'early_access_until').
--   * Free trial: 14 days, once per family (owner account), only after at least 10 different days with logged activity (checked here).
--   * AI phrasing is Plus-only and the daily quota is enforced here (the `assistant` function calls use_ai_quota(baby)).
--   * Free families: owner + 1 caregiver (the "free slot"). Plus (incl. trial and early access): up to 6 caregivers.
--     When Plus ends, extra caregivers are PAUSED, not removed: is_member() stops letting them in until Plus returns.
--     Nothing they logged is touched. The owner chooses who keeps the free slot (default: the first to accept).

-- ---------- settings ----------
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
drop policy if exists app_settings_read on public.app_settings;
create policy app_settings_read on public.app_settings for select using (true); -- public, non-sensitive switches
insert into public.app_settings (key, value) values
  ('early_access_until', '"2027-03-31T21:00:00Z"'), -- 1 Apr 2027 00:00 Helsinki
  ('plus_limits', '{"free_caregivers": 1, "plus_caregivers": 6, "free_ai_per_day": 0, "plus_ai_per_day": 60, "trial_days": 14, "trial_min_logged_days": 10}')
on conflict (key) do nothing;

create or replace function public.setting(k text) returns jsonb language sql stable security definer set search_path = public as $$
  select value from app_settings where key = k $$;
create or replace function public.limit_value(k text) returns integer language sql stable security definer set search_path = public as $$
  select (value->>k)::integer from app_settings where key = 'plus_limits' $$;

-- ---------- entitlements ----------
create table if not exists public.entitlements (
  entitlement_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade, -- the family: covers every baby this account owns
  plan text not null default 'plus' check (plan in ('plus')),
  source text not null check (source in ('trial', 'promo', 'play', 'stripe', 'manual')),
  product_id text,                -- e.g. bebig_plus:yearly, bebig_first_year
  status text not null default 'active' check (status in ('active', 'grace', 'cancelled', 'expired', 'refunded')),
  starts_at timestamptz not null default now(),
  expires_at timestamptz,         -- null = no end (lifetime / manual)
  purchase_token text unique,     -- Play purchase token (members can't read this table directly)
  purchased_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists entitlements_owner on public.entitlements (owner_id);

-- the family a baby belongs to = the account that owns the profile
create or replace function public.owner_of(b uuid) returns uuid language sql stable security definer set search_path = public as $$
  select user_id from baby_access where baby_id = b and role = 'owner' and invitation_status = 'accepted' limit 1 $$;
alter table public.entitlements enable row level security; -- no policies: read through plus_status(), written by server code only

-- active = status allows access and now is inside the period ("cancelled" keeps access until it expires, like Play)
create or replace function public.has_plus(b uuid) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((setting('early_access_until') #>> '{}')::timestamptz > now(), false)
      or exists (select 1 from entitlements e where e.owner_id = owner_of(b) and e.status in ('active', 'grace', 'cancelled')
                 and e.starts_at <= now() and (e.expires_at is null or e.expires_at > now())) $$;

-- distinct local days with any logged feed, sleep or poo (soft-deleted entries don't count)
create or replace function public.logged_days(b uuid) returns integer language sql stable security definer set search_path = public as $$
  with tz as (select timezone from baby_profiles where baby_id = b),
  t as (
    select start_datetime as at from feeding_entries where baby_id = b and deleted_at is null
    union all select start_datetime from sleep_entries where baby_id = b and deleted_at is null
    union all select datetime from poo_entries where baby_id = b and deleted_at is null
  )
  select count(distinct (t.at at time zone (select timezone from tz))::date)::integer from t $$;

-- what the app needs to show Plus state; members only
create or replace function public.plus_status(b uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  ea timestamptz := (setting('early_access_until') #>> '{}')::timestamptz;
  cur record;
  trial_used boolean;
  days integer;
begin
  if not is_member(b) then raise exception 'Not a member of this baby profile' using errcode = '42501'; end if;
  select source, product_id, status, expires_at into cur from entitlements e
    where e.owner_id = owner_of(b) and e.status in ('active', 'grace', 'cancelled') and e.starts_at <= now() and (e.expires_at is null or e.expires_at > now())
    order by (e.expires_at is null) desc, e.expires_at desc limit 1;
  trial_used := exists (select 1 from entitlements where owner_id = owner_of(b) and source = 'trial');
  days := logged_days(b);
  return jsonb_build_object(
    'plus', has_plus(b),
    'early_access_until', ea,
    'early_access', coalesce(ea > now(), false),
    'source', cur.source, 'product_id', cur.product_id, 'status', cur.status, 'expires_at', cur.expires_at,
    'trial_used', trial_used,
    'logged_days', days,
    'trial_eligible', not trial_used and cur.source is null and days >= limit_value('trial_min_logged_days'),
    'checked_at', now());
end $$;

-- starts the family's one free trial (any member can start it; it covers all the owner's babies)
create or replace function public.start_plus_trial(b uuid) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not is_member(b) then raise exception 'Not a member of this baby profile' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('trial:' || owner_of(b)::text)); -- two caregivers tapping at once get one trial
  if exists (select 1 from entitlements where owner_id = owner_of(b) and source = 'trial') then raise exception 'The free trial has already been used'; end if;
  if logged_days(b) < limit_value('trial_min_logged_days') then raise exception 'The free trial starts after % days of logging', limit_value('trial_min_logged_days'); end if;
  insert into entitlements (owner_id, source, status, starts_at, expires_at, purchased_by)
  values (owner_of(b), 'trial', 'active', now(), now() + make_interval(days => limit_value('trial_days')), auth.uid());
  return plus_status(b);
end $$;

-- ---------- AI quota: Plus only ----------
-- replaces use_ai_quota() from 0005: the limit now depends on the baby's plan
drop function if exists public.use_ai_quota();
create or replace function public.use_ai_quota(b uuid) returns boolean language plpgsql security definer set search_path = public as $$
declare n integer; lim integer;
begin
  if auth.uid() is null or not is_member(b) then return false; end if;
  if not exists (select 1 from profiles where user_id = auth.uid() and ai_consent_at is not null) then return false; end if;
  lim := case when has_plus(b) then limit_value('plus_ai_per_day') else limit_value('free_ai_per_day') end;
  if coalesce(lim, 0) <= 0 then return false; end if;
  insert into ai_usage (user_id, day, requests) values (auth.uid(), current_date, 1)
  on conflict (user_id, day) do update set requests = ai_usage.requests + 1
  returning requests into n;
  return n <= lim;
end $$;

-- ---------- caregiver limit ----------
-- counts pending + accepted caregivers (not the owner); applies to new invitations only
create or replace function public.check_caregiver_limit() returns trigger language plpgsql security definer set search_path = public as $$
declare n integer; lim integer;
begin
  if new.role <> 'caregiver' or new.invitation_status not in ('pending', 'accepted') then return new; end if;
  select count(*) into n from baby_access where baby_id = new.baby_id and role = 'caregiver' and invitation_status in ('pending', 'accepted');
  lim := case when has_plus(new.baby_id) then limit_value('plus_caregivers') else limit_value('free_caregivers') end;
  if n >= lim then
    raise exception using errcode = 'P0001', message = 'caregiver_limit',
      detail = format('This family can have up to %s caregiver%s on its current plan.', lim, case when lim = 1 then '' else 's' end);
  end if;
  return new;
end $$;
drop trigger if exists access_caregiver_limit on public.baby_access;
create trigger access_caregiver_limit before insert on public.baby_access for each row execute function public.check_caregiver_limit();

-- ---------- free slot & pausing ----------
alter table public.baby_access add column if not exists keeps_free_access boolean not null default false;
create unique index if not exists baby_access_one_free_slot on public.baby_access (baby_id) where keeps_free_access;
-- existing families: the first caregiver who accepted keeps access on the free plan
update public.baby_access a set keeps_free_access = true
where a.role = 'caregiver' and a.invitation_status = 'accepted'
  and a.access_id = (select x.access_id from public.baby_access x where x.baby_id = a.baby_id and x.role = 'caregiver' and x.invitation_status = 'accepted' order by x.created_at, x.access_id limit 1)
  and not exists (select 1 from public.baby_access y where y.baby_id = a.baby_id and y.keeps_free_access);

-- members: owner, the free-slot caregiver, and every other accepted caregiver while the baby has Plus
create or replace function public.is_member(b uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from baby_access a where a.baby_id = b and a.user_id = auth.uid() and a.invitation_status = 'accepted'
                 and (a.role = 'owner' or a.keeps_free_access or has_plus(b))) $$;

-- the slot is server-maintained: the first caregiver to accept gets it; leaving or being removed frees it
create or replace function public.maintain_free_slot() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and current_user in ('anon', 'authenticated') then new.keeps_free_access := old.keeps_free_access; end if;
  if tg_op = 'INSERT' then new.keeps_free_access := false; end if;
  if new.invitation_status <> 'accepted' or new.role <> 'caregiver' then new.keeps_free_access := false;
  elsif tg_op = 'UPDATE' and old.invitation_status <> 'accepted'
        and not exists (select 1 from baby_access where baby_id = new.baby_id and keeps_free_access and access_id <> new.access_id) then
    new.keeps_free_access := true;
  end if;
  return new;
end $$;
drop trigger if exists access_free_slot on public.baby_access;
create trigger access_free_slot before insert or update on public.baby_access for each row execute function public.maintain_free_slot();

-- when the slot holder leaves, the earliest remaining caregiver takes it
create or replace function public.refill_free_slot() returns trigger language plpgsql security definer set search_path = public as $$
declare b uuid := coalesce(new.baby_id, old.baby_id);
begin
  if not exists (select 1 from baby_access where baby_id = b and keeps_free_access) then
    update baby_access set keeps_free_access = true where access_id = (
      select access_id from baby_access where baby_id = b and role = 'caregiver' and invitation_status = 'accepted' order by created_at, access_id limit 1);
  end if;
  return null;
end $$;
drop trigger if exists access_refill_free_slot on public.baby_access;
create trigger access_refill_free_slot after update of invitation_status or delete on public.baby_access for each row execute function public.refill_free_slot();

-- owner picks who keeps access on the free plan
create or replace function public.choose_free_caregiver(p_access_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare b uuid;
begin
  select baby_id into b from baby_access where access_id = p_access_id and role = 'caregiver' and invitation_status = 'accepted';
  if b is null then raise exception 'That person isn’t a caregiver on this profile'; end if;
  if not is_owner(b) then raise exception 'Only the profile owner can do this' using errcode = '42501'; end if;
  update baby_access set keeps_free_access = false where baby_id = b and keeps_free_access and access_id <> p_access_id;
  update baby_access set keeps_free_access = true, updated_at = now() where access_id = p_access_id;
end $$;

-- babies the caller belongs to but is paused on (so the app can explain instead of just losing the profile)
create or replace function public.my_paused_babies() returns table (baby_id uuid, name text, owner_name text) language sql stable security definer set search_path = public as $$
  select a.baby_id, bp.name, (select p.display_name from baby_access o join profiles p on p.user_id = o.user_id where o.baby_id = a.baby_id and o.role = 'owner' limit 1)
  from baby_access a join baby_profiles bp on bp.baby_id = a.baby_id
  where a.user_id = auth.uid() and a.invitation_status = 'accepted' and a.role = 'caregiver' and not a.keeps_free_access and not has_plus(a.baby_id) $$;

-- ---------- privileges ----------
revoke all on function public.owner_of(uuid), public.setting(text), public.limit_value(text), public.has_plus(uuid), public.logged_days(uuid),
  public.plus_status(uuid), public.start_plus_trial(uuid), public.use_ai_quota(uuid), public.check_caregiver_limit(),
  public.maintain_free_slot(), public.refill_free_slot(), public.choose_free_caregiver(uuid), public.my_paused_babies() from public, anon;
revoke all on function public.owner_of(uuid), public.setting(text), public.limit_value(text), public.has_plus(uuid), public.logged_days(uuid), public.check_caregiver_limit(),
  public.maintain_free_slot(), public.refill_free_slot() from authenticated;
grant execute on function public.plus_status(uuid), public.start_plus_trial(uuid), public.use_ai_quota(uuid), public.choose_free_caregiver(uuid), public.my_paused_babies() to authenticated;
grant select on public.app_settings to anon, authenticated;
