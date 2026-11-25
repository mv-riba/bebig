-- 0011: caregiver invitation emails (25 Nov 2026). Run after 0010.
-- The send-invite Edge Function calls claim_invite_email() as the signed-in owner. It checks that the caller owns the
-- baby, that the invitation is still pending and the limits (1 email per invitation per 24 h, 20 per owner per 24 h),
-- records the send in audit_log, and returns what the email needs. The function never gets the service-role key,
-- and the email address always comes from the invitation row, never from the caller.
-- If Resend refuses the email, release_invite_email() removes that claim so the owner can try again.
-- Only adds functions: no table locks, safe to run while Bebig is open.

create or replace function public.claim_invite_email(p_access_id uuid)
returns table (status text, invited_email text, inviter_name text, baby_name text)
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); r baby_access%rowtype;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select * into r from baby_access a where a.access_id = p_access_id;
  if not found then return query select 'not_found', null::text, null::text, null::text; return; end if;
  if not exists (select 1 from baby_access o where o.baby_id = r.baby_id and o.user_id = v_uid
                 and o.role = 'owner' and o.invitation_status = 'accepted') then
    return query select 'forbidden', null::text, null::text, null::text; return;
  end if;
  if r.invitation_status <> 'pending' then return query select 'not_pending', null::text, null::text, null::text; return; end if;
  if exists (select 1 from audit_log l where l.action = 'access.invite_emailed' and l.at > now() - interval '24 hours'
             and l.detail->>'access_id' = p_access_id::text) then
    return query select 'already_sent', null::text, null::text, null::text; return;
  end if;
  if (select count(*) from audit_log l where l.action = 'access.invite_emailed' and l.at > now() - interval '24 hours'
      and l.actor = v_uid) >= 20 then
    return query select 'daily_limit', null::text, null::text, null::text; return;
  end if;
  insert into audit_log (actor, baby_id, action, detail)
    values (v_uid, r.baby_id, 'access.invite_emailed', jsonb_build_object('access_id', p_access_id));
  return query select 'ok', r.invited_email,
    (select left(coalesce(nullif(trim(p.display_name), ''), split_part(p.email, '@', 1)), 80) from profiles p where p.user_id = v_uid),
    (select b.name from baby_profiles b where b.baby_id = r.baby_id);
end $$;

create or replace function public.release_invite_email(p_access_id uuid) returns void
language sql security definer set search_path = public as $$
  delete from audit_log where action = 'access.invite_emailed' and actor = auth.uid()
    and detail->>'access_id' = p_access_id::text and at > now() - interval '10 minutes';
$$;

revoke all on function public.claim_invite_email(uuid), public.release_invite_email(uuid) from public, anon;
grant execute on function public.claim_invite_email(uuid), public.release_invite_email(uuid) to authenticated;
