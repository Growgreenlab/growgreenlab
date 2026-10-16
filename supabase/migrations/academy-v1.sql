-- Grow Green Lab Trading Academy v1
-- Per-user lesson progress + decision-journal reflections.
--
-- NOT APPLIED by the Academy build. Apply manually in the Supabase
-- SQL editor at go-live, like every other feature migration in this
-- repo. Until this runs, the Academy client fails soft to guest
-- (localStorage) mode — see lib/academy/progress.ts.
--
-- Design follows the journal precedent exactly: user_id references
-- auth.users on delete cascade, one owner RLS policy per table of the
-- "own ..." shape, unique(user_id, natural key) for upserts, and a
-- (user_id, ...) index.

-- ============ PROGRESS ============
create table if not exists public.academy_progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  lesson_id text not null,
  status text not null default 'started' check (status in ('started', 'completed', 'mastered')),
  best_score numeric check (best_score is null or (best_score >= 0 and best_score <= 100)),
  attempts integer not null default 0 check (attempts >= 0),
  last_position jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, lesson_id)
);
create index if not exists academy_progress_user_lesson on public.academy_progress (user_id, lesson_id);

alter table public.academy_progress enable row level security;

drop policy if exists "own academy progress" on public.academy_progress;
create policy "own academy progress" on public.academy_progress
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============ DECISION JOURNAL ============
-- Reflections are private to the learner: no cross-user select exists
-- anywhere, and the owner policy below is the only policy.
create table if not exists public.academy_journal (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  lesson_id text not null,
  prompt_key text not null,
  response text not null,
  created_at timestamptz not null default now()
);
create index if not exists academy_journal_user_lesson on public.academy_journal (user_id, lesson_id, created_at desc);

alter table public.academy_journal enable row level security;

drop policy if exists "own academy journal" on public.academy_journal;
create policy "own academy journal" on public.academy_journal
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
