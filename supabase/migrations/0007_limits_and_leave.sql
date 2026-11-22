-- 0007: audit of 22 Nov 2026 (see "Bebig code & security audit — 22 Nov 2026"). Run after 0006.
-- Close Bebig on all devices first (or rely on the lock timeout below: it fails cleanly instead of deadlocking).
-- No existing data is changed. New size limits are NOT VALID: they apply to new and edited rows only.
--
--  S1  Size limits on fields that had none (feed observations, sleep pauses, display names, invitation emails,
--      AI messages). Any signed-in account could otherwise fill the free plan's 500 MB database.
--  S2  A baby's time zone must be a real IANA zone. An invalid one (settable by any caregiver) broke
--      plus_status(), the trial and logged-day counting for the whole family.
--  S3  At most 20 baby profiles per account (stops bulk-creating profiles; real families are far below this).
--  S4  Caregivers can leave a profile themselves (leave_baby). The app already told them they could.
--  S6  keeps_free_access really is server-maintained: the guard in 0006's maintain_free_slot() never ran, because
--      current_user inside a security definer function is its owner. The guard now lives in the (invoker)
--      protect_access_update() trigger. No impact so far: only owners can update access rows, and one slot per baby.
--  S5  The caregiver-limit check no longer runs for non-owners, so it can't reveal anything about a profile
--      to someone who isn't its owner (row-level security rejects them as before).

set local lock_timeout = '15s';
lock table public.baby_profiles, public.baby_access, public.profiles, public.feeding_entries, public.sleep_entries,
  public.ai_conversation_messages in access exclusive mode;

-- ---------- S1: size limits ----------
alter table public.feeding_entries drop constraint if exists feeding_observations_size;
alter table public.feeding_entries add constraint feeding_observations_size check (
  coalesce(array_length(observations, 1), 0) <= 20 and length(array_to_string(observations, '')) <= 1000) not valid;

alter table public.sleep_entries drop constraint if exists sleep_pauses_size;
alter table public.sleep_entries add constraint sleep_pauses_size check (
  jsonb_typeof(pauses) = 'array' and jsonb_array_length(pauses) <= 500 and pg_column_size(pauses) <= 65536) not valid;

alter table public.profiles drop constraint if exists profiles_display_name_size;
alter table public.profiles add constraint profiles_display_name_size check (length(display_name) <= 80) not valid;

alter table public.baby_access drop constraint if exists baby_access_email_size;
alter table public.baby_access add constraint baby_access_email_size check (length(invited_email) <= 254) not valid;

alter table public.ai_conversation_messages drop constraint if exists ai_message_size;
alter table public.ai_conversation_messages add constraint ai_message_size check (length(content) <= 8000) not valid;

-- sign-up metadata is free text too: keep the name it creates within the limit
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, email, display_name)
  values (new.id, lower(new.email), left(coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), split_part(new.email, '@', 1)), 80));
  return new;
end $$;

-- ---------- S2 + S3: baby profile checks ----------
create or replace function public.check_baby_profile() returns trigger language plpgsql set search_path = public as $$
begin
  -- raises "time zone ... not recognized" for anything that isn't a real zone
  perform now() at time zone new.timezone;
  if tg_op = 'INSERT' and current_user in ('anon', 'authenticated')
     and (select count(*) from baby_profiles where created_by = new.created_by) >= 20 then
    raise exception using errcode = 'P0001', message = 'baby_limit', detail = 'An account can create up to 20 baby profiles.';
  end if;
  return new;
end $$;
drop trigger if exists baby_check on public.baby_profiles;
create trigger baby_check before insert or update of timezone on public.baby_profiles for each row execute function public.check_baby_profile();

-- ---------- S4: leaving a profile ----------
-- A caregiver ends their own access. Everything they logged stays with the baby. The owner can't leave
-- (they delete the profile or their account instead). Re-joining needs a new invitation.
create or replace function public.leave_baby(b uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if exists (select 1 from baby_access where baby_id = b and user_id = auth.uid() and role = 'owner' and invitation_status = 'accepted') then
    raise exception 'The owner can’t leave their own profile. Delete it instead.';
  end if;
  update baby_access set invitation_status = 'revoked', updated_at = now()
    where baby_id = b and user_id = auth.uid() and role = 'caregiver' and invitation_status = 'accepted';
  if not found then raise exception 'You’re not a caregiver on this profile'; end if;
end $$;

-- ---------- S5: caregiver limit only for owners ----------
create or replace function public.check_caregiver_limit() returns trigger language plpgsql security definer set search_path = public as $$
declare n integer; lim integer;
begin
  if new.role <> 'caregiver' or new.invitation_status not in ('pending', 'accepted') then return new; end if;
  -- (current_user is this function's owner here, so the caller is identified by auth.uid(), not the role)
  if auth.uid() is not null and not is_owner(new.baby_id) then return new; end if; -- row-level security rejects it
  select count(*) into n from baby_access where baby_id = new.baby_id and role = 'caregiver' and invitation_status in ('pending', 'accepted');
  lim := case when has_plus(new.baby_id) then limit_value('plus_caregivers') else limit_value('free_caregivers') end;
  if n >= lim then
    raise exception using errcode = 'P0001', message = 'caregiver_limit',
      detail = format('This family can have up to %s caregiver%s on its current plan.', lim, case when lim = 1 then '' else 's' end);
  end if;
  return new;
end $$;

-- ---------- S6: free slot can't be set through the API ----------
create or replace function public.protect_access_update() returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') then
    -- identity of an invitation is fixed; accepting/declining only happens through respond_invitation()
    new.baby_id := old.baby_id;
    new.user_id := old.user_id;
    new.invited_email := old.invited_email;
    new.invited_by := old.invited_by;
    new.created_at := old.created_at;
    if new.invitation_status is distinct from old.invitation_status and new.invitation_status <> 'revoked' then
      new.invitation_status := old.invitation_status;
    end if;
    -- the free slot changes only through choose_free_caregiver() or when someone leaves (maintain_free_slot)
    if new.invitation_status is not distinct from old.invitation_status then new.keeps_free_access := old.keeps_free_access; end if;
  end if;
  return new;
end $$;

-- ---------- privileges ----------
revoke all on function public.leave_baby(uuid) from public, anon;
grant execute on function public.leave_baby(uuid) to authenticated;
revoke execute on function public.check_baby_profile() from public, anon, authenticated;
