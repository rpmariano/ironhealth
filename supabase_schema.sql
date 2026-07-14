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
  accent_color text not null default 'orange'
    check (accent_color in ('blue1','blue2','pink','yellow','orange','green')),
  theme text not null default 'dark'
    check (theme in ('dark','light')),
  coach_context text not null default '',
  height_cm numeric,
  weight_kg numeric,
  gender text check (gender in ('F','M')),
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
  notes text,
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

-- ============ coach_messages: histórico de conversa com o coach IA ============
create table coach_messages (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users(id) on delete cascade,
  role       text        not null check (role in ('user','model')),
  content    text        not null,
  created_at timestamptz not null default now()
);
create index coach_messages_user_time_idx on coach_messages(user_id, created_at);
alter table coach_messages enable row level security;
create policy "own rows" on coach_messages for all
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

-- ============ admin: menu escondido (duplo clique no logo), só para o email fixo abaixo ============
create or replace function public.is_admin()
returns boolean language sql stable as $$
  select (auth.jwt() ->> 'email') = 'rpmariano@gmail.com';
$$;

-- acesso de leitura total (além das políticas "own rows" já existentes, que se mantêm)
create policy "admin read all" on profiles for select using (public.is_admin());
create policy "admin read all" on meals for select using (public.is_admin());
create policy "admin read all" on meal_items for select using (public.is_admin());
create policy "admin read all" on coach_messages for select using (public.is_admin());

-- lista de utilizadores com email (auth.users não é exposto diretamente ao cliente)
create or replace function public.admin_list_users()
returns table(id uuid, email text, display_name text, created_at timestamptz, theme text, accent_color text)
language sql security definer set search_path = public as $$
  select u.id, u.email, p.display_name, u.created_at, p.theme, p.accent_color
  from auth.users u
  join public.profiles p on p.id = u.id
  where public.is_admin()
  order by u.created_at desc;
$$;
grant execute on function public.admin_list_users() to authenticated;

-- ============ app_logs: registo de sucesso/erro das operações principais ============
create table app_logs (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        references auth.users(id) on delete set null,
  level      text        not null check (level in ('success','error')),
  event      text        not null,
  message    text,
  meta       jsonb,
  created_at timestamptz not null default now()
);
create index app_logs_created_idx on app_logs(created_at desc);
alter table app_logs enable row level security;
create policy "insert own logs" on app_logs for insert with check (auth.uid() = user_id);
create policy "admin read all logs" on app_logs for select using (public.is_admin());

-- ============ body_assessments: avaliação corporal a partir de prints Renpho ============
-- Cada linha é uma avaliação (1+ prints da app Renpho Health) analisada pelo
-- Gemini, que extrai as métricas de composição corporal e escreve um breve
-- resumo com comparação ao histórico. Uma métrica por coluna (todas opcionais)
-- para simplificar a leitura e os gráficos de evolução, à imagem da Nutrição.
-- Idempotente: pode correr numa BD já existente sem apagar dados.
create table if not exists body_assessments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  photo_paths text[] not null default '{}',
  status text not null default 'ready' check (status in ('pending','analyzing','ready','failed')),
  notes text,
  ai_summary text,
  -- métricas de composição corporal (Renpho) — todas opcionais
  weight_kg numeric,
  bmi numeric,
  body_fat_pct numeric,
  skeletal_muscle_pct numeric,
  muscle_mass_kg numeric,
  body_water_pct numeric,
  protein_pct numeric,
  bone_mass_kg numeric,
  bmr_kcal numeric,
  visceral_fat numeric,
  subcutaneous_fat_pct numeric,
  metabolic_age numeric,
  lean_body_mass_kg numeric,
  created_at timestamptz not null default now()
);
create index if not exists body_assessments_user_date_idx on body_assessments(user_id, date);
alter table body_assessments enable row level security;

drop policy if exists "own rows" on body_assessments;
create policy "own rows" on body_assessments for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "admin read all" on body_assessments;
create policy "admin read all" on body_assessments for select using (public.is_admin());

-- ============ storage: bucket privado para os prints de avaliação corporal ============
insert into storage.buckets (id, name, public)
values ('body-photos', 'body-photos', false)
on conflict (id) do nothing;

drop policy if exists "body own folder select" on storage.objects;
drop policy if exists "body own folder insert" on storage.objects;
drop policy if exists "body own folder update" on storage.objects;
drop policy if exists "body own folder delete" on storage.objects;

create policy "body own folder select" on storage.objects for select
  using (bucket_id = 'body-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "body own folder insert" on storage.objects for insert
  with check (bucket_id = 'body-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "body own folder update" on storage.objects for update
  using (bucket_id = 'body-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "body own folder delete" on storage.objects for delete
  using (bucket_id = 'body-photos' and (storage.foldername(name))[1] = auth.uid()::text);
