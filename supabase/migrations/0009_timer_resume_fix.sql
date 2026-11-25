-- 0009: a late Resume can't make a breastfeeding / extras timer count more time than passed (25 Nov 2026). Run after 0008.
-- Close Bebig on all devices first (or rely on the lock timeout below: it fails cleanly instead of deadlocking).
-- No existing data is changed.
--
-- Problem: a phone that was offline sends its taps when it's back. If it had tapped Pause then Resume while
-- another caregiver's Pause reached the server in between, the late Resume restarted the timer from its own
-- (earlier) tap time, so the minutes between that Resume and the other Pause were counted twice
-- (e.g. a 20-minute walk saved as 25 minutes). The sleep timer already guards against this; these timers didn't.
-- Fix: remember when the timer was paused (paused_at) and never resume it before that.

set local lock_timeout = '15s';
lock table public.running_timers in access exclusive mode;

alter table public.running_timers add column if not exists paused_at timestamptz;

-- a Resume tap time: not before the pause it ends. Timers paused before this update have no paused_at; for them
-- the start plus the seconds already counted is the earliest the pause can have been.
create or replace function public.timer_resume(p_timer_id uuid, p_at timestamptz) returns jsonb language plpgsql security definer set search_path = public as $$
declare r running_timers := timer_lock(p_timer_id);
begin
  if r.ended_at is not null then return timer_result('not_running', r); end if;
  if r.segment_started_at is not null then return timer_result('resumed', r); end if;
  r.segment_started_at := least(now(), greatest(timer_tap_time(r, p_at),
    coalesce(r.paused_at, r.started_at + make_interval(secs => r.left_seconds + r.right_seconds + r.unsided_seconds))));
  r.paused_at := null;
  return timer_result('resumed', timer_save(r));
end $$;

create or replace function public.timer_pause(p_timer_id uuid, p_at timestamptz) returns jsonb language plpgsql security definer set search_path = public as $$
declare r running_timers := timer_lock(p_timer_id); t timestamptz;
begin
  if r.ended_at is not null then return timer_result('not_running', r); end if;
  if r.segment_started_at is null then return timer_result('paused', r); end if;
  t := timer_tap_time(r, p_at);
  r := timer_close_segment(r, t);
  r.paused_at := t;
  return timer_result('paused', timer_save(r));
end $$;

-- timer_save writes paused_at too
create or replace function public.timer_save(r public.running_timers) returns public.running_timers language plpgsql security definer set search_path = public as $$
begin
  update running_timers set side = r.side, left_seconds = r.left_seconds, right_seconds = r.right_seconds, unsided_seconds = r.unsided_seconds,
    segment_started_at = r.segment_started_at, paused_at = r.paused_at, ended_at = r.ended_at, end_kind = r.end_kind, entry_id = r.entry_id,
    updated_by = auth.uid(), updated_at = now()
    where timer_id = r.timer_id returning * into r;
  return r;
end $$;

-- (create or replace keeps the existing grants; the helper stays private)
revoke all on function public.timer_save(public.running_timers) from public, anon, authenticated;
