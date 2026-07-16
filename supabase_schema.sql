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
  accent_color text not null default 'amber'
    check (accent_color in ('orange','amber','coral','teal','sky','steel','plum','fuchsia','pink','green','lime','turquoise')),
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

-- objetivos do módulo "Corpo" — um por métrica de body_assessments, todos
-- opcionais. Adicionados depois da criação da tabela: idempotente para BDs
-- já existentes.
alter table profiles
  add column if not exists goal_weight_kg numeric,
  add column if not exists goal_bmi numeric,
  add column if not exists goal_body_fat_pct numeric,
  add column if not exists goal_skeletal_muscle_pct numeric,
  add column if not exists goal_muscle_mass_kg numeric,
  add column if not exists goal_body_water_pct numeric,
  add column if not exists goal_protein_pct numeric,
  add column if not exists goal_bone_mass_kg numeric,
  add column if not exists goal_bmr_kcal numeric,
  add column if not exists goal_visceral_fat numeric,
  add column if not exists goal_subcutaneous_fat_pct numeric,
  add column if not exists goal_metabolic_age numeric,
  add column if not exists goal_lean_body_mass_kg numeric;

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
  -- classificação Renpho por métrica: { "weight_kg": "Ligeiramente alto", ... }
  classifications jsonb,
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
-- coluna adicionada mais tarde: garante que BDs já existentes a recebem.
alter table body_assessments add column if not exists classifications jsonb;
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

-- ============================================================================
-- ============ VERTICAL DE GINÁSIO ===========================================
-- ============================================================================
-- Biblioteca de exercícios (referência partilhada, legível por qualquer
-- utilizador autenticado, sem escrita pelo cliente) + planos e registo de
-- treino por utilizador (RLS "own rows", como a Nutrição).

-- ---- referência: músculos (svg_key/body_region reservados p/ diagrama futuro) ----
create table muscles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  muscle_group text not null check (muscle_group in
    ('peito','costas','ombros','biceps','triceps','quadriceps','isquiotibiais','gluteos','gemeos','core','antebracos','trapezio')),
  body_region text check (body_region in ('frente','costas')),
  svg_key text,
  created_at timestamptz not null default now()
);
alter table muscles enable row level security;
create policy "read all" on muscles for select using (true);

-- ---- referência: exercícios ----
create table exercises (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  muscle_group text not null check (muscle_group in
    ('peito','costas','ombros','biceps','triceps','quadriceps','isquiotibiais','gluteos','gemeos','core','antebracos','trapezio')),
  equipment text not null default 'outro' check (equipment in
    ('barra','halteres','maquina','cabo','peso corporal','kettlebell','outro')),
  mechanic text check (mechanic in ('composto','isolado')),
  instructions text,
  created_at timestamptz not null default now()
);
create index exercises_group_idx on exercises(muscle_group);
alter table exercises enable row level security;
create policy "read all" on exercises for select using (true);

-- ---- referência: envolvimento muscular por exercício (percentagens) ----
create table exercise_muscles (
  id uuid primary key default gen_random_uuid(),
  exercise_id uuid not null references exercises(id) on delete cascade,
  muscle_id uuid not null references muscles(id) on delete cascade,
  involvement_pct numeric not null check (involvement_pct >= 0 and involvement_pct <= 100),
  role text not null default 'secundario' check (role in ('primario','secundario','estabilizador')),
  created_at timestamptz not null default now()
);
create index exercise_muscles_exercise_idx on exercise_muscles(exercise_id);
alter table exercise_muscles enable row level security;
create policy "read all" on exercise_muscles for select using (true);

-- ---- planos de treino do utilizador ----
create table workout_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index workout_plans_user_idx on workout_plans(user_id);
alter table workout_plans enable row level security;
create policy "own rows" on workout_plans for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "admin read all" on workout_plans for select using (public.is_admin());

-- ---- dias de um plano (ex: Push na 2ª feira) ----
create table workout_plan_days (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references workout_plans(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  weekday int check (weekday between 0 and 6),
  order_index int not null default 0,
  created_at timestamptz not null default now()
);
create index workout_plan_days_plan_idx on workout_plan_days(plan_id);
alter table workout_plan_days enable row level security;
create policy "own rows" on workout_plan_days for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "admin read all" on workout_plan_days for select using (public.is_admin());

-- ---- exercícios de um dia do plano (com alvos) ----
create table workout_plan_exercises (
  id uuid primary key default gen_random_uuid(),
  plan_day_id uuid not null references workout_plan_days(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  exercise_id uuid not null references exercises(id),
  order_index int not null default 0,
  target_sets int,
  target_reps text,
  target_weight numeric,
  rest_seconds int,
  created_at timestamptz not null default now()
);
create index workout_plan_exercises_day_idx on workout_plan_exercises(plan_day_id);
alter table workout_plan_exercises enable row level security;
create policy "own rows" on workout_plan_exercises for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "admin read all" on workout_plan_exercises for select using (public.is_admin());

-- ---- sessões de treino (o "log") ----
create table workout_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  plan_day_id uuid references workout_plan_days(id) on delete set null,
  name text not null default '',
  status text not null default 'em-curso' check (status in ('em-curso','concluido')),
  started_at timestamptz,
  completed_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);
create index workout_sessions_user_date_idx on workout_sessions(user_id, date);
alter table workout_sessions enable row level security;
create policy "own rows" on workout_sessions for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "admin read all" on workout_sessions for select using (public.is_admin());

-- ---- sets registados numa sessão ----
create table workout_session_sets (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references workout_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  exercise_id uuid not null references exercises(id),
  set_index int not null default 0,
  reps int,
  weight numeric,
  done boolean not null default false,
  created_at timestamptz not null default now()
);
create index workout_session_sets_session_idx on workout_session_sets(session_id);
alter table workout_session_sets enable row level security;
create policy "own rows" on workout_session_sets for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "admin read all" on workout_session_sets for select using (public.is_admin());

-- ---- SEED da biblioteca (músculos → exercícios → envolvimento) ----
insert into muscles (name, muscle_group, body_region, svg_key) values
  ('Peitoral maior',            'peito',         'frente',  'chest'),
  ('Peitoral superior',         'peito',         'frente',  'chest_upper'),
  ('Grande dorsal',             'costas',        'costas',  'lats'),
  ('Trapézio',                  'trapezio',      'costas',  'traps'),
  ('Rombóides',                 'costas',        'costas',  'rhomboids'),
  ('Lombar',                    'costas',        'costas',  'lower_back'),
  ('Deltóide anterior',         'ombros',        'frente',  'front_delts'),
  ('Deltóide lateral',          'ombros',        'frente',  'side_delts'),
  ('Deltóide posterior',        'ombros',        'costas',  'rear_delts'),
  ('Bíceps braquial',           'biceps',        'frente',  'biceps'),
  ('Tríceps braquial',          'triceps',       'costas',  'triceps'),
  ('Antebraço',                 'antebracos',    'frente',  'forearms'),
  ('Quadríceps',                'quadriceps',    'frente',  'quads'),
  ('Isquiotibiais',             'isquiotibiais', 'costas',  'hamstrings'),
  ('Glúteos',                   'gluteos',       'costas',  'glutes'),
  ('Gémeos',                    'gemeos',        'costas',  'calves'),
  ('Abdominais',                'core',          'frente',  'abs'),
  ('Oblíquos',                  'core',          'frente',  'obliques');

insert into exercises (name, muscle_group, equipment, mechanic) values
  ('Supino reto com barra','peito','barra','composto'),
  ('Supino inclinado com barra','peito','barra','composto'),
  ('Supino reto com halteres','peito','halteres','composto'),
  ('Supino inclinado com halteres','peito','halteres','composto'),
  ('Crucifixo com halteres','peito','halteres','isolado'),
  ('Crossover na polia','peito','cabo','isolado'),
  ('Flexões','peito','peso corporal','composto'),
  ('Peck deck','peito','maquina','isolado'),
  ('Fundos para peito','peito','peso corporal','composto'),
  ('Levantamento terra','costas','barra','composto'),
  ('Puxada frontal','costas','cabo','composto'),
  ('Remada curvada com barra','costas','barra','composto'),
  ('Remada unilateral com halter','costas','halteres','composto'),
  ('Barra fixa','costas','peso corporal','composto'),
  ('Remada na máquina','costas','maquina','composto'),
  ('Remada sentada na polia','costas','cabo','composto'),
  ('Pullover com halter','costas','halteres','isolado'),
  ('Hiperextensão lombar','costas','peso corporal','isolado'),
  ('Desenvolvimento militar com barra','ombros','barra','composto'),
  ('Desenvolvimento com halteres','ombros','halteres','composto'),
  ('Elevação lateral','ombros','halteres','isolado'),
  ('Elevação frontal','ombros','halteres','isolado'),
  ('Crucifixo invertido','ombros','halteres','isolado'),
  ('Encolhimento','trapezio','halteres','isolado'),
  ('Face pull','ombros','cabo','isolado'),
  ('Desenvolvimento Arnold','ombros','halteres','composto'),
  ('Rosca direta com barra','biceps','barra','isolado'),
  ('Rosca alternada com halteres','biceps','halteres','isolado'),
  ('Rosca martelo','biceps','halteres','isolado'),
  ('Rosca concentrada','biceps','halteres','isolado'),
  ('Rosca Scott','biceps','barra','isolado'),
  ('Rosca na polia','biceps','cabo','isolado'),
  ('Tríceps na polia','triceps','cabo','isolado'),
  ('Tríceps testa','triceps','barra','isolado'),
  ('Tríceps francês','triceps','halteres','isolado'),
  ('Fundos entre bancos','triceps','peso corporal','composto'),
  ('Tríceps corda','triceps','cabo','isolado'),
  ('Supino fechado','triceps','barra','composto'),
  ('Agachamento com barra','quadriceps','barra','composto'),
  ('Prensa de pernas','quadriceps','maquina','composto'),
  ('Cadeira extensora','quadriceps','maquina','isolado'),
  ('Afundo','quadriceps','halteres','composto'),
  ('Agachamento frontal','quadriceps','barra','composto'),
  ('Agachamento hack','quadriceps','maquina','composto'),
  ('Agachamento búlgaro','quadriceps','halteres','composto'),
  ('Cadeira flexora','isquiotibiais','maquina','isolado'),
  ('Stiff','isquiotibiais','barra','composto'),
  ('Elevação pélvica','gluteos','barra','composto'),
  ('Good morning','isquiotibiais','barra','composto'),
  ('Cadeira abdutora','gluteos','maquina','isolado'),
  ('Elevação de gémeos em pé','gemeos','maquina','isolado'),
  ('Elevação de gémeos sentado','gemeos','maquina','isolado'),
  ('Elevação de gémeos na prensa','gemeos','maquina','isolado'),
  ('Prancha','core','peso corporal','isolado'),
  ('Abdominal crunch','core','peso corporal','isolado'),
  ('Elevação de pernas','core','peso corporal','isolado'),
  ('Rotação russa','core','peso corporal','isolado'),
  ('Prancha lateral','core','peso corporal','isolado'),
  ('Roda abdominal','core','outro','composto'),
  ('Elevação de joelhos suspenso','core','peso corporal','isolado'),
  ('Rosca de punho','antebracos','halteres','isolado'),
  ('Rosca de punho invertida','antebracos','halteres','isolado'),
  ('Remada alta','ombros','barra','composto'),
  ('Puxada com pega neutra','costas','cabo','composto'),
  ('Agachamento sumô','gluteos','barra','composto');

-- Envolvimento muscular: primário + secundários por exercício (soma ~100%).
-- Ligado por nome (exercícios e músculos têm nomes únicos no seed acima).
insert into exercise_muscles (exercise_id, muscle_id, involvement_pct, role)
select e.id, m.id, v.pct, v.role
from (values
  ('Supino reto com barra','Peitoral maior',60,'primario'),
  ('Supino reto com barra','Deltóide anterior',15,'secundario'),
  ('Supino reto com barra','Tríceps braquial',15,'secundario'),
  ('Supino reto com barra','Peitoral superior',10,'secundario'),
  ('Supino inclinado com barra','Peitoral superior',45,'primario'),
  ('Supino inclinado com barra','Peitoral maior',25,'secundario'),
  ('Supino inclinado com barra','Deltóide anterior',15,'secundario'),
  ('Supino inclinado com barra','Tríceps braquial',15,'secundario'),
  ('Supino reto com halteres','Peitoral maior',60,'primario'),
  ('Supino reto com halteres','Deltóide anterior',15,'secundario'),
  ('Supino reto com halteres','Tríceps braquial',15,'secundario'),
  ('Supino reto com halteres','Peitoral superior',10,'secundario'),
  ('Supino inclinado com halteres','Peitoral superior',45,'primario'),
  ('Supino inclinado com halteres','Peitoral maior',25,'secundario'),
  ('Supino inclinado com halteres','Deltóide anterior',15,'secundario'),
  ('Supino inclinado com halteres','Tríceps braquial',15,'secundario'),
  ('Crucifixo com halteres','Peitoral maior',75,'primario'),
  ('Crucifixo com halteres','Deltóide anterior',15,'secundario'),
  ('Crucifixo com halteres','Peitoral superior',10,'secundario'),
  ('Crossover na polia','Peitoral maior',70,'primario'),
  ('Crossover na polia','Peitoral superior',15,'secundario'),
  ('Crossover na polia','Deltóide anterior',15,'secundario'),
  ('Flexões','Peitoral maior',55,'primario'),
  ('Flexões','Tríceps braquial',20,'secundario'),
  ('Flexões','Deltóide anterior',15,'secundario'),
  ('Flexões','Abdominais',10,'estabilizador'),
  ('Peck deck','Peitoral maior',80,'primario'),
  ('Peck deck','Deltóide anterior',20,'secundario'),
  ('Fundos para peito','Peitoral maior',55,'primario'),
  ('Fundos para peito','Tríceps braquial',30,'secundario'),
  ('Fundos para peito','Deltóide anterior',15,'secundario'),
  ('Levantamento terra','Lombar',25,'primario'),
  ('Levantamento terra','Glúteos',20,'secundario'),
  ('Levantamento terra','Isquiotibiais',20,'secundario'),
  ('Levantamento terra','Trapézio',20,'secundario'),
  ('Levantamento terra','Grande dorsal',15,'secundario'),
  ('Puxada frontal','Grande dorsal',60,'primario'),
  ('Puxada frontal','Bíceps braquial',20,'secundario'),
  ('Puxada frontal','Rombóides',10,'secundario'),
  ('Puxada frontal','Deltóide posterior',10,'secundario'),
  ('Remada curvada com barra','Grande dorsal',45,'primario'),
  ('Remada curvada com barra','Rombóides',15,'secundario'),
  ('Remada curvada com barra','Trapézio',15,'secundario'),
  ('Remada curvada com barra','Bíceps braquial',15,'secundario'),
  ('Remada curvada com barra','Deltóide posterior',10,'secundario'),
  ('Remada unilateral com halter','Grande dorsal',55,'primario'),
  ('Remada unilateral com halter','Rombóides',15,'secundario'),
  ('Remada unilateral com halter','Trapézio',15,'secundario'),
  ('Remada unilateral com halter','Bíceps braquial',15,'secundario'),
  ('Barra fixa','Grande dorsal',60,'primario'),
  ('Barra fixa','Bíceps braquial',20,'secundario'),
  ('Barra fixa','Rombóides',10,'secundario'),
  ('Barra fixa','Deltóide posterior',10,'secundario'),
  ('Remada na máquina','Grande dorsal',50,'primario'),
  ('Remada na máquina','Rombóides',20,'secundario'),
  ('Remada na máquina','Bíceps braquial',15,'secundario'),
  ('Remada na máquina','Deltóide posterior',15,'secundario'),
  ('Remada sentada na polia','Grande dorsal',50,'primario'),
  ('Remada sentada na polia','Rombóides',20,'secundario'),
  ('Remada sentada na polia','Bíceps braquial',15,'secundario'),
  ('Remada sentada na polia','Trapézio',15,'secundario'),
  ('Pullover com halter','Grande dorsal',65,'primario'),
  ('Pullover com halter','Peitoral maior',20,'secundario'),
  ('Pullover com halter','Tríceps braquial',15,'secundario'),
  ('Hiperextensão lombar','Lombar',60,'primario'),
  ('Hiperextensão lombar','Glúteos',25,'secundario'),
  ('Hiperextensão lombar','Isquiotibiais',15,'secundario'),
  ('Desenvolvimento militar com barra','Deltóide anterior',45,'primario'),
  ('Desenvolvimento militar com barra','Deltóide lateral',20,'secundario'),
  ('Desenvolvimento militar com barra','Tríceps braquial',20,'secundario'),
  ('Desenvolvimento militar com barra','Trapézio',15,'secundario'),
  ('Desenvolvimento com halteres','Deltóide anterior',45,'primario'),
  ('Desenvolvimento com halteres','Deltóide lateral',25,'secundario'),
  ('Desenvolvimento com halteres','Tríceps braquial',20,'secundario'),
  ('Desenvolvimento com halteres','Trapézio',10,'secundario'),
  ('Elevação lateral','Deltóide lateral',75,'primario'),
  ('Elevação lateral','Deltóide anterior',15,'secundario'),
  ('Elevação lateral','Trapézio',10,'secundario'),
  ('Elevação frontal','Deltóide anterior',70,'primario'),
  ('Elevação frontal','Deltóide lateral',20,'secundario'),
  ('Elevação frontal','Peitoral superior',10,'secundario'),
  ('Crucifixo invertido','Deltóide posterior',65,'primario'),
  ('Crucifixo invertido','Rombóides',20,'secundario'),
  ('Crucifixo invertido','Trapézio',15,'secundario'),
  ('Encolhimento','Trapézio',85,'primario'),
  ('Encolhimento','Deltóide lateral',15,'secundario'),
  ('Face pull','Deltóide posterior',45,'primario'),
  ('Face pull','Rombóides',30,'secundario'),
  ('Face pull','Trapézio',25,'secundario'),
  ('Desenvolvimento Arnold','Deltóide anterior',40,'primario'),
  ('Desenvolvimento Arnold','Deltóide lateral',30,'secundario'),
  ('Desenvolvimento Arnold','Tríceps braquial',20,'secundario'),
  ('Desenvolvimento Arnold','Trapézio',10,'secundario'),
  ('Rosca direta com barra','Bíceps braquial',80,'primario'),
  ('Rosca direta com barra','Antebraço',20,'secundario'),
  ('Rosca alternada com halteres','Bíceps braquial',75,'primario'),
  ('Rosca alternada com halteres','Antebraço',25,'secundario'),
  ('Rosca martelo','Bíceps braquial',60,'primario'),
  ('Rosca martelo','Antebraço',40,'secundario'),
  ('Rosca concentrada','Bíceps braquial',85,'primario'),
  ('Rosca concentrada','Antebraço',15,'secundario'),
  ('Rosca Scott','Bíceps braquial',85,'primario'),
  ('Rosca Scott','Antebraço',15,'secundario'),
  ('Rosca na polia','Bíceps braquial',80,'primario'),
  ('Rosca na polia','Antebraço',20,'secundario'),
  ('Tríceps na polia','Tríceps braquial',90,'primario'),
  ('Tríceps na polia','Antebraço',10,'secundario'),
  ('Tríceps testa','Tríceps braquial',90,'primario'),
  ('Tríceps testa','Antebraço',10,'secundario'),
  ('Tríceps francês','Tríceps braquial',85,'primario'),
  ('Tríceps francês','Deltóide anterior',15,'secundario'),
  ('Fundos entre bancos','Tríceps braquial',70,'primario'),
  ('Fundos entre bancos','Deltóide anterior',15,'secundario'),
  ('Fundos entre bancos','Peitoral maior',15,'secundario'),
  ('Tríceps corda','Tríceps braquial',90,'primario'),
  ('Tríceps corda','Antebraço',10,'secundario'),
  ('Supino fechado','Tríceps braquial',55,'primario'),
  ('Supino fechado','Peitoral maior',25,'secundario'),
  ('Supino fechado','Deltóide anterior',20,'secundario'),
  ('Agachamento com barra','Quadríceps',45,'primario'),
  ('Agachamento com barra','Glúteos',25,'secundario'),
  ('Agachamento com barra','Isquiotibiais',15,'secundario'),
  ('Agachamento com barra','Lombar',15,'estabilizador'),
  ('Prensa de pernas','Quadríceps',55,'primario'),
  ('Prensa de pernas','Glúteos',25,'secundario'),
  ('Prensa de pernas','Isquiotibiais',20,'secundario'),
  ('Cadeira extensora','Quadríceps',95,'primario'),
  ('Cadeira extensora','Gémeos',5,'secundario'),
  ('Afundo','Quadríceps',40,'primario'),
  ('Afundo','Glúteos',35,'secundario'),
  ('Afundo','Isquiotibiais',25,'secundario'),
  ('Agachamento frontal','Quadríceps',50,'primario'),
  ('Agachamento frontal','Glúteos',25,'secundario'),
  ('Agachamento frontal','Lombar',15,'estabilizador'),
  ('Agachamento frontal','Abdominais',10,'estabilizador'),
  ('Agachamento hack','Quadríceps',65,'primario'),
  ('Agachamento hack','Glúteos',20,'secundario'),
  ('Agachamento hack','Isquiotibiais',15,'secundario'),
  ('Agachamento búlgaro','Quadríceps',40,'primario'),
  ('Agachamento búlgaro','Glúteos',40,'secundario'),
  ('Agachamento búlgaro','Isquiotibiais',20,'secundario'),
  ('Cadeira flexora','Isquiotibiais',90,'primario'),
  ('Cadeira flexora','Gémeos',10,'secundario'),
  ('Stiff','Isquiotibiais',45,'primario'),
  ('Stiff','Glúteos',35,'secundario'),
  ('Stiff','Lombar',20,'estabilizador'),
  ('Elevação pélvica','Glúteos',65,'primario'),
  ('Elevação pélvica','Isquiotibiais',25,'secundario'),
  ('Elevação pélvica','Quadríceps',10,'secundario'),
  ('Good morning','Isquiotibiais',40,'primario'),
  ('Good morning','Lombar',35,'secundario'),
  ('Good morning','Glúteos',25,'secundario'),
  ('Cadeira abdutora','Glúteos',90,'primario'),
  ('Cadeira abdutora','Quadríceps',10,'secundario'),
  ('Elevação de gémeos em pé','Gémeos',100,'primario'),
  ('Elevação de gémeos sentado','Gémeos',100,'primario'),
  ('Elevação de gémeos na prensa','Gémeos',100,'primario'),
  ('Prancha','Abdominais',60,'primario'),
  ('Prancha','Oblíquos',25,'secundario'),
  ('Prancha','Lombar',15,'estabilizador'),
  ('Abdominal crunch','Abdominais',85,'primario'),
  ('Abdominal crunch','Oblíquos',15,'secundario'),
  ('Elevação de pernas','Abdominais',70,'primario'),
  ('Elevação de pernas','Oblíquos',20,'secundario'),
  ('Elevação de pernas','Quadríceps',10,'secundario'),
  ('Rotação russa','Oblíquos',65,'primario'),
  ('Rotação russa','Abdominais',35,'secundario'),
  ('Prancha lateral','Oblíquos',70,'primario'),
  ('Prancha lateral','Abdominais',20,'secundario'),
  ('Prancha lateral','Deltóide lateral',10,'estabilizador'),
  ('Roda abdominal','Abdominais',65,'primario'),
  ('Roda abdominal','Oblíquos',15,'secundario'),
  ('Roda abdominal','Grande dorsal',10,'secundario'),
  ('Roda abdominal','Lombar',10,'estabilizador'),
  ('Elevação de joelhos suspenso','Abdominais',65,'primario'),
  ('Elevação de joelhos suspenso','Oblíquos',20,'secundario'),
  ('Elevação de joelhos suspenso','Antebraço',15,'estabilizador'),
  ('Rosca de punho','Antebraço',100,'primario'),
  ('Rosca de punho invertida','Antebraço',100,'primario'),
  ('Remada alta','Deltóide lateral',40,'primario'),
  ('Remada alta','Trapézio',30,'secundario'),
  ('Remada alta','Bíceps braquial',15,'secundario'),
  ('Remada alta','Deltóide anterior',15,'secundario'),
  ('Puxada com pega neutra','Grande dorsal',55,'primario'),
  ('Puxada com pega neutra','Bíceps braquial',20,'secundario'),
  ('Puxada com pega neutra','Rombóides',15,'secundario'),
  ('Puxada com pega neutra','Deltóide posterior',10,'secundario'),
  ('Agachamento sumô','Glúteos',40,'primario'),
  ('Agachamento sumô','Quadríceps',35,'secundario'),
  ('Agachamento sumô','Isquiotibiais',25,'secundario')
) as v(ex_name, mus_name, pct, role)
join exercises e on e.name = v.ex_name
join muscles m on m.name = v.mus_name;
