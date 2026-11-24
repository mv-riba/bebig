\set ON_ERROR_STOP 1
-- run after supabase-stub.sql and migrations 0001–0008 (fresh database). Every row must say ok = t.
begin; -- one transaction: now() is the same in every statement
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-00000000000a','o@x.fi','{}'),('00000000-0000-0000-0000-00000000000c','c@x.fi','{}'),('00000000-0000-0000-0000-00000000000f','f@x.fi','{}');
create function pg_temp.as_user(u text, e text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claims', json_build_object('sub',u,'email',e)::text, false); end $$;
create function pg_temp.blocked(q text) returns boolean language plpgsql as $$ begin execute q; return false; exception when others then return true; end $$;
create function pg_temp.s(id text) returns public.sleep_entries language sql as $$ select * from public.sleep_entries where sleep_id = id::uuid $$;

set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000a','o@x.fi');
insert into baby_profiles (baby_id,name,date_of_birth,sex,timezone,created_by) values ('11111111-0000-0000-0000-000000000001','Baby','2026-10-01','female','Europe/Helsinki','00000000-0000-0000-0000-00000000000a');
insert into baby_access (access_id, baby_id, invited_email, role) values ('22222222-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','c@x.fi','caregiver');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c','c@x.fi'); select respond_invitation('22222222-0000-0000-0000-000000000001', true);

-- ---------- two caregivers stop the same sleep ----------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a','o@x.fi');
select 'start' as t, sleep_start('44444444-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001', now() - interval '90 minutes')->>'outcome' = 'started' as ok;
select 'start retry is idempotent' as t, sleep_start('44444444-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001', now())->>'outcome' = 'started'
  and (select count(*) from sleep_entries) = 1 as ok;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c','c@x.fi');
select 'caregiver stops first' as t, sleep_stop('44444444-0000-0000-0000-000000000001', now() - interval '30 minutes')->>'outcome' = 'stopped' as ok;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a','o@x.fi');
select 'second stop is told it was already stopped' as t, sleep_stop('44444444-0000-0000-0000-000000000001', now() - interval '29 minutes')->>'outcome' = 'already_stopped' as ok;
select 'first stop''s end time kept' as t, (pg_temp.s('44444444-0000-0000-0000-000000000001')).end_datetime between now() - interval '30 minutes 1 second' and now() - interval '29 minutes 59 seconds' as ok;
select 'stopped by the caregiver' as t, (pg_temp.s('44444444-0000-0000-0000-000000000001')).updated_by = '00000000-0000-0000-0000-00000000000c' as ok;
select 'duration 60 min' as t, (pg_temp.s('44444444-0000-0000-0000-000000000001')).duration_seconds = 3600 as ok;

-- ---------- stale actions can't reopen a finished sleep ----------
select 'stale pause refused' as t, sleep_pause('44444444-0000-0000-0000-000000000001', now())->>'outcome' = 'not_running' as ok;
select 'stale resume refused' as t, sleep_resume('44444444-0000-0000-0000-000000000001', now())->>'outcome' = 'not_running' as ok;
select 'stale discard keeps the saved sleep' as t, sleep_discard('44444444-0000-0000-0000-000000000001')->>'outcome' = 'not_running'
  and (pg_temp.s('44444444-0000-0000-0000-000000000001')).deleted_at is null as ok;
-- an old app version uploading its stale "paused" copy of the row
update sleep_entries set status = 'paused', end_datetime = null, duration_seconds = null, pauses = '[{"start":"2026-11-24T08:00:00Z","end":null}]', updated_by = '00000000-0000-0000-0000-00000000000a' where sleep_id = '44444444-0000-0000-0000-000000000001';
select 'stale row upload skipped' as t, (pg_temp.s('44444444-0000-0000-0000-000000000001')).status = 'completed' and (pg_temp.s('44444444-0000-0000-0000-000000000001')).end_datetime is not null as ok;
-- same through the app's upsert path
insert into sleep_entries (sleep_id, baby_id, start_datetime, status, pauses, created_by, updated_by, deleted_at)
  values ('44444444-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001', now() - interval '90 minutes','active','[]','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000a', now())
  on conflict (sleep_id) do update set status = excluded.status, end_datetime = excluded.end_datetime, deleted_at = excluded.deleted_at, updated_by = excluded.updated_by;
select 'stale discard upload skipped' as t, (pg_temp.s('44444444-0000-0000-0000-000000000001')).deleted_at is null and (pg_temp.s('44444444-0000-0000-0000-000000000001')).status = 'completed' as ok;
-- editing a finished sleep's times still works
update sleep_entries set end_datetime = now() - interval '20 minutes', duration_seconds = 4200, updated_by = '00000000-0000-0000-0000-00000000000a' where sleep_id = '44444444-0000-0000-0000-000000000001';
select 'manual edit of a finished sleep allowed' as t, (pg_temp.s('44444444-0000-0000-0000-000000000001')).duration_seconds = 4200 as ok;
select 'deleting a finished sleep allowed' as t, not pg_temp.blocked($q$update sleep_entries set deleted_at = now(), updated_by = '00000000-0000-0000-0000-00000000000a' where sleep_id = '44444444-0000-0000-0000-000000000001'$q$)
  and (pg_temp.s('44444444-0000-0000-0000-000000000001')).deleted_at is not null as ok;

-- ---------- two caregivers start at once: the second joins ----------
select 'owner starts' as t, sleep_start('44444444-0000-0000-0000-000000000002','11111111-0000-0000-0000-000000000001', now() - interval '10 minutes')->>'outcome' = 'started' as ok;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c','c@x.fi');
select 'caregiver''s offline start joins it' as t, (j->>'outcome') = 'joined' and (j->'row'->>'sleep_id') = '44444444-0000-0000-0000-000000000002' as ok
  from (select sleep_start('44444444-0000-0000-0000-000000000003','11111111-0000-0000-0000-000000000001', now() - interval '15 minutes') j) x;
select 'no second timer row' as t, pg_temp.s('44444444-0000-0000-0000-000000000003') is null as ok;
select 'earlier start time kept' as t, (pg_temp.s('44444444-0000-0000-0000-000000000002')).start_datetime = now() - interval '15 minutes' as ok;

-- ---------- pause / resume / stop ----------
select 'pause' as t, sleep_pause('44444444-0000-0000-0000-000000000002', now() - interval '8 minutes')->>'outcome' = 'paused' as ok;
select 'double pause is harmless' as t, sleep_pause('44444444-0000-0000-0000-000000000002', now() - interval '7 minutes')->>'outcome' = 'paused'
  and jsonb_array_length((pg_temp.s('44444444-0000-0000-0000-000000000002')).pauses) = 1 as ok;
select 'resume' as t, sleep_resume('44444444-0000-0000-0000-000000000002', now() - interval '5 minutes')->>'outcome' = 'resumed' as ok;
select 'pause again' as t, sleep_pause('44444444-0000-0000-0000-000000000002', now() - interval '2 minutes')->>'outcome' = 'paused' as ok;
select 'stop while paused, phone clock 1 h ahead' as t, sleep_stop('44444444-0000-0000-0000-000000000002', now() + interval '1 hour')->>'outcome' = 'stopped' as ok;
select 'end clamped to now, open pause closed, paused time excluded' as t,
  (pg_temp.s('44444444-0000-0000-0000-000000000002')).end_datetime = now()
  and (pg_temp.s('44444444-0000-0000-0000-000000000002')).duration_seconds = 15*60 - 3*60 - 2*60
  and not jsonb_path_exists((pg_temp.s('44444444-0000-0000-0000-000000000002')).pauses, '$[*] ? (@.end == null)') as ok;

-- ---------- discard a running timer ----------
select 'start' as t, sleep_start('44444444-0000-0000-0000-000000000004','11111111-0000-0000-0000-000000000001', now())->>'outcome' = 'started' as ok;
select 'discard running timer' as t, sleep_discard('44444444-0000-0000-0000-000000000004')->>'outcome' = 'discarded'
  and (pg_temp.s('44444444-0000-0000-0000-000000000004')).deleted_at is not null as ok;
select 'stop after discard does nothing' as t, sleep_stop('44444444-0000-0000-0000-000000000004', now())->>'outcome' = 'not_running'
  and (pg_temp.s('44444444-0000-0000-0000-000000000004')).status <> 'completed' as ok;

-- ---------- outsiders ----------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000f','f@x.fi');
select 'outsider can''t stop' as t, pg_temp.blocked($q$select sleep_stop('44444444-0000-0000-0000-000000000002', now())$q$) as ok;
select 'outsider can''t start for the baby' as t, pg_temp.blocked($q$select sleep_start('44444444-0000-0000-0000-000000000009','11111111-0000-0000-0000-000000000001', now())$q$) as ok;
reset role;
set role anon;
select 'anon can''t call' as t, pg_temp.blocked($q$select sleep_stop('44444444-0000-0000-0000-000000000002', now())$q$) as ok;
reset role;
commit;
