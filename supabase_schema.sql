-- IronHealth v2 · Schema Supabase (nutrição por foto)
-- Substitui por completo o schema v1. Corre no SQL Editor do projeto.

create extension if not exists pgcrypto;

-- ============ limpar schema v1 ============
drop table if exists coach_logs cascade;
drop table if exists checklist_days cascade;
drop table if exists body_metrics cascade;
drop table if exists meals cascade;
drop table if exists pain_logs cascade;

-- ============ profiles: metas individuais por utilizador ============
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  calorie_goal numeric not null default 2000,
  protein_goal numeric not null default 150,
  carbs_goal numeric not null default 200,
  fat_goal numeric not null default 70,
  created_at timestamptz not null default now()
);
alter table profiles enable row level security;
create policy "own profile" on profiles for all
  using (auth.uid() = id) with check (auth.uid() = id);

-- perfil criado automaticamente no signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- perfis para contas já existentes (criadas antes da trigger)
insert into public.profiles (id, display_name)
select id, split_part(email,'@',1) from auth.users
on conflict (id) do nothing;

-- ============ meals: uma refeição fotografada ============
create table meals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  meal_type text not null check (meal_type in ('pequeno-almoco','almoco','lanche','jantar','ceia')),
  photo_paths text[] not null default '{}',
  status text not null default 'ready' check (status in ('pending','analyzing','ready','failed')),
  created_at timestamptz not null default now()
);
create index meals_user_date_idx on meals(user_id, date);
alter table meals enable row level security;
create policy "own rows" on meals for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============ meal_items: itens detetados, valores por 100g ============
-- Guardar por 100g permite reescalar a quantidade no cliente por simples
-- multiplicação, sem nova chamada à IA.
create table meal_items (
  id uuid primary key default gen_random_uuid(),
  meal_id uuid not null references meals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  quantity_grams numeric not null check (quantity_grams >= 0),
  calories_per_100g numeric not null default 0,
  protein_per_100g numeric not null default 0,
  carbs_per_100g numeric not null default 0,
  fat_per_100g numeric not null default 0,
  fiber_per_100g numeric not null default 0,
  sugar_per_100g numeric not null default 0,
  sodium_per_100g numeric not null default 0,
  iron_mg_per_100g numeric,
  calcium_mg_per_100g numeric,
  vitamin_c_mg_per_100g numeric,
  potassium_mg_per_100g numeric,
  created_at timestamptz not null default now()
);
create index meal_items_meal_idx on meal_items(meal_id);
create index meal_items_user_idx on meal_items(user_id);
alter table meal_items enable row level security;
create policy "own rows" on meal_items for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============ storage: bucket privado com pasta por utilizador ============
insert into storage.buckets (id, name, public)
values ('meal-photos', 'meal-photos', false)
on conflict (id) do nothing;

drop policy if exists "own folder select" on storage.objects;
drop policy if exists "own folder insert" on storage.objects;
drop policy if exists "own folder update" on storage.objects;
drop policy if exists "own folder delete" on storage.objects;

create policy "own folder select" on storage.objects for select
  using (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own folder insert" on storage.objects for insert
  with check (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own folder update" on storage.objects for update
  using (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own folder delete" on storage.objects for delete
  using (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = auth.uid()::text);
