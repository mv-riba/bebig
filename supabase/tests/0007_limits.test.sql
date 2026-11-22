\set ON_ERROR_STOP 1
-- run after supabase-stub.sql and migrations 0001–0007 (fresh database)
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-00000000000a','o@x.fi','{}'),('00000000-0000-0000-0000-00000000000c','c@x.fi','{}'),('00000000-0000-0000-0000-00000000000e','e@x.fi', jsonb_build_object('display_name', repeat('n', 500)));
create function pg_temp.as_user(u text, e text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claims', json_build_object('sub',u,'email',e)::text, false); end $$;
create function pg_temp.blocked(q text) returns boolean language plpgsql as $$ begin execute q; return false; exception when others then return true; end $$;
select 'long sign-up name is trimmed' as t, length(display_name) = 80 as ok from profiles where user_id = '00000000-0000-0000-0000-00000000000e';

set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000a','o@x.fi');
insert into baby_profiles (baby_id,name,date_of_birth,sex,timezone,created_by) values ('11111111-0000-0000-0000-000000000001','Baby','2026-10-01','female','Europe/Helsinki','00000000-0000-0000-0000-00000000000a');
insert into baby_access (access_id, baby_id, invited_email, role) values ('22222222-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','c@x.fi','caregiver');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c','c@x.fi'); select respond_invitation('22222222-0000-0000-0000-000000000001', true);

-- S1 size limits (normal rows still fine)
insert into feeding_entries (feed_id,baby_id,feeding_type,start_datetime,quantity_ml,observations,created_by,updated_by) values ('33333333-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','formula',now(),90,'{Hungry,"Fell asleep during feeding"}','00000000-0000-0000-0000-00000000000c','00000000-0000-0000-0000-00000000000c');
select 'S1 huge observations blocked' as t, pg_temp.blocked($q$update feeding_entries set observations = (select array_agg('x') from generate_series(1,21))$q$) as ok;
insert into sleep_entries (sleep_id,baby_id,start_datetime,end_datetime,status,pauses,created_by,updated_by) values ('44444444-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001',now()-interval '1h',now(),'completed','[{"start":"2026-11-22T10:00:00Z","end":"2026-11-22T10:05:00Z"}]','00000000-0000-0000-0000-00000000000c','00000000-0000-0000-0000-00000000000c');
select 'S1 huge pauses blocked' as t, pg_temp.blocked($q$update sleep_entries set pauses = (select jsonb_agg(jsonb_build_object('start', repeat('y',50))) from generate_series(1,1000))$q$) as ok;
select 'S1 pauses must be a list' as t, pg_temp.blocked($q$update sleep_entries set pauses = '{"a":1}'$q$) as ok;
select 'S1 huge display name blocked' as t, pg_temp.blocked($q$update profiles set display_name = repeat('z', 81) where user_id = '00000000-0000-0000-0000-00000000000c'$q$) as ok;

-- S2 time zone
select 'S2 invalid zone blocked' as t, pg_temp.blocked($q$update baby_profiles set timezone = 'Not/AZone'$q$) as ok;
update baby_profiles set timezone = 'Europe/London';
select 'S2 valid zone ok, plus_status works' as t, plus_status('11111111-0000-0000-0000-000000000001') ? 'plus' as ok;

-- S6 owner can't hand out the free slot by a plain update (only via choose_free_caregiver)
reset role; update app_settings set value = to_jsonb(now() - interval '1 day') where key = 'early_access_until';
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000d','d@x.fi');
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000a','o@x.fi');
select 'S5 owner still limited on free plan' as t, pg_temp.blocked($q$insert into baby_access (baby_id, invited_email, role) values ('11111111-0000-0000-0000-000000000001','d@x.fi','caregiver')$q$) as ok;
update baby_access set keeps_free_access = false where access_id = '22222222-0000-0000-0000-000000000001';
select 'S6 slot unchanged by plain update' as t, keeps_free_access as ok from baby_access where access_id = '22222222-0000-0000-0000-000000000001';
reset role; update app_settings set value = '"2027-03-31T21:00:00Z"' where key = 'early_access_until'; set role authenticated;

-- S5 outsider learns nothing from the limit check: plain RLS error
select pg_temp.as_user('00000000-0000-0000-0000-00000000000e','e@x.fi');
do $$ begin
  insert into baby_access (baby_id, invited_email, role) values ('11111111-0000-0000-0000-000000000001','e@x.fi','caregiver'); raise exception 'S5 FAIL';
exception when insufficient_privilege then raise notice 'S5 ok: outsider gets RLS error only'; end $$;

-- S3 baby limit
insert into baby_profiles (baby_id,name,date_of_birth,sex,timezone,created_by) select gen_random_uuid(),'b'||g,'2026-10-01','male','UTC','00000000-0000-0000-0000-00000000000e' from generate_series(1,20) g;
select 'S3 21st baby blocked' as t, pg_temp.blocked($q$insert into baby_profiles (baby_id,name,date_of_birth,sex,timezone,created_by) values (gen_random_uuid(),'x','2026-10-01','male','UTC','00000000-0000-0000-0000-00000000000e')$q$) as ok;

-- S4 leaving
select 'S4 outsider cannot leave' as t, pg_temp.blocked($q$select leave_baby('11111111-0000-0000-0000-000000000001')$q$) as ok;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a','o@x.fi');
select 'S4 owner cannot leave' as t, pg_temp.blocked($q$select leave_baby('11111111-0000-0000-0000-000000000001')$q$) as ok;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c','c@x.fi');
select leave_baby('11111111-0000-0000-0000-000000000001');
select 'S4 caregiver left: no access, entries kept' as t, (select count(*) from baby_profiles) = 0 and (select count(*) from feeding_entries) = 0 as ok;
reset role;
select 'S4 entries still with the baby' as t, (select count(*) from feeding_entries where baby_id = '11111111-0000-0000-0000-000000000001') = 1 and (select invitation_status from baby_access where access_id = '22222222-0000-0000-0000-000000000001') = 'revoked' as ok;
set role anon;
do $$ begin perform leave_baby('11111111-0000-0000-0000-000000000001'); raise exception 'anon FAIL'; exception when insufficient_privilege then raise notice 'anon blocked ok'; end $$;
