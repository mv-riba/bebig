-- 0004: optional extra trackers + wet nappies.

-- Wet nappies are part of the nappy (poo) log; existing rows are poo-only.
alter table public.baby_profiles add column if not exists wet_tracking boolean not null default false;
alter table public.poo_entries add column if not exists nappy_type text not null default 'poo' check (nappy_type in ('poo','wet','both'));

-- Tracker definitions per baby (presets and parents' own trackers, e.g. Vitamin D).
create table if not exists public.extra_trackers (
  tracker_id uuid primary key,
  baby_id uuid not null references public.baby_profiles(baby_id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 40),
  icon text not null default 'star' check (icon in ('drop','wind','pill','sun','heart','star','bath')),
  kind text not null check (kind in ('event','daily','amount','duration','level')),
  unit text check (length(unit) <= 12),
  preset text check (preset in ('bath','congestion')),
  enabled boolean not null default true,
  sort integer not null default 0,
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now(),
  check (kind <> 'amount' or unit is not null)
);
create index if not exists extra_trackers_baby on public.extra_trackers (baby_id);

create table if not exists public.extra_entries (
  extra_id uuid primary key,
  baby_id uuid not null references public.baby_profiles(baby_id) on delete cascade,
  tracker_id uuid not null references public.extra_trackers(tracker_id) on delete cascade,
  datetime timestamptz not null,
  duration_seconds integer check (duration_seconds between 0 and 86400),
  value_num numeric(10,2) check (value_num >= 0),
  level text check (level in ('mild','moderate','strong')),
  notes text check (length(notes) <= 2000),
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now()
);
create index if not exists extra_entries_baby_time on public.extra_entries (baby_id, datetime);

-- an entry must belong to a tracker of the same baby
create or replace function public.check_extra_baby() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from public.extra_trackers t where t.tracker_id = new.tracker_id and t.baby_id = new.baby_id) then
    raise exception 'tracker does not belong to this baby';
  end if;
  return new;
end $$;
drop trigger if exists extra_entries_baby on public.extra_entries;
create trigger extra_entries_baby before insert or update on public.extra_entries for each row execute function public.check_extra_baby();

do $$ declare t text; begin
  foreach t in array array['extra_trackers','extra_entries'] loop
    execute format('drop trigger if exists %1$s_touch on public.%1$s', t);
    execute format('create trigger %1$s_touch before insert or update on public.%1$s for each row execute function public.touch_server_updated_at()', t);
    execute format('alter table public.%1$s enable row level security', t);
    execute format('drop policy if exists %1$s_select on public.%1$s', t);
    execute format('drop policy if exists %1$s_insert on public.%1$s', t);
    execute format('drop policy if exists %1$s_update on public.%1$s', t);
    execute format('drop policy if exists %1$s_delete on public.%1$s', t);
    execute format('create policy %1$s_select on public.%1$s for select using (public.is_member(baby_id))', t);
    execute format('create policy %1$s_insert on public.%1$s for insert with check (public.is_member(baby_id) and created_by = auth.uid() and updated_by = auth.uid())', t);
    execute format('create policy %1$s_update on public.%1$s for update using (public.is_member(baby_id)) with check (public.is_member(baby_id) and updated_by = auth.uid())', t);
    execute format('create policy %1$s_delete on public.%1$s for delete using (public.is_owner(baby_id))', t);
    execute format('grant select, insert, update, delete on public.%1$s to authenticated', t);
  end loop;
end $$;

do $$ begin
  alter publication supabase_realtime add table public.extra_trackers, public.extra_entries;
exception when duplicate_object then null; end $$;
