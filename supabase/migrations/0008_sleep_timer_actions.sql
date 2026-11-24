-- 0008: sleep timer taps as server actions (24 Nov 2026). Run after 0007.
-- Close Bebig on all devices first (or rely on the lock timeout below: it fails cleanly instead of deadlocking).
-- No existing data is changed.
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
