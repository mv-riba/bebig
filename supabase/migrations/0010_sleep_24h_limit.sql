-- 0010: a sleep can't be longer than 24 hours (25 Nov 2026, Maria's decision). Run after 0009.
-- A sleep timer left running over 24 hours can only be discarded and entered by hand (the app offers this);
-- the server refuses to stop it as is, and no saved sleep may span more than 24 hours.
-- Checked before writing: no existing sleep breaks this (longest 5 h 49 min), so the check is validated at once.
-- Close Bebig on all devices first (or rely on the lock timeout: it fails cleanly instead of deadlocking).

set local lock_timeout = '15s';
lock table public.sleep_entries in access exclusive mode;

alter table public.sleep_entries add constraint sleep_entries_max_24h
  check (end_datetime is null or end_datetime - start_datetime <= interval '24 hours');

create or replace function public.sleep_stop(p_sleep_id uuid, p_at timestamptz) returns jsonb language plpgsql set search_path = public as $$
declare r sleep_entries := sleep_lock(p_sleep_id); e timestamptz; p jsonb;
begin
  if r.deleted_at is not null then return sleep_result('not_running', r); end if;
  if r.status = 'completed' then return sleep_result('already_stopped', r); end if; -- first stop wins
  e := greatest(least(p_at, now()), r.start_datetime + interval '1 second');
  if e - r.start_datetime > interval '24 hours' then
    raise exception 'This sleep timer ran for more than 24 hours. Discard it and enter the real times.' using errcode = 'P0001';
  end if;
  p := sleep_pauses_until(r.pauses, e);
  update sleep_entries set end_datetime = e, status = 'completed', pauses = p, duration_seconds = sleep_seconds(r.start_datetime, e, p),
    updated_by = auth.uid(), updated_at = now()
    where sleep_id = p_sleep_id returning * into r;
  return sleep_result('stopped', r);
end $$;
