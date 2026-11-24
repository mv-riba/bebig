\set ON_ERROR_STOP 1
-- Shared breastfeeding / extras timers (0008 part 2).
-- Run after supabase-stub.sql and migrations 0001–0008 (fresh database). Every row must say ok = t.
begin; -- one transaction: now() is the same in every statement
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-00000000000a','o@x.fi','{}'),('00000000-0000-0000-0000-00000000000c','c@x.fi','{}'),('00000000-0000-0000-0000-00000000000f','f@x.fi','{}');
create function pg_temp.as_user(u text, e text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claims', json_build_object('sub',u,'email',e)::text, false); end $$;
create function pg_temp.blocked(q text) returns boolean language plpgsql as $$ begin execute q; return false; exception when others then return true; end $$;
create function pg_temp.t(id text) returns public.running_timers language sql as $$ select * from public.running_timers where timer_id = id::uuid $$;

set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000a','o@x.fi');
insert into baby_profiles (baby_id,name,date_of_birth,sex,timezone,created_by) values ('11111111-0000-0000-0000-000000000001','Baby','2026-10-01','female','Europe/Helsinki','00000000-0000-0000-0000-00000000000a');
insert into baby_access (access_id, baby_id, invited_email, role) values ('22222222-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','c@x.fi','caregiver');
insert into extra_trackers (tracker_id, baby_id, name, kind, created_by, updated_by) values
  ('33333333-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','Walk','duration','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000a'),
  ('33333333-0000-0000-0000-000000000002','11111111-0000-0000-0000-000000000001','Tummy time','duration','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000a');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c','c@x.fi'); select respond_invitation('22222222-0000-0000-0000-000000000001', true);

-- ---------- breastfeeding timer: sides, pause, the other caregiver sees it ----------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a','o@x.fi');
select 'feed timer starts on the left' as t, timer_start('55555555-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','feed',null,'left', now() - interval '20 minutes')->>'outcome' = 'started' as ok;
select 'start retry is idempotent' as t, timer_start('55555555-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','feed',null,'left', now())->>'outcome' = 'started'
  and (select count(*) from running_timers) = 1 as ok;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c','c@x.fi');
select 'caregiver sees the running timer' as t, (select count(*) from running_timers where ended_at is null) = 1 as ok;
select 'switch to right after 8 min' as t, timer_side('55555555-0000-0000-0000-000000000001','right', now() - interval '12 minutes')->>'outcome' = 'side' as ok;
select 'pause after 5 min on the right' as t, timer_pause('55555555-0000-0000-0000-000000000001', now() - interval '7 minutes')->>'outcome' = 'paused' as ok;
select 'double pause is harmless' as t, timer_pause('55555555-0000-0000-0000-000000000001', now() - interval '6 minutes')->>'outcome' = 'paused'
  and (pg_temp.t('55555555-0000-0000-0000-000000000001')).right_seconds = 300 as ok;
select 'side switch while paused stays paused' as t, timer_side('55555555-0000-0000-0000-000000000001','left', now() - interval '6 minutes')->>'outcome' = 'side'
  and (pg_temp.t('55555555-0000-0000-0000-000000000001')).segment_started_at is null and (pg_temp.t('55555555-0000-0000-0000-000000000001')).side = 'left' as ok;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a','o@x.fi');
select 'resume' as t, timer_resume('55555555-0000-0000-0000-000000000001', now() - interval '4 minutes')->>'outcome' = 'resumed' as ok;

-- ---------- two caregivers stop the same feed ----------
select 'owner stops first' as t, timer_stop('55555555-0000-0000-0000-000000000001', now() - interval '1 minute', '66666666-0000-0000-0000-00000000000a')->>'outcome' = 'stopped' as ok;
select 'seconds per side' as t, (pg_temp.t('55555555-0000-0000-0000-000000000001')).left_seconds = 8*60 + 3*60
  and (pg_temp.t('55555555-0000-0000-0000-000000000001')).right_seconds = 5*60 and (pg_temp.t('55555555-0000-0000-0000-000000000001')).unsided_seconds = 0 as ok;
select 'stop retry by the same phone is fine' as t, timer_stop('55555555-0000-0000-0000-000000000001', now(), '66666666-0000-0000-0000-00000000000a')->>'outcome' = 'stopped'
  and (pg_temp.t('55555555-0000-0000-0000-000000000001')).ended_at = now() - interval '1 minute' as ok;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c','c@x.fi');
select 'second stop is told it was already saved' as t, (j->>'outcome') = 'already_stopped' and (j->'row'->>'entry_id') = '66666666-0000-0000-0000-00000000000a'
  and (j->'row'->>'updated_by') = '00000000-0000-0000-0000-00000000000a' as ok
  from (select timer_stop('55555555-0000-0000-0000-000000000001', now(), '66666666-0000-0000-0000-00000000000c') j) x;
select 'stale pause / resume / side refused' as t, timer_pause('55555555-0000-0000-0000-000000000001', now())->>'outcome' = 'not_running'
  and timer_resume('55555555-0000-0000-0000-000000000001', now())->>'outcome' = 'not_running'
  and timer_side('55555555-0000-0000-0000-000000000001', 'right', now())->>'outcome' = 'not_running' as ok;
select 'stale discard keeps the saved feed' as t, timer_discard('55555555-0000-0000-0000-000000000001')->>'outcome' = 'not_running'
  and (pg_temp.t('55555555-0000-0000-0000-000000000001')).end_kind = 'saved' as ok;

-- ---------- two caregivers start at once: the second joins ----------
select 'caregiver starts a new feed timer' as t, timer_start('55555555-0000-0000-0000-000000000002','11111111-0000-0000-0000-000000000001','feed',null,null, now() - interval '3 minutes')->>'outcome' = 'started' as ok;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a','o@x.fi');
select 'owner''s start joins it' as t, (j->>'outcome') = 'joined' and (j->'row'->>'timer_id') = '55555555-0000-0000-0000-000000000002' as ok
  from (select timer_start('55555555-0000-0000-0000-000000000003','11111111-0000-0000-0000-000000000001','feed',null,'left', now()) j) x;
select 'no second timer row' as t, pg_temp.t('55555555-0000-0000-0000-000000000003') is null as ok;
select 'discard running timer' as t, timer_discard('55555555-0000-0000-0000-000000000002')->>'outcome' = 'discarded'
  and (pg_temp.t('55555555-0000-0000-0000-000000000002')).end_kind = 'discarded' as ok;
select 'stop after discard does nothing' as t, timer_stop('55555555-0000-0000-0000-000000000002', now(), '66666666-0000-0000-0000-00000000000b')->>'outcome' = 'not_running'
  and (pg_temp.t('55555555-0000-0000-0000-000000000002')).entry_id is null as ok;
select 'a new feed timer can start after one ends' as t, timer_start('55555555-0000-0000-0000-000000000004','11111111-0000-0000-0000-000000000001','feed',null,null, now())->>'outcome' = 'started' as ok;

-- ---------- extras timers: one per tracker ----------
select 'walk timer' as t, timer_start('55555555-0000-0000-0000-000000000010','11111111-0000-0000-0000-000000000001','extra','33333333-0000-0000-0000-000000000001','left', now() - interval '30 minutes')->>'outcome' = 'started'
  and (pg_temp.t('55555555-0000-0000-0000-000000000010')).side is null as ok;
select 'tummy time runs alongside' as t, timer_start('55555555-0000-0000-0000-000000000011','11111111-0000-0000-0000-000000000001','extra','33333333-0000-0000-0000-000000000002',null, now())->>'outcome' = 'started' as ok;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c','c@x.fi');
select 'second walk timer joins the first' as t, timer_start('55555555-0000-0000-0000-000000000012','11111111-0000-0000-0000-000000000001','extra','33333333-0000-0000-0000-000000000001',null, now())->'row'->>'timer_id' = '55555555-0000-0000-0000-000000000010' as ok;
select 'pause walk' as t, timer_pause('55555555-0000-0000-0000-000000000010', now() - interval '10 minutes')->>'outcome' = 'paused' as ok;
select 'stop while paused, phone clock 1 h ahead' as t, timer_stop('55555555-0000-0000-0000-000000000010', now() + interval '1 hour', '66666666-0000-0000-0000-000000000010')->>'outcome' = 'stopped'
  and (pg_temp.t('55555555-0000-0000-0000-000000000010')).unsided_seconds = 20*60 and (pg_temp.t('55555555-0000-0000-0000-000000000010')).ended_at <= now() as ok;
select 'tracker of another baby refused' as t, pg_temp.blocked($q$select timer_start('55555555-0000-0000-0000-000000000013','11111111-0000-0000-0000-000000000001','extra','33333333-0000-0000-0000-000000000099',null, now())$q$) as ok;
select 'future start clamped to now' as t, (timer_start('55555555-0000-0000-0000-000000000014','11111111-0000-0000-0000-000000000001','extra','33333333-0000-0000-0000-000000000001',null, now() + interval '2 hours')->'row'->>'started_at')::timestamptz = now() as ok;

-- ---------- no direct writes, outsiders and anon blocked ----------
select 'no direct insert' as t, pg_temp.blocked($q$insert into running_timers (timer_id, baby_id, kind, started_at, created_by, updated_by) values ('55555555-0000-0000-0000-000000000020','11111111-0000-0000-0000-000000000001','feed', now(),'00000000-0000-0000-0000-00000000000c','00000000-0000-0000-0000-00000000000c')$q$) as ok;
select 'no direct update' as t, pg_temp.blocked($q$update running_timers set left_seconds = 0 where timer_id = '55555555-0000-0000-0000-000000000001'$q$) as ok;
select 'helpers not callable' as t, pg_temp.blocked($q$select timer_lock('55555555-0000-0000-0000-000000000004')$q$) as ok;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000f','f@x.fi');
select 'outsider sees nothing' as t, (select count(*) from running_timers) = 0 as ok;
select 'outsider can''t stop' as t, pg_temp.blocked($q$select timer_stop('55555555-0000-0000-0000-000000000004', now(), '66666666-0000-0000-0000-0000000000ff')$q$) as ok;
select 'outsider can''t start for the baby' as t, pg_temp.blocked($q$select timer_start('55555555-0000-0000-0000-000000000030','11111111-0000-0000-0000-000000000001','feed',null,null, now())$q$) as ok;
reset role;
set role anon;
select 'anon can''t call' as t, pg_temp.blocked($q$select timer_pause('55555555-0000-0000-0000-000000000004', now())$q$) as ok;
select 'anon can''t read' as t, pg_temp.blocked($q$select * from running_timers$q$) as ok;
reset role;
delete from baby_profiles where baby_id = '11111111-0000-0000-0000-000000000001';
select 'deleting the baby removes its timers' as t, (select count(*) from running_timers) = 0 as ok;
commit;
