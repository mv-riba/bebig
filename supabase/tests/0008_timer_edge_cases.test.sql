\set ON_ERROR_STOP 1
-- Timer edge cases (0008): timers of different kinds at once, several babies at once, outsiders, offline taps.
-- Run after supabase-stub.sql and migrations 0001–0008 (fresh database). Every row must say ok = t.
begin; -- one transaction: now() is the same in every statement
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a','o@x.fi','{}'),   -- owner of both twins
  ('00000000-0000-0000-0000-00000000000c','c@x.fi','{}'),   -- caregiver of twin A only
  ('00000000-0000-0000-0000-00000000000f','f@x.fi','{}');   -- outsider
create function pg_temp.as_user(u text, e text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claims', json_build_object('sub',u,'email',e)::text, false); end $$;
create function pg_temp.blocked(q text) returns boolean language plpgsql as $$ begin execute q; return false; exception when others then return true; end $$;
create function pg_temp.t(id text) returns public.running_timers language sql as $$ select * from public.running_timers where timer_id = id::uuid $$;
create function pg_temp.s(id text) returns public.sleep_entries language sql as $$ select * from public.sleep_entries where sleep_id = id::uuid $$;
create function pg_temp.total(id text) returns double precision language sql as $$ select left_seconds + right_seconds + unsided_seconds from public.running_timers where timer_id = id::uuid $$;

set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000a','o@x.fi');
insert into baby_profiles (baby_id,name,date_of_birth,sex,timezone,created_by) values
  ('11111111-0000-0000-0000-00000000000a','Twin A','2026-10-01','female','Europe/Helsinki','00000000-0000-0000-0000-00000000000a'),
  ('11111111-0000-0000-0000-00000000000b','Twin B','2026-10-01','male','Europe/Helsinki','00000000-0000-0000-0000-00000000000a');
insert into baby_access (access_id, baby_id, invited_email, role) values ('22222222-0000-0000-0000-000000000001','11111111-0000-0000-0000-00000000000a','c@x.fi','caregiver');
insert into extra_trackers (tracker_id, baby_id, name, kind, created_by, updated_by) values
  ('33333333-0000-0000-0000-0000000000a1','11111111-0000-0000-0000-00000000000a','Walk','duration','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000a'),
  ('33333333-0000-0000-0000-0000000000a2','11111111-0000-0000-0000-00000000000a','Tummy time','duration','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000a'),
  ('33333333-0000-0000-0000-0000000000b1','11111111-0000-0000-0000-00000000000b','Walk','duration','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000a'),
  ('33333333-0000-0000-0000-0000000000b2','11111111-0000-0000-0000-00000000000b','Carrier','duration','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000a');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c','c@x.fi'); select respond_invitation('22222222-0000-0000-0000-000000000001', true);
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a','o@x.fi');

-- ---------- one baby: sleep + walk + feed + tummy time all at once ----------
select 'sleep starts' as t, sleep_start('44444444-0000-0000-0000-0000000000a1','11111111-0000-0000-0000-00000000000a', now() - interval '30 minutes')->>'outcome' = 'started' as ok;
select 'walk starts while sleeping (pram nap)' as t, timer_start('55555555-0000-0000-0000-0000000000a1','11111111-0000-0000-0000-00000000000a','extra','33333333-0000-0000-0000-0000000000a1',null, now() - interval '30 minutes')->>'outcome' = 'started' as ok;
select 'feed starts while sleeping and walking' as t, timer_start('55555555-0000-0000-0000-0000000000a2','11111111-0000-0000-0000-00000000000a','feed',null,'left', now() - interval '10 minutes')->>'outcome' = 'started' as ok;
select 'second extras tracker runs too' as t, timer_start('55555555-0000-0000-0000-0000000000a3','11111111-0000-0000-0000-00000000000a','extra','33333333-0000-0000-0000-0000000000a2',null, now() - interval '5 minutes')->>'outcome' = 'started' as ok;
select 'four running at once for one baby' as t, (select count(*) from running_timers where baby_id = '11111111-0000-0000-0000-00000000000a' and ended_at is null) = 3
  and (select count(*) from sleep_entries where baby_id = '11111111-0000-0000-0000-00000000000a' and status <> 'completed') = 1 as ok;
select 'stopping the walk leaves the sleep and feed running' as t, timer_stop('55555555-0000-0000-0000-0000000000a1', now() - interval '2 minutes', '66666666-0000-0000-0000-0000000000a1')->>'outcome' = 'stopped'
  and (pg_temp.s('44444444-0000-0000-0000-0000000000a1')).status = 'active' and (pg_temp.t('55555555-0000-0000-0000-0000000000a2')).ended_at is null as ok;
select 'walk timed 28 minutes' as t, (pg_temp.t('55555555-0000-0000-0000-0000000000a1')).unsided_seconds = 28*60 as ok;
select 'stopping the sleep leaves the feed and tummy time running' as t, sleep_stop('44444444-0000-0000-0000-0000000000a1', now())->>'outcome' = 'stopped'
  and (select count(*) from running_timers where baby_id = '11111111-0000-0000-0000-00000000000a' and ended_at is null) = 2 as ok;
select 'a walk can start again straight after (new timer id)' as t, timer_start('55555555-0000-0000-0000-0000000000a4','11111111-0000-0000-0000-00000000000a','extra','33333333-0000-0000-0000-0000000000a1',null, now())->>'outcome' = 'started' as ok;

-- ---------- twins: everything at once, for both ----------
select 'twin B sleep runs while twin A has timers' as t, sleep_start('44444444-0000-0000-0000-0000000000b1','11111111-0000-0000-0000-00000000000b', now() - interval '20 minutes')->>'outcome' = 'started' as ok;
select 'twin B feed (tandem feeding) runs alongside twin A feed' as t, timer_start('55555555-0000-0000-0000-0000000000b2','11111111-0000-0000-0000-00000000000b','feed',null,'right', now() - interval '10 minutes')->>'outcome' = 'started' as ok;
select 'twin B walk is its own timer (same tracker name, other baby)' as t, timer_start('55555555-0000-0000-0000-0000000000b1','11111111-0000-0000-0000-00000000000b','extra','33333333-0000-0000-0000-0000000000b1',null, now() - interval '20 minutes')->>'outcome' = 'started' as ok;
select 'twin A sleep starts again (twin B sleep unaffected)' as t, sleep_start('44444444-0000-0000-0000-0000000000a2','11111111-0000-0000-0000-00000000000a', now())->>'outcome' = 'started'
  and (pg_temp.s('44444444-0000-0000-0000-0000000000b1')).status = 'active' as ok;
select 'a second sleep timer for twin B joins twin B''s, never twin A''s' as t, (j->>'outcome') = 'joined' and (j->'row'->>'sleep_id') = '44444444-0000-0000-0000-0000000000b1' as ok
  from (select sleep_start('44444444-0000-0000-0000-0000000000b9','11111111-0000-0000-0000-00000000000b', now()) j) x;
select 'a second feed timer for twin A joins twin A''s, never twin B''s' as t, (j->>'outcome') = 'joined' and (j->'row'->>'timer_id') = '55555555-0000-0000-0000-0000000000a2' as ok
  from (select timer_start('55555555-0000-0000-0000-0000000000a9','11111111-0000-0000-0000-00000000000a','feed',null,'left', now()) j) x;
select 'stopping twin A feed leaves twin B feed running' as t, timer_stop('55555555-0000-0000-0000-0000000000a2', now(), '66666666-0000-0000-0000-0000000000a2')->>'outcome' = 'stopped'
  and (pg_temp.t('55555555-0000-0000-0000-0000000000b2')).ended_at is null and (pg_temp.t('55555555-0000-0000-0000-0000000000b2')).side = 'right' as ok;
select 'discarding twin B walk leaves twin A walk running' as t, timer_discard('55555555-0000-0000-0000-0000000000b1')->>'outcome' = 'discarded'
  and (pg_temp.t('55555555-0000-0000-0000-0000000000a4')).ended_at is null as ok;

-- ---------- caregiver of twin A only ----------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c','c@x.fi');
select 'caregiver sees only twin A timers' as t, (select count(*) from running_timers where baby_id = '11111111-0000-0000-0000-00000000000b') = 0
  and (select count(*) from running_timers where baby_id = '11111111-0000-0000-0000-00000000000a') > 0 as ok;
select 'caregiver can''t start a twin B timer' as t, pg_temp.blocked($q$ select timer_start('55555555-0000-0000-0000-0000000000c1','11111111-0000-0000-0000-00000000000b','feed',null,null, now()) $q$) as ok;
select 'caregiver can''t stop twin B feed by its id' as t, pg_temp.blocked($q$ select timer_stop('55555555-0000-0000-0000-0000000000b2', now(), '66666666-0000-0000-0000-0000000000c1') $q$) as ok;
select 'caregiver can''t start a timer on twin B''s tracker under twin A' as t, pg_temp.blocked($q$ select timer_start('55555555-0000-0000-0000-0000000000c2','11111111-0000-0000-0000-00000000000a','extra','33333333-0000-0000-0000-0000000000b1',null, now()) $q$) as ok;
select 'caregiver can''t reuse twin B''s timer id under twin A' as t, pg_temp.blocked($q$ select timer_start('55555555-0000-0000-0000-0000000000b2','11111111-0000-0000-0000-00000000000a','feed',null,null, now()) $q$) as ok;
select 'caregiver can''t start a twin B sleep' as t, pg_temp.blocked($q$ select sleep_start('44444444-0000-0000-0000-0000000000c1','11111111-0000-0000-0000-00000000000b', now()) $q$) as ok;
select 'caregiver can''t stop twin B sleep by its id' as t, pg_temp.blocked($q$ select sleep_stop('44444444-0000-0000-0000-0000000000b1', now()) $q$) as ok;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000f','f@x.fi');
select 'outsider sees no timers' as t, (select count(*) from running_timers) = 0 and (select count(*) from sleep_entries) = 0 as ok;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a','o@x.fi');
select 'twin B feed and sleep untouched by the refused taps' as t, (pg_temp.t('55555555-0000-0000-0000-0000000000b2')).ended_at is null and (pg_temp.s('44444444-0000-0000-0000-0000000000b1')).status = 'active' as ok;

-- ---------- odd inputs ----------
select 'unknown timer kind is refused' as t, pg_temp.blocked($q$ select timer_start('55555555-0000-0000-0000-0000000000d1','11111111-0000-0000-0000-00000000000a','sleep',null,null, now()) $q$) as ok;
select 'extras timer without a tracker is refused' as t, pg_temp.blocked($q$ select timer_start('55555555-0000-0000-0000-0000000000d2','11111111-0000-0000-0000-00000000000a','extra',null,null, now()) $q$) as ok;
select 'feed timer ignores a tracker id and a bad side' as t, (j->>'outcome') = 'started' and (j->'row'->>'tracker_id') is null and (j->'row'->>'side') is null
  and timer_discard('55555555-0000-0000-0000-0000000000d3')->>'outcome' = 'discarded' as ok
  from (select timer_start('55555555-0000-0000-0000-0000000000d3','11111111-0000-0000-0000-00000000000a','feed','33333333-0000-0000-0000-0000000000b1','middle', now()) j) x;
select 'a start time days in the past is clamped to one day' as t, (pg_temp.t('55555555-0000-0000-0000-0000000000a4')).started_at >= now() - interval '1 day'
  and (timer_start('55555555-0000-0000-0000-0000000000d4','11111111-0000-0000-0000-00000000000a','extra','33333333-0000-0000-0000-0000000000a2',null, now() - interval '5 days')->'row'->>'started_at')::timestamptz >= now() - interval '1 day' as ok;
select 'a start time in the future is clamped to now' as t, (timer_start('55555555-0000-0000-0000-0000000000d5','11111111-0000-0000-0000-00000000000b','extra','33333333-0000-0000-0000-0000000000b1',null, now() + interval '3 hours')->'row'->>'started_at')::timestamptz = now() as ok;
update extra_trackers set deleted_at = now(), updated_by = '00000000-0000-0000-0000-00000000000a' where tracker_id = '33333333-0000-0000-0000-0000000000a2';
select 'a tracker deleted while its timer runs: Stop still works' as t,
  timer_stop('55555555-0000-0000-0000-0000000000a3', now(), '66666666-0000-0000-0000-0000000000a3')->>'outcome' = 'stopped' as ok;
select 'a deleted tracker can''t get a new timer' as t, pg_temp.blocked($q$ select timer_start('55555555-0000-0000-0000-0000000000d6','11111111-0000-0000-0000-00000000000a','extra','33333333-0000-0000-0000-0000000000a2',null, now()) $q$) as ok;

-- ---------- offline taps arriving late: the timed total can't exceed the time that passed ----------
-- 0:00 start. Phone 1 pauses at 0:10. Phone 2 (offline, still seeing it running) had tapped Pause at 0:03 and Resume at 0:05;
-- those arrive after phone 1's pause. Stop at 0:20. 20 minutes passed, so the timer must not say more than 20.
select 'late resume: start' as t, timer_start('55555555-0000-0000-0000-0000000000e1','11111111-0000-0000-0000-00000000000b','extra','33333333-0000-0000-0000-0000000000b2',null, now() - interval '20 minutes')->>'outcome' = 'started' as ok;
select 'late resume: phone 1 pauses at 0:10' as t, timer_pause(x.id, now() - interval '10 minutes')->>'outcome' = 'paused' as ok
  from (select timer_id id from running_timers where tracker_id = '33333333-0000-0000-0000-0000000000b2' and ended_at is null) x;
select 'late resume: phone 2 pause at 0:03 is a no-op' as t, timer_pause(x.id, now() - interval '17 minutes')->>'outcome' = 'paused' as ok
  from (select timer_id id from running_timers where tracker_id = '33333333-0000-0000-0000-0000000000b2' and ended_at is null) x;
select 'late resume: phone 2 resume at 0:05' as t, timer_resume(x.id, now() - interval '15 minutes')->>'outcome' = 'resumed' as ok
  from (select timer_id id from running_timers where tracker_id = '33333333-0000-0000-0000-0000000000b2' and ended_at is null) x;
select 'late resume: total never exceeds the time that passed' as t,
  (j->'row'->>'unsided_seconds')::float <= extract(epoch from (now() - (j->'row'->>'started_at')::timestamptz)) as ok
  from (select timer_stop(x.id, now(), '66666666-0000-0000-0000-0000000000e1') j
        from (select timer_id id from running_timers where tracker_id = '33333333-0000-0000-0000-0000000000b2' and ended_at is null) x) y;

-- same for a breastfeeding timer that changes side after a late resume
select 'late side resume: start left' as t, timer_start('55555555-0000-0000-0000-0000000000e2','11111111-0000-0000-0000-00000000000a','feed',null,'left', now() - interval '20 minutes')->>'outcome' = 'started' as ok;
select 'late side resume: pause at 0:10, late resume at 0:05, stop' as t,
  timer_pause('55555555-0000-0000-0000-0000000000e2', now() - interval '10 minutes')->>'outcome' = 'paused'
  and timer_resume('55555555-0000-0000-0000-0000000000e2', now() - interval '15 minutes')->>'outcome' = 'resumed'
  and timer_side('55555555-0000-0000-0000-0000000000e2', 'right', now() - interval '12 minutes')->>'outcome' = 'side'
  and timer_stop('55555555-0000-0000-0000-0000000000e2', now(), '66666666-0000-0000-0000-0000000000e2')->>'outcome' = 'stopped' as ok;
select 'late side resume: total never exceeds the time that passed' as t, pg_temp.total('55555555-0000-0000-0000-0000000000e2') <= 20*60 as ok;
-- "Finished earlier" / "Woke up earlier": a stop with an earlier end time counts only up to that time
select 'feed left on 2 h, finished after 25 min: 25 min counted' as t,
  timer_start('55555555-0000-0000-0000-0000000000f1','11111111-0000-0000-0000-00000000000b','extra','33333333-0000-0000-0000-0000000000b2',null, now() - interval '2 hours')->>'outcome' = 'started'
  and (timer_stop('55555555-0000-0000-0000-0000000000f1', now() - interval '95 minutes', '66666666-0000-0000-0000-0000000000f1')->'row'->>'unsided_seconds')::float = 25*60 as ok;
select 'sleep left on 14 h, woke after 6 h: 6 h saved' as t,
  sleep_start('44444444-0000-0000-0000-0000000000f1','11111111-0000-0000-0000-00000000000b', now() - interval '14 hours')->>'outcome' in ('started','joined') as ok;
select 'sleep left on: stop at the real wake-up time' as t, (j->>'outcome') = 'stopped' and (j->'row'->>'end_datetime')::timestamptz = (j->'row'->>'start_datetime')::timestamptz + interval '6 hours' as ok
  from (select sleep_stop(x.sleep_id, x.start_datetime + interval '6 hours') j from sleep_entries x where baby_id = '11111111-0000-0000-0000-00000000000b' and status <> 'completed' and deleted_at is null) y;
rollback;
