-- 0008: timer taps as server actions, and shared breastfeeding / extras timers (24 Nov 2026). Run after 0007.
-- Close Bebig on all devices first (or rely on the lock timeout below: it fails cleanly instead of deadlocking).
-- No existing data is changed.
--
-- Part 1 (sleep timer, below) and part 2 (breastfeeding and extras timers, at the end) follow the same rules.
--
-- Problem: the app uploaded the whole sleep row after every Start / Pause / Resume / Stop, and the last upload
-- to reach the server won. When two caregivers both stopped the same sleep, the saved end time was whichever
-- phone synced last (an offline phone could stretch the sleep by hours), and a phone that hadn't seen the stop
-- yet could reopen a finished sleep by tapping Pause or Discard.
--
-- Fix: each tap is sent as an action with the time it was tapped. The server applies actions one at a time
-- (row lock) and returns the final row with an outcome the app shows to the caregiver:
--   sleep_start    starts a sleep; if one is already running for the baby, joins it instead of failing
--                  (keeps the earlier start time)                         → 'started' | 'joined'
--   sleep_stop     the first Stop to reach the server sets the end time   → 'stopped' | 'already_stopped'
--   sleep_pause    / sleep_resume: refused for a finished or discarded sleep → 'paused' | 'resumed' | 'not_running'
--   sleep_discard  discards a running timer, never a finished sleep       → 'discarded' | 'not_running'
-- Tap times are clamped to [sleep start, now], so a wrong phone clock can't create impossible times.
--
-- Guard: ordinary row uploads (older app versions, changes queued before this update) can no longer turn a
-- finished sleep back into a running one; such an upload is skipped. Editing a finished sleep's times works as before.
--
-- Functions run as the caller (security invoker), so row-level security applies exactly as for normal uploads.

set local lock_timeout = '15s';
lock table public.sleep_entries in access exclusive mode;

-- ---------- helpers ----------
-- the app's timestamp format inside `pauses` (ISO 8601, UTC, milliseconds)
create or replace function public.iso_utc(t timestamptz) returns text language sql immutable set search_path = public as $$
  select to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

-- pauses ending by `e`: drop pauses that start at/after it, close open or overrunning ones at it
create or replace function public.sleep_pauses_until(p jsonb, e timestamptz) returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(
      case when x->>'end' is null or (x->>'end')::timestamptz > e then jsonb_build_object('start', x->>'start', 'end', iso_utc(e)) else x end
      order by n), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p, '[]'::jsonb)) with ordinality as t(x, n)
  where (x->>'start')::timestamptz < e $$;

-- sleep length in seconds, excluding paused time (same rule as sleepElapsed() in the app)
create or replace function public.sleep_seconds(s timestamptz, e timestamptz, p jsonb) returns integer language sql stable set search_path = public as $$
  select greatest(0, round(extract(epoch from (e - s)) - coalesce((
    select sum(greatest(0, extract(epoch from (coalesce((x->>'end')::timestamptz, e) - (x->>'start')::timestamptz))))
    from jsonb_array_elements(coalesce(p, '[]'::jsonb)) as t(x)), 0)))::integer $$;

-- latest pause end (or start) so a new pause never overlaps an earlier one
create or replace function public.sleep_last_pause_time(p jsonb) returns timestamptz language sql stable set search_path = public as $$
  select max(greatest((x->>'start')::timestamptz, coalesce((x->>'end')::timestamptz, (x->>'start')::timestamptz)))
  from jsonb_array_elements(coalesce(p, '[]'::jsonb)) as t(x) $$;

create or replace function public.sleep_result(o text, r public.sleep_entries) returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('outcome', o, 'row', to_jsonb(r)) $$;

-- the sleep, locked; raises if it isn't on the server or the caller can't see it
create or replace function public.sleep_lock(p_sleep_id uuid) returns public.sleep_entries language plpgsql set search_path = public as $$
declare r sleep_entries;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into r from sleep_entries where sleep_id = p_sleep_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'sleep_not_found', detail = 'This sleep isn’t on the server.'; end if;
  return r;
end $$;

-- ---------- actions ----------
create or replace function public.sleep_start(p_sleep_id uuid, p_baby_id uuid, p_at timestamptz) returns jsonb language plpgsql set search_path = public as $$
declare r sleep_entries; t timestamptz := least(p_at, now());
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into r from sleep_entries where sleep_id = p_sleep_id;
  if found then return sleep_result('started', r); end if; -- a retry of a start that already arrived
  begin
    insert into sleep_entries (sleep_id, baby_id, start_datetime, status, pauses, created_by, updated_by)
    values (p_sleep_id, p_baby_id, t, 'active', '[]', auth.uid(), auth.uid()) returning * into r;
    return sleep_result('started', r);
  exception when unique_violation then
    -- another caregiver already has a timer running for this baby: join it
    select * into r from sleep_entries where baby_id = p_baby_id and status <> 'completed' and deleted_at is null for update;
    if not found then raise; end if;
    if t < r.start_datetime then
      update sleep_entries set start_datetime = t, updated_by = auth.uid(), updated_at = now()
        where sleep_id = r.sleep_id returning * into r;
    end if;
    return sleep_result('joined', r);
  end;
end $$;

create or replace function public.sleep_stop(p_sleep_id uuid, p_at timestamptz) returns jsonb language plpgsql set search_path = public as $$
declare r sleep_entries := sleep_lock(p_sleep_id); e timestamptz; p jsonb;
begin
  if r.deleted_at is not null then return sleep_result('not_running', r); end if;
  if r.status = 'completed' then return sleep_result('already_stopped', r); end if; -- first stop wins
  e := greatest(least(p_at, now()), r.start_datetime + interval '1 second');
  p := sleep_pauses_until(r.pauses, e);
  update sleep_entries set end_datetime = e, status = 'completed', pauses = p, duration_seconds = sleep_seconds(r.start_datetime, e, p),
    updated_by = auth.uid(), updated_at = now()
    where sleep_id = p_sleep_id returning * into r;
  return sleep_result('stopped', r);
end $$;

create or replace function public.sleep_pause(p_sleep_id uuid, p_at timestamptz) returns jsonb language plpgsql set search_path = public as $$
declare r sleep_entries := sleep_lock(p_sleep_id); t timestamptz;
begin
  if r.deleted_at is not null or r.status = 'completed' then return sleep_result('not_running', r); end if;
  if r.status = 'paused' then return sleep_result('paused', r); end if;
  t := greatest(least(p_at, now()), r.start_datetime, coalesce(sleep_last_pause_time(r.pauses), r.start_datetime));
  update sleep_entries set status = 'paused', pauses = coalesce(pauses, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('start', iso_utc(t), 'end', null)),
    updated_by = auth.uid(), updated_at = now()
    where sleep_id = p_sleep_id returning * into r;
  return sleep_result('paused', r);
end $$;

create or replace function public.sleep_resume(p_sleep_id uuid, p_at timestamptz) returns jsonb language plpgsql set search_path = public as $$
declare r sleep_entries := sleep_lock(p_sleep_id); t timestamptz;
begin
  if r.deleted_at is not null or r.status = 'completed' then return sleep_result('not_running', r); end if;
  if r.status = 'active' then return sleep_result('resumed', r); end if;
  t := greatest(least(p_at, now()), coalesce(sleep_last_pause_time(r.pauses), r.start_datetime));
  update sleep_entries set status = 'active',
    pauses = (select coalesce(jsonb_agg(case when x->>'end' is null then jsonb_build_object('start', x->>'start', 'end', iso_utc(t)) else x end order by n), '[]'::jsonb)
              from jsonb_array_elements(coalesce(r.pauses, '[]'::jsonb)) with ordinality as q(x, n)),
    updated_by = auth.uid(), updated_at = now()
    where sleep_id = p_sleep_id returning * into r;
  return sleep_result('resumed', r);
end $$;

create or replace function public.sleep_discard(p_sleep_id uuid) returns jsonb language plpgsql set search_path = public as $$
declare r sleep_entries := sleep_lock(p_sleep_id);
begin
  if r.status = 'completed' and r.deleted_at is null then return sleep_result('not_running', r); end if; -- someone saved it
  if r.deleted_at is not null then return sleep_result('discarded', r); end if;
  update sleep_entries set deleted_at = now(), updated_by = auth.uid(), updated_at = now()
    where sleep_id = p_sleep_id returning * into r;
  return sleep_result('discarded', r);
end $$;

-- ---------- guard: a finished sleep is never reopened by an upload ----------
create or replace function public.guard_finished_sleep() returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') and old.status = 'completed' and new.status <> 'completed' then
    return null; -- stale timer state from a device that hadn't seen the stop yet: keep the server copy
  end if;
  return new;
end $$;
drop trigger if exists sleep_entries_guard on public.sleep_entries;
create trigger sleep_entries_guard before update on public.sleep_entries for each row execute function public.guard_finished_sleep();

-- ---------- privileges ----------
revoke all on function public.sleep_start(uuid, uuid, timestamptz), public.sleep_stop(uuid, timestamptz),
  public.sleep_pause(uuid, timestamptz), public.sleep_resume(uuid, timestamptz), public.sleep_discard(uuid),
  public.sleep_lock(uuid) from public, anon;
grant execute on function public.sleep_start(uuid, uuid, timestamptz), public.sleep_stop(uuid, timestamptz),
  public.sleep_pause(uuid, timestamptz), public.sleep_resume(uuid, timestamptz), public.sleep_discard(uuid),
  public.sleep_lock(uuid) to authenticated;
revoke execute on function public.guard_finished_sleep() from public, anon, authenticated;

-- =====================================================================================================
-- Part 2: breastfeeding and extras timers, shared between caregivers
-- =====================================================================================================
-- Until now these timers lived only on the phone that started them, so other caregivers couldn't see that a
-- feed or a walk was being timed. Each running timer is now one small row here, changed only through the
-- action functions below (same rules as the sleep timer: applied one at a time, first Stop wins, a finished
-- timer can't be reopened by a phone that hadn't seen it yet). The saved feed or extras entry is uploaded by
-- the app as before, only by the caregiver whose Stop won.
--   timer_start    starts a timer; if one is already running (feed: per baby, extras: per tracker), joins it
--                                                                          → 'started' | 'joined'
--   timer_pause    / timer_resume / timer_side (switch breast side)       → 'paused' | 'resumed' | 'side' | 'not_running'
--   timer_stop     the first Stop to reach the server ends it             → 'stopped' | 'already_stopped' | 'not_running'
--   timer_discard  discards a running timer, never one already saved     → 'discarded' | 'not_running'
-- Seconds timed so far are kept per breast side (left / right / no side; extras use "no side"). The time of
-- the current stretch is counted from segment_started_at, which is empty while paused.
-- The functions run as the table owner (the table has no insert/update rights for app users) and check
-- membership themselves with is_member(), so paused caregivers and outsiders can't use them.

-- the new table's foreign keys need these (the 15 s lock timeout above still applies)
lock table public.baby_profiles, public.extra_trackers in share row exclusive mode;

create table if not exists public.running_timers (
  timer_id uuid primary key,
  baby_id uuid not null references public.baby_profiles(baby_id) on delete cascade,
  kind text not null check (kind in ('feed', 'extra')),
  tracker_id uuid references public.extra_trackers(tracker_id) on delete cascade,
  started_at timestamptz not null,
  side text check (side in ('left', 'right')),
  left_seconds double precision not null default 0 check (left_seconds between 0 and 172800),
  right_seconds double precision not null default 0 check (right_seconds between 0 and 172800),
  unsided_seconds double precision not null default 0 check (unsided_seconds between 0 and 172800),
  segment_started_at timestamptz,          -- null while paused
  ended_at timestamptz,                    -- set when saved or discarded
  end_kind text check (end_kind in ('saved', 'discarded')),
  entry_id uuid,                           -- the feed or extras entry the winning Stop saved
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  server_updated_at timestamptz not null default now(),
  check ((kind = 'extra') = (tracker_id is not null)),
  check (kind = 'feed' or side is null),
  check ((ended_at is null) = (end_kind is null))
);
create index if not exists running_timers_baby on public.running_timers (baby_id);
-- at most one running breastfeeding timer per baby, and one running timer per extras tracker
create unique index if not exists running_timers_one_feed on public.running_timers (baby_id) where kind = 'feed' and ended_at is null;
create unique index if not exists running_timers_one_extra on public.running_timers (tracker_id) where kind = 'extra' and ended_at is null;

drop trigger if exists running_timers_touch on public.running_timers;
create trigger running_timers_touch before insert or update on public.running_timers for each row execute function public.touch_server_updated_at();

alter table public.running_timers enable row level security;
drop policy if exists running_timers_select on public.running_timers;
create policy running_timers_select on public.running_timers for select using (public.is_member(baby_id));
revoke all on public.running_timers from public, anon, authenticated;
grant select on public.running_timers to authenticated;

-- other caregivers' phones are told straight away when a timer changes (as for sleeps)
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'running_timers') then
    alter publication supabase_realtime add table public.running_timers;
  end if;
end $$;

-- ---------- helpers ----------
create or replace function public.timer_result(o text, r public.running_timers) returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('outcome', o, 'row', to_jsonb(r)) $$;

-- the timer, locked; raises if it isn't on the server or the caller can't see it
create or replace function public.timer_lock(p_timer_id uuid) returns public.running_timers language plpgsql security definer set search_path = public as $$
declare r running_timers;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into r from running_timers where timer_id = p_timer_id for update;
  if not found or not is_member(r.baby_id) then
    raise exception using errcode = 'P0001', message = 'timer_not_found', detail = 'This timer isn’t on the server.';
  end if;
  return r;
end $$;

-- the running stretch ends at t: its seconds go to the current side
create or replace function public.timer_close_segment(r public.running_timers, t timestamptz) returns public.running_timers language plpgsql stable set search_path = public as $$
declare secs double precision;
begin
  if r.segment_started_at is null then return r; end if;
  secs := greatest(0, extract(epoch from (t - r.segment_started_at)));
  if r.side = 'left' then r.left_seconds := least(172800, r.left_seconds + secs);
  elsif r.side = 'right' then r.right_seconds := least(172800, r.right_seconds + secs);
  else r.unsided_seconds := least(172800, r.unsided_seconds + secs); end if;
  r.segment_started_at := null;
  return r;
end $$;

-- a tap time: never in the future, never before the current stretch (or the start)
create or replace function public.timer_tap_time(r public.running_timers, p_at timestamptz) returns timestamptz language sql stable set search_path = public as $$
  select greatest(least(coalesce(p_at, now()), now()), coalesce(r.segment_started_at, r.started_at), r.started_at) $$;

create or replace function public.timer_save(r public.running_timers) returns public.running_timers language plpgsql security definer set search_path = public as $$
begin
  update running_timers set side = r.side, left_seconds = r.left_seconds, right_seconds = r.right_seconds, unsided_seconds = r.unsided_seconds,
    segment_started_at = r.segment_started_at, ended_at = r.ended_at, end_kind = r.end_kind, entry_id = r.entry_id,
    updated_by = auth.uid(), updated_at = now()
    where timer_id = r.timer_id returning * into r;
  return r;
end $$;

-- ---------- actions ----------
create or replace function public.timer_start(p_timer_id uuid, p_baby_id uuid, p_kind text, p_tracker_id uuid, p_side text, p_at timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r running_timers; t timestamptz := greatest(least(coalesce(p_at, now()), now()), now() - interval '1 day');
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if not is_member(p_baby_id) then raise exception 'Not a member of this baby profile' using errcode = '42501'; end if;
  select * into r from running_timers where timer_id = p_timer_id;
  if found then -- a retry of a start that already arrived
    if r.baby_id <> p_baby_id then raise exception 'timer_not_found' using errcode = 'P0001'; end if;
    return timer_result('started', r);
  end if;
  if p_kind = 'extra' and not exists (select 1 from extra_trackers x where x.tracker_id = p_tracker_id and x.baby_id = p_baby_id and x.deleted_at is null) then
    raise exception 'This tracker isn’t on the server.' using errcode = 'P0001';
  end if;
  -- finished timers are only needed for a little while (to tell a late phone who stopped them)
  delete from running_timers where baby_id = p_baby_id and ended_at < now() - interval '2 days';
  begin
    insert into running_timers (timer_id, baby_id, kind, tracker_id, started_at, side, segment_started_at, created_by, updated_by)
    values (p_timer_id, p_baby_id, p_kind, case when p_kind = 'extra' then p_tracker_id end, t,
            case when p_kind = 'feed' and p_side in ('left', 'right') then p_side end, t, auth.uid(), auth.uid())
    returning * into r;
    return timer_result('started', r);
  exception when unique_violation then
    -- another caregiver already has this timer running: join it (theirs is kept as it is)
    select * into r from running_timers where baby_id = p_baby_id and kind = p_kind and ended_at is null
      and (p_kind = 'feed' or tracker_id = p_tracker_id) for update;
    if not found then raise; end if;
    return timer_result('joined', r);
  end;
end $$;

create or replace function public.timer_pause(p_timer_id uuid, p_at timestamptz) returns jsonb language plpgsql security definer set search_path = public as $$
declare r running_timers := timer_lock(p_timer_id);
begin
  if r.ended_at is not null then return timer_result('not_running', r); end if;
  if r.segment_started_at is null then return timer_result('paused', r); end if;
  return timer_result('paused', timer_save(timer_close_segment(r, timer_tap_time(r, p_at))));
end $$;

create or replace function public.timer_resume(p_timer_id uuid, p_at timestamptz) returns jsonb language plpgsql security definer set search_path = public as $$
declare r running_timers := timer_lock(p_timer_id);
begin
  if r.ended_at is not null then return timer_result('not_running', r); end if;
  if r.segment_started_at is not null then return timer_result('resumed', r); end if;
  r.segment_started_at := timer_tap_time(r, p_at);
  return timer_result('resumed', timer_save(r));
end $$;

create or replace function public.timer_side(p_timer_id uuid, p_side text, p_at timestamptz) returns jsonb language plpgsql security definer set search_path = public as $$
declare r running_timers := timer_lock(p_timer_id); t timestamptz; running boolean;
begin
  if r.ended_at is not null then return timer_result('not_running', r); end if;
  if r.kind <> 'feed' then return timer_result('side', r); end if;
  running := r.segment_started_at is not null;
  t := timer_tap_time(r, p_at);
  r := timer_close_segment(r, t);
  r.side := case when p_side in ('left', 'right') then p_side end;
  if running then r.segment_started_at := t; end if;
  return timer_result('side', timer_save(r));
end $$;

create or replace function public.timer_stop(p_timer_id uuid, p_at timestamptz, p_entry_id uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare r running_timers := timer_lock(p_timer_id); t timestamptz;
begin
  if r.end_kind = 'saved' then
    return timer_result(case when r.entry_id = p_entry_id then 'stopped' else 'already_stopped' end, r); -- first stop wins (a retry is fine)
  end if;
  if r.end_kind = 'discarded' then return timer_result('not_running', r); end if;
  t := timer_tap_time(r, p_at);
  r := timer_close_segment(r, t);
  r.ended_at := t; r.end_kind := 'saved'; r.entry_id := p_entry_id;
  return timer_result('stopped', timer_save(r));
end $$;

create or replace function public.timer_discard(p_timer_id uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare r running_timers := timer_lock(p_timer_id);
begin
  if r.end_kind = 'saved' then return timer_result('not_running', r); end if; -- someone saved it: keep it
  if r.end_kind = 'discarded' then return timer_result('discarded', r); end if;
  r := timer_close_segment(r, now());
  r.ended_at := now(); r.end_kind := 'discarded';
  return timer_result('discarded', timer_save(r));
end $$;

-- ---------- privileges ----------
revoke all on function public.timer_lock(uuid), public.timer_save(public.running_timers),
  public.timer_close_segment(public.running_timers, timestamptz), public.timer_tap_time(public.running_timers, timestamptz),
  public.timer_result(text, public.running_timers) from public, anon, authenticated;
revoke all on function public.timer_start(uuid, uuid, text, uuid, text, timestamptz), public.timer_pause(uuid, timestamptz),
  public.timer_resume(uuid, timestamptz), public.timer_side(uuid, text, timestamptz), public.timer_stop(uuid, timestamptz, uuid),
  public.timer_discard(uuid) from public, anon;
grant execute on function public.timer_start(uuid, uuid, text, uuid, text, timestamptz), public.timer_pause(uuid, timestamptz),
  public.timer_resume(uuid, timestamptz), public.timer_side(uuid, text, timestamptz), public.timer_stop(uuid, timestamptz, uuid),
  public.timer_discard(uuid) to authenticated;
