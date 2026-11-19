-- 0002: robustness for accounts created before 0001 was applied.
-- 1) Backfill missing profile rows from auth.users.
insert into public.profiles (user_id, email, display_name)
select u.id, lower(u.email), coalesce(u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1))
from auth.users u
where u.email is not null and not exists (select 1 from public.profiles p where p.user_id = u.id);

-- 2) Owner row creation no longer depends on the profile row existing.
create or replace function public.handle_new_baby() returns trigger language plpgsql security definer set search_path = public, auth as $$
declare v_email text;
begin
  select coalesce((select email from public.profiles where user_id = new.created_by), (select lower(email) from auth.users where id = new.created_by)) into v_email;
  insert into public.profiles (user_id, email) select new.created_by, v_email
    where v_email is not null and not exists (select 1 from public.profiles where user_id = new.created_by);
  insert into public.baby_access (baby_id, user_id, invited_email, role, invitation_status, invited_by)
  values (new.baby_id, new.created_by, coalesce(v_email, ''), 'owner', 'accepted', new.created_by);
  return new;
end $$;
