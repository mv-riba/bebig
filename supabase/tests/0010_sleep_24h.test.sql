\set ON_ERROR_STOP 1
-- 0010: no sleep over 24 hours. Run after supabase-stub.sql and migrations 0001–0010 (fresh database). Every row must say ok = t.
begin;
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-00000000000a','o@x.fi','{}');
create function pg_temp.blocked(q text) returns boolean language plpgsql as $$ begin execute q; return false; exception when others then return true; end $$;
set role authenticated; select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","email":"o@x.fi"}', false);
insert into baby_profiles (baby_id,name,date_of_birth,sex,timezone,created_by) values ('11111111-0000-0000-0000-00000000000a','A','2026-10-01','female','Europe/Helsinki','00000000-0000-0000-0000-00000000000a');
select 'a sleep timer started 23 h ago stops' as t, sleep_start('44444444-0000-0000-0000-000000000001','11111111-0000-0000-0000-00000000000a', now() - interval '23 hours')->>'outcome' = 'started'
  and sleep_stop('44444444-0000-0000-0000-000000000001', now())->>'outcome' = 'stopped' as ok;
-- sleep_start clamps a start to one day ago, so a 25-hour timer is made by moving the start back afterwards (as if started long ago)
select 'setup: a timer running for 25 h' as t, sleep_start('44444444-0000-0000-0000-000000000002','11111111-0000-0000-0000-00000000000a', now())->>'outcome' = 'started' as ok;
update sleep_entries set start_datetime = now() - interval '25 hours' where sleep_id = '44444444-0000-0000-0000-000000000002';
select 'a 25-hour sleep timer can''t be stopped as is' as t, pg_temp.blocked($q$ select sleep_stop('44444444-0000-0000-0000-000000000002', now()) $q$) as ok;
select '... but it can be discarded' as t, sleep_discard('44444444-0000-0000-0000-000000000002')->>'outcome' = 'discarded' as ok;
select 'a typed-in 24 h sleep is allowed' as t, not pg_temp.blocked($q$ insert into sleep_entries (sleep_id, baby_id, start_datetime, end_datetime, status, created_by, updated_by) values ('44444444-0000-0000-0000-000000000003','11111111-0000-0000-0000-00000000000a', now() - interval '24 hours', now(), 'completed','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000a') $q$) as ok;
select 'a typed-in 25 h sleep is refused' as t, pg_temp.blocked($q$ insert into sleep_entries (sleep_id, baby_id, start_datetime, end_datetime, status, created_by, updated_by) values ('44444444-0000-0000-0000-000000000004','11111111-0000-0000-0000-00000000000a', now() - interval '25 hours', now(), 'completed','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000a') $q$) as ok;
select 'an edit stretching a sleep past 24 h is refused' as t, pg_temp.blocked($q$ update sleep_entries set start_datetime = start_datetime - interval '2 hours' where sleep_id = '44444444-0000-0000-0000-000000000001' $q$) as ok;
rollback;
