-- IronHealth · Schema Supabase
-- Corre este script completo no SQL Editor do teu projeto Supabase
-- (https://supabase.com/dashboard/project/_/sql/new)

create extension if not exists pgcrypto;

create table if not exists pain_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  value smallint not null check (value between 0 and 10),
  created_at timestamptz not null default now(),
  unique (user_id, date)
);

create table if not exists meals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  name text not null,
  protein numeric not null default 0,
  calories numeric not null default 0,
  type text not null check (type in ('carnivora','vegetariana')),
  created_at timestamptz not null default now()
);

create table if not exists body_metrics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  weight numeric not null,
  body_fat numeric not null,
  muscle numeric not null,
  created_at timestamptz not null default now(),
  unique (user_id, date)
);

create table if not exists checklist_days (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  creatina boolean not null default false,
  ucii boolean not null default false,
  omega3 boolean not null default false,
  magnesio boolean not null default false,
  jefit boolean not null default false,
  watch boolean not null default false,
  unique (user_id, date)
);

create table if not exists coach_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  text text not null,
  created_at timestamptz not null default now()
);

-- Row Level Security: cada utilizador só vê e edita as suas próprias linhas
alter table pain_logs enable row level security;
alter table meals enable row level security;
alter table body_metrics enable row level security;
alter table checklist_days enable row level security;
alter table coach_logs enable row level security;

create policy "own rows" on pain_logs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on meals for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on body_metrics for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on checklist_days for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on coach_logs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
