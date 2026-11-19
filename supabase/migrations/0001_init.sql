-- Bebig initial schema (PostgreSQL / Supabase)
-- Principles: UTC timestamptz storage + IANA zone on the profile, explicit units in column names,
-- client-generated UUID primary keys (idempotent offline sync), soft delete for activity rows,
-- row-level security on every table, and an audit log for access events.

create extension if not exists "pgcrypto";

-- ---------- helpers ----------
create or replace function public.touch_server_updated_at() returns trigger language plpgsql as $$
begin new.server_updated_at := now(); return new; end $$;

-- ---------- profiles (public part of auth.users) ----------
create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  server_updated_at timestamptz not null default now()
);
create trigger profiles_touch before insert or update on public.profiles for each row execute function public.touch_server_updated_at();

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, email, display_name)
  values (new.id, lower(new.email), coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ---------- baby profiles ----------
create table public.baby_profiles (
  baby_id uuid primary key,
  name text not null check (length(trim(name)) between 1 and 80),
  date_of_birth date not null,
  time_of_birth time,
  sex text not null check (sex in ('male','female')),
  gestational_age_weeks smallint check (gestational_age_weeks between 22 and 44),
  gestational_age_days smallint check (gestational_age_days between 0 and 6),
  timezone text not null check (length(timezone) between 1 and 64),
  photograph_url text,
  feeding_preference text not null default 'breast' check (feeding_preference in ('breast','formula','combination')),
  birth_weight_grams integer check (birth_weight_grams between 300 and 7000),
  birth_length_mm integer check (birth_length_mm between 250 and 650),
  birth_head_circumference_mm integer check (birth_head_circumference_mm between 200 and 450),
  created_by uuid not null references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  server_updated_at timestamptz not null default now()
);
create trigger baby_touch before insert or update on public.baby_profiles for each row execute function public.touch_server_updated_at();

-- ---------- access / invitations ----------
create table public.baby_access (
  access_id uuid primary key default gen_random_uuid(),
  baby_id uuid not null references public.baby_profiles(baby_id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  invited_email text not null check (invited_email = lower(invited_email)),
  role text not null check (role in ('owner','caregiver')),
  invitation_status text not null default 'pending' check (invitation_status in ('pending','accepted','revoked','declined')),
  invited_by uuid not null references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  server_updated_at timestamptz not null default now()
);
create unique index baby_access_one_active on public.baby_access (baby_id, invited_email) where invitation_status in ('pending','accepted');
create unique index baby_access_one_owner on public.baby_access (baby_id) where role = 'owner';
create index baby_access_user on public.baby_access (user_id) where invitation_status = 'accepted';
create trigger access_touch before insert or update on public.baby_access for each row execute function public.touch_server_updated_at();

-- membership helpers (security definer so RLS policies can use them without recursion)
create or replace function public.is_member(b uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from baby_access where baby_id = b and user_id = auth.uid() and invitation_status = 'accepted') $$;
create or replace function public.is_owner(b uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from baby_access where baby_id = b and user_id = auth.uid() and invitation_status = 'accepted' and role = 'owner') $$;

-- creator automatically becomes owner
create or replace function public.handle_new_baby() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into baby_access (baby_id, user_id, invited_email, role, invitation_status, invited_by)
  values (new.baby_id, new.created_by, (select email from profiles where user_id = new.created_by), 'owner', 'accepted', new.created_by);
  return new;
end $$;
create trigger on_baby_created after insert on public.baby_profiles for each row execute function public.handle_new_baby();

-- ---------- activity ----------
create table public.feeding_entries (
  feed_id uuid primary key,
  baby_id uuid not null references public.baby_profiles(baby_id) on delete cascade,
  feeding_type text not null check (feeding_type in ('breast','expressed','formula')),
  start_datetime timestamptz not null,
  end_datetime timestamptz,
  duration_seconds integer check (duration_seconds between 0 and 14400),
  left_duration_seconds integer check (left_duration_seconds between 0 and 14400),
  right_duration_seconds integer check (right_duration_seconds between 0 and 14400),
  quantity_ml numeric(6,1) check (quantity_ml > 0 and quantity_ml <= 500),
  observations text[] not null default '{}',
  notes text check (length(notes) <= 2000),
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now(),
  check (end_datetime is null or end_datetime >= start_datetime),
  -- completed bottle feeds require a quantity; breastfeeding never stores a volume
  check ((feeding_type = 'breast' and quantity_ml is null) or (feeding_type <> 'breast' and quantity_ml is not null))
);
create index feeding_baby_time on public.feeding_entries (baby_id, start_datetime);

create table public.poo_entries (
  poo_id uuid primary key,
  baby_id uuid not null references public.baby_profiles(baby_id) on delete cascade,
  datetime timestamptz not null,
  colour text check (colour in ('yellow','green','brown','pale','black','red','other')),
  size text check (size in ('small','medium','large')),
  texture text check (texture in ('soft','loose','firm','other')),
  notes text check (length(notes) <= 2000),
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now()
);
create index poo_baby_time on public.poo_entries (baby_id, datetime);

create table public.sleep_entries (
  sleep_id uuid primary key,
  baby_id uuid not null references public.baby_profiles(baby_id) on delete cascade,
  start_datetime timestamptz not null,
  end_datetime timestamptz,
  duration_seconds integer check (duration_seconds >= 0),
  status text not null check (status in ('active','paused','completed')),
  pauses jsonb not null default '[]'::jsonb, -- [{start, end}] paused periods excluded from duration
  notes text check (length(notes) <= 2000),
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now(),
  check (end_datetime is null or end_datetime > start_datetime),
  check ((status = 'completed') = (end_datetime is not null))
);
create index sleep_baby_time on public.sleep_entries (baby_id, start_datetime);
-- at most one running timer per baby
create unique index sleep_one_active on public.sleep_entries (baby_id) where status <> 'completed' and deleted_at is null;

create table public.growth_measurements (
  measurement_id uuid primary key,
  baby_id uuid not null references public.baby_profiles(baby_id) on delete cascade,
  measurement_date date not null,
  weight_grams integer check (weight_grams between 300 and 25000),
  length_mm integer check (length_mm between 250 and 1100),
  head_circumference_mm integer check (head_circumference_mm between 200 and 550),
  notes text check (length(notes) <= 2000),
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now(),
  check (weight_grams is not null or length_mm is not null or head_circumference_mm is not null)
);
create index growth_baby_date on public.growth_measurements (baby_id, measurement_date);

do $$ declare t text; begin
  foreach t in array array['feeding_entries','poo_entries','sleep_entries','growth_measurements'] loop
    execute format('create trigger %1$s_touch before insert or update on public.%1$s for each row execute function public.touch_server_updated_at()', t);
  end loop;
end $$;

-- ---------- AI (stored insights & conversations, used by the server-side assistant) ----------
create table public.ai_insights (
  insight_id uuid primary key default gen_random_uuid(),
  baby_id uuid not null references public.baby_profiles(baby_id) on delete cascade,
  insight_type text not null check (insight_type in ('observation','prediction')),
  category text not null,
  description text not null,
  evidence_level text not null check (evidence_level in ('preliminary','emerging','recurring')),
  observation_count integer not null,
  date_range_start date, date_range_end date,
  generated_at timestamptz not null default now(),
  expires_at timestamptz
);
create table public.ai_conversations (
  conversation_id uuid primary key default gen_random_uuid(),
  baby_id uuid not null references public.baby_profiles(baby_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  created_at timestamptz not null default now()
);
create table public.ai_conversation_messages (
  message_id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations(conversation_id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

-- ---------- audit ----------
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid default auth.uid(),
  baby_id uuid,
  action text not null,
  detail jsonb
);
create or replace function public.audit_access() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log (baby_id, action, detail) values (coalesce(new.baby_id, old.baby_id), 'access.' || lower(tg_op),
    jsonb_build_object('email', coalesce(new.invited_email, old.invited_email), 'status', new.invitation_status, 'role', new.role));
  return coalesce(new, old);
end $$;
create trigger access_audit after insert or update or delete on public.baby_access for each row execute function public.audit_access();

-- ---------- RLS ----------
alter table public.profiles enable row level security;
alter table public.baby_profiles enable row level security;
alter table public.baby_access enable row level security;
alter table public.feeding_entries enable row level security;
alter table public.poo_entries enable row level security;
alter table public.sleep_entries enable row level security;
alter table public.growth_measurements enable row level security;
alter table public.ai_insights enable row level security;
alter table public.ai_conversations enable row level security;
alter table public.ai_conversation_messages enable row level security;
alter table public.audit_log enable row level security; -- no policies: only service role can read

-- profiles: yourself, and people you share a baby with
create policy profiles_self on public.profiles for select using (
  user_id = auth.uid() or exists (
    select 1 from baby_access a join baby_access b on a.baby_id = b.baby_id
    where a.user_id = auth.uid() and a.invitation_status = 'accepted' and b.user_id = profiles.user_id and b.invitation_status = 'accepted'));
create policy profiles_update on public.profiles for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- babies: members read; anyone signed in may create (as themselves); members update; owner deletes
create policy baby_select on public.baby_profiles for select using (public.is_member(baby_id) or created_by = auth.uid());
create policy baby_insert on public.baby_profiles for insert with check (created_by = auth.uid());
create policy baby_update on public.baby_profiles for update using (public.is_member(baby_id)) with check (public.is_member(baby_id));
create policy baby_delete on public.baby_profiles for delete using (public.is_owner(baby_id));

-- access: members see the member list; invitees see their own invitation; only owners invite/revoke
create policy access_select on public.baby_access for select using (public.is_member(baby_id) or invited_email = lower(auth.jwt()->>'email'));
create policy access_insert on public.baby_access for insert with check (public.is_owner(baby_id) and role = 'caregiver' and invitation_status = 'pending' and user_id is null);
create policy access_update on public.baby_access for update using (public.is_owner(baby_id) and role <> 'owner') with check (role = 'caregiver');

-- invitees respond through this function (cannot be done with a plain update by a non-owner)
create or replace function public.respond_invitation(p_access_id uuid, p_accept boolean) returns void language plpgsql security definer set search_path = public as $$
begin
  update baby_access set invitation_status = case when p_accept then 'accepted' else 'declined' end,
         user_id = case when p_accept then auth.uid() else null end, updated_at = now()
  where access_id = p_access_id and invitation_status = 'pending' and invited_email = lower(auth.jwt()->>'email');
  if not found then raise exception 'Invitation not found or no longer valid'; end if;
end $$;
revoke all on function public.respond_invitation(uuid, boolean) from public;
grant execute on function public.respond_invitation(uuid, boolean) to authenticated;

-- activity tables: members can read/create/update; deletes are soft (update deleted_at); owner can hard-delete
do $$ declare t text; begin
  foreach t in array array['feeding_entries','poo_entries','sleep_entries','growth_measurements'] loop
    execute format('create policy %1$s_select on public.%1$s for select using (public.is_member(baby_id))', t);
    execute format('create policy %1$s_insert on public.%1$s for insert with check (public.is_member(baby_id) and created_by = auth.uid() and updated_by = auth.uid())', t);
    execute format('create policy %1$s_update on public.%1$s for update using (public.is_member(baby_id)) with check (public.is_member(baby_id) and updated_by = auth.uid())', t);
    execute format('create policy %1$s_delete on public.%1$s for delete using (public.is_owner(baby_id))', t);
  end loop;
end $$;

create policy ai_insights_select on public.ai_insights for select using (public.is_member(baby_id));
create policy ai_conv_all on public.ai_conversations for all using (user_id = auth.uid() and public.is_member(baby_id)) with check (user_id = auth.uid() and public.is_member(baby_id));
create policy ai_msg_all on public.ai_conversation_messages for all using (exists (select 1 from ai_conversations c where c.conversation_id = ai_conversation_messages.conversation_id and c.user_id = auth.uid()))
  with check (exists (select 1 from ai_conversations c where c.conversation_id = ai_conversation_messages.conversation_id and c.user_id = auth.uid() and public.is_member(c.baby_id)));

-- account deletion (GDPR): deletes babies you own (cascade) and your auth user
create or replace function public.delete_my_account() returns void language plpgsql security definer set search_path = public, auth as $$
begin
  delete from baby_profiles where baby_id in (select baby_id from baby_access where user_id = auth.uid() and role = 'owner');
  delete from auth.users where id = auth.uid();
end $$;
revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;

-- realtime (optional websocket subscriptions)
alter publication supabase_realtime add table public.feeding_entries, public.poo_entries, public.sleep_entries, public.growth_measurements, public.baby_profiles, public.baby_access;
