\set ON_ERROR_STOP 1
\set O '\'00000000-0000-0000-0000-00000000000a\''
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000a','o@x.fi'),('00000000-0000-0000-0000-00000000000c','c@x.fi'),('00000000-0000-0000-0000-00000000000e','s@x.fi');
create function pg_temp.as_user(u text, e text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claims', json_build_object('sub',u,'email',e)::text, false); end $$;
-- owner creates baby + invites caregiver
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000a','o@x.fi');
insert into baby_profiles (baby_id,name,date_of_birth,sex,timezone,created_by) values ('11111111-0000-0000-0000-000000000001','Baby','2026-10-01','female','Europe/Helsinki','00000000-0000-0000-0000-00000000000a');
insert into baby_access (access_id, baby_id, invited_email, role) values ('22222222-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','c@x.fi','caregiver');
-- caregiver accepts, logs a feed
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c','c@x.fi');
select respond_invitation('22222222-0000-0000-0000-000000000001', true);
insert into feeding_entries (feed_id,baby_id,feeding_type,start_datetime,quantity_ml,created_by,updated_by) values ('33333333-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','formula',now(),90,'00000000-0000-0000-0000-00000000000c','00000000-0000-0000-0000-00000000000c');
-- H1 attack: caregiver claims creation (plain update and upsert)
update baby_profiles set created_by='00000000-0000-0000-0000-00000000000c' where baby_id='11111111-0000-0000-0000-000000000001';
insert into baby_profiles (baby_id,name,date_of_birth,sex,timezone,created_by) values ('11111111-0000-0000-0000-000000000001','Baby','2026-10-01','female','Europe/Helsinki','00000000-0000-0000-0000-00000000000c') on conflict (baby_id) do update set created_by = excluded.created_by;
select 'H1 created_by still owner' as t, created_by = '00000000-0000-0000-0000-00000000000a' as ok from baby_profiles;
-- M3: external photo rejected
do $$ begin update baby_profiles set photograph_url='https://evil.example/p.png'; raise exception 'M3 FAIL'; exception when check_violation then raise notice 'M3 ok: external photo rejected'; end $$;
update baby_profiles set photograph_url='data:image/jpeg;base64,AAAA';
-- L3: email edit ignored; consent timestamp set by server
update profiles set email='fake@x.fi', ai_consent_at='2000-01-01' where user_id='00000000-0000-0000-0000-00000000000c';
select 'L3/M1 profile' as t, email='c@x.fi' as email_ok, ai_consent_at > now() - interval '1 minute' as consent_server_time from profiles where user_id='00000000-0000-0000-0000-00000000000c';
select 'M1 quota with consent' as t, use_ai_quota() as ok;
-- owner revokes, and tries to force-add stranger
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a','o@x.fi');
update baby_access set invitation_status='revoked' where access_id='22222222-0000-0000-0000-000000000001';
insert into baby_access (access_id, baby_id, invited_email, role) values ('22222222-0000-0000-0000-000000000002','11111111-0000-0000-0000-000000000001','s@x.fi','caregiver');
update baby_access set user_id='00000000-0000-0000-0000-00000000000e', invitation_status='accepted' where access_id='22222222-0000-0000-0000-000000000002';
select 'L1 forced accept ignored' as t, invitation_status='pending' and user_id is null as ok from baby_access where access_id='22222222-0000-0000-0000-000000000002';
select 'M1 quota without consent' as t, use_ai_quota() = false as ok;
-- revoked caregiver can no longer read baby
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c','c@x.fi');
select 'H1 revoked cannot read baby' as t, count(*) = 0 as ok from baby_profiles;
-- re-invite + accept so the caregiver is a member with entries, then delete account
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a','o@x.fi');
insert into baby_access (access_id, baby_id, invited_email, role) values ('22222222-0000-0000-0000-000000000003','11111111-0000-0000-0000-000000000001','c@x.fi','caregiver');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c','c@x.fi');
select respond_invitation('22222222-0000-0000-0000-000000000003', true);
select delete_my_account();
reset role;
select 'H2 caregiver deleted' as t, not exists (select 1 from auth.users where email='c@x.fi') as ok;
select 'H2 feed kept, unattributed' as t, created_by is null and updated_by is null as ok from feeding_entries;
select 'H2 no access rows with email' as t, count(*)=0 as ok from baby_access where invited_email='c@x.fi';
select 'L4 audit scrubbed' as t, count(*)=0 as ok from audit_log where detail->>'email'='c@x.fi' or actor='00000000-0000-0000-0000-00000000000c';
-- anon can't call
set role anon;
do $$ begin perform delete_my_account(); raise exception 'anon FAIL'; exception when insufficient_privilege then raise notice 'anon blocked ok'; end $$;
-- owner deletion removes baby and everything
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000a','o@x.fi');
select delete_my_account();
reset role;
select 'owner deletion' as t, (select count(*) from baby_profiles)=0 and (select count(*) from feeding_entries)=0 and not exists(select 1 from auth.users where email='o@x.fi') as ok;
