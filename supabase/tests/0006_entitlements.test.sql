\set ON_ERROR_STOP 1
-- run after supabase-stub.sql and migrations 0001–0006
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000a','o@x.fi'),('00000000-0000-0000-0000-00000000000c','c@x.fi'),('00000000-0000-0000-0000-00000000000d','d@x.fi'),('00000000-0000-0000-0000-00000000000e','s@x.fi');
create function pg_temp.as_user(u text, e text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claims', json_build_object('sub',u,'email',e)::text, false); end $$;
-- start after early access so the free rules apply
update app_settings set value = to_jsonb(now() - interval '1 day') where key = 'early_access_until';

set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000a','o@x.fi');
insert into baby_profiles (baby_id,name,date_of_birth,sex,timezone,created_by) values ('11111111-0000-0000-0000-000000000001','Baby','2026-10-01','female','Europe/Helsinki','00000000-0000-0000-0000-00000000000a');
select 'free: no plus' as t, (plus_status('11111111-0000-0000-0000-000000000001')->>'plus')::boolean = false as ok;

-- free family: one caregiver allowed, second invitation refused
insert into baby_access (access_id, baby_id, invited_email, role) values ('22222222-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','c@x.fi','caregiver');
do $$ begin
  insert into baby_access (access_id, baby_id, invited_email, role) values ('22222222-0000-0000-0000-000000000002','11111111-0000-0000-0000-000000000001','d@x.fi','caregiver');
  raise exception 'limit FAIL';
exception when sqlstate 'P0001' then
  if sqlerrm <> 'caregiver_limit' then raise; end if; raise notice 'free caregiver limit ok';
end $$;

-- free: AI not allowed even with consent
update profiles set ai_consent_at = now() where user_id = '00000000-0000-0000-0000-00000000000a';
select 'free: no AI' as t, use_ai_quota('11111111-0000-0000-0000-000000000001') = false as ok;

-- members can't write entitlements or read them directly
do $$ begin insert into entitlements (baby_id, source) values ('11111111-0000-0000-0000-000000000001','manual'); raise exception 'write FAIL';
exception when insufficient_privilege then raise notice 'direct entitlement write blocked ok'; end $$;
do $$ begin perform has_plus('11111111-0000-0000-0000-000000000001'); raise exception 'has_plus FAIL';
exception when insufficient_privilege then raise notice 'has_plus not callable ok'; end $$;

-- trial: refused before 10 logged days
do $$ begin perform start_plus_trial('11111111-0000-0000-0000-000000000001'); raise exception 'trial FAIL';
exception when raise_exception then raise notice 'trial needs logged days ok'; end $$;
-- log a feed on 10 different days
insert into feeding_entries (feed_id,baby_id,feeding_type,start_datetime,quantity_ml,created_by,updated_by)
  select gen_random_uuid(),'11111111-0000-0000-0000-000000000001','formula', now() - make_interval(days => g), 90,'00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000a' from generate_series(0, 9) g;
select 'trial eligible after 10 days' as t, (plus_status('11111111-0000-0000-0000-000000000001')->>'trial_eligible')::boolean as ok;
select 'trial started' as t, (start_plus_trial('11111111-0000-0000-0000-000000000001')->>'plus')::boolean as ok;
select 'trial source' as t, plus_status('11111111-0000-0000-0000-000000000001')->>'source' = 'trial' as ok;
do $$ begin perform start_plus_trial('11111111-0000-0000-0000-000000000001'); raise exception 'second trial FAIL';
exception when raise_exception then if sqlerrm like '%already%' then raise notice 'one trial per baby ok'; else raise; end if; end $$;

-- plus: AI allowed, more caregivers allowed
select 'plus: AI allowed' as t, use_ai_quota('11111111-0000-0000-0000-000000000001') as ok;
insert into baby_access (access_id, baby_id, invited_email, role) values ('22222222-0000-0000-0000-000000000003','11111111-0000-0000-0000-000000000001','d@x.fi','caregiver');
select 'plus: second caregiver' as t, count(*) = 2 as ok from baby_access where role = 'caregiver' and invitation_status = 'pending';

-- caregiver who accepted sees the same Plus state (one subscription per family)
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c','c@x.fi');
select respond_invitation('22222222-0000-0000-0000-000000000001', true);
select 'caregiver inherits plus' as t, (plus_status('11111111-0000-0000-0000-000000000001')->>'plus')::boolean as ok;
-- caregiver can't grab the free slot through the API
update baby_access set keeps_free_access = false where access_id = '22222222-0000-0000-0000-000000000001';
-- the grandparent accepts during the trial
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d','d@x.fi');
select respond_invitation('22222222-0000-0000-0000-000000000003', true);
select 'trial: extra caregiver can read' as t, count(*) = 1 as ok from baby_profiles;
reset role;
select 'free slot = first caregiver' as t, (select keeps_free_access from baby_access where access_id = '22222222-0000-0000-0000-000000000001') and not (select keeps_free_access from baby_access where access_id = '22222222-0000-0000-0000-000000000003') as ok;
set role authenticated;

-- stranger can't read status
select pg_temp.as_user('00000000-0000-0000-0000-00000000000e','s@x.fi');
do $$ begin perform plus_status('11111111-0000-0000-0000-000000000001'); raise exception 'stranger FAIL';
exception when insufficient_privilege then raise notice 'stranger blocked ok'; end $$;
select 'stranger: no AI' as t, use_ai_quota('11111111-0000-0000-0000-000000000001') = false as ok;

-- expired trial → free again; early access → plus for everyone
reset role;
update entitlements set expires_at = now() - interval '1 minute';
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000a','o@x.fi');
select 'expired trial: free' as t, (plus_status('11111111-0000-0000-0000-000000000001')->>'plus')::boolean = false as ok;
-- extra caregiver is paused (not removed); the free-slot caregiver keeps access
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d','d@x.fi');
select 'after trial: extra caregiver paused' as t, count(*) = 0 as ok from baby_profiles;
select 'paused list explains it' as t, count(*) = 1 as ok from my_paused_babies();
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c','c@x.fi');
select 'after trial: free-slot caregiver still in' as t, count(*) = 1 as ok from baby_profiles;
select 'free-slot caregiver: nothing paused' as t, count(*) = 0 as ok from my_paused_babies();
-- owner swaps who keeps the free slot
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a','o@x.fi');
select choose_free_caregiver('22222222-0000-0000-0000-000000000003');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d','d@x.fi');
select 'swap: grandparent back in' as t, count(*) = 1 as ok from baby_profiles;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c','c@x.fi');
select 'swap: other caregiver paused' as t, count(*) = 0 as ok from baby_profiles;
do $$ begin perform choose_free_caregiver('22222222-0000-0000-0000-000000000001'); raise exception 'non-owner choose FAIL';
exception when insufficient_privilege then raise notice 'only owner chooses ok'; end $$;
-- owner removes the slot holder → the remaining caregiver gets it back automatically
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a','o@x.fi');
update baby_access set invitation_status = 'revoked' where access_id = '22222222-0000-0000-0000-000000000003';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c','c@x.fi');
select 'slot refilled after removal' as t, count(*) = 1 as ok from baby_profiles;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a','o@x.fi');
reset role;
update app_settings set value = to_jsonb(now() + interval '30 days') where key = 'early_access_until';
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000a','o@x.fi');
select 'early access: plus' as t, (plus_status('11111111-0000-0000-0000-000000000001')->>'plus')::boolean and (plus_status('11111111-0000-0000-0000-000000000001')->>'early_access')::boolean as ok;
set role anon;
do $$ begin perform plus_status('11111111-0000-0000-0000-000000000001'); raise exception 'anon FAIL'; exception when insufficient_privilege then raise notice 'anon blocked ok'; end $$;
