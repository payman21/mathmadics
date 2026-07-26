-- MathMADics — Supabase (Postgres) schema for accounts and the cloud boards.
--
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste ->
-- Run. It is idempotent enough to re-run safely (drops and recreates policies
-- and functions).
--
-- Design mirrors the app's model:
--   * profiles — one row per user; the PUBLIC nickname. Email never lives here;
--                it stays in auth.users and is never exposed.
--   * scores   — every ranked round. The single source of truth: all three
--                boards are derived from it. RLS keeps raw rows owner-only, and
--                the public boards are served by SECURITY DEFINER functions that
--                expose only the aggregated/top data.
--
-- The three boards:
--   1. Your last 10 games   — scores rows for the signed-in user (owner-only).
--   2. Top 10 scores        — highest single-game scores across everyone
--                             (get_top_scores).
--   3. Global leaderboard   — players ranked by total score over all time
--                             (get_total_leaderboard).
--
-- Row-Level Security is the whole security story (the anon API key authorises
-- nothing on its own): profiles are world-readable, personal scores are
-- owner-only, and the public boards come exclusively from the functions below.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  username   text not null unique
             check (char_length(username) between 2 and 16),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.scores (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  score       integer not null check (score >= 0),
  accuracy    integer not null default 0,
  qpm         integer not null default 0,
  correct     integer not null default 0,
  wrong       integer not null default 0,
  passed      integer not null default 0,
  best_streak integer not null default 0,
  difficulty  text    not null default 'easy'
              check (difficulty in ('easy', 'medium', 'hard')),
  duration    integer not null default 120,
  scoring     integer not null default 1,
  created_at  timestamptz not null default now()
);

-- Recent-games reads: newest first, per user.
create index if not exists scores_user_recent_idx
  on public.scores (user_id, created_at desc);

-- Public-board reads: top single games and the total-score aggregation, both
-- scoped to a scoring version.
create index if not exists scores_scoring_score_idx
  on public.scores (scoring, score desc);

-- The old best-score-per-user board is gone: the global board now ranks by the
-- running total of every game, computed live from scores. Drop the obsolete
-- table and its publish path if a previous schema version created them.
drop function if exists public.publish_score(integer, integer, integer, integer, text, integer);
drop table if exists public.leaderboard;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.scores   enable row level security;

-- profiles: anyone may read (usernames are public and there is nothing else
-- here); a user may create and edit only their own row.
drop policy if exists profiles_read       on public.profiles;
drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;

create policy profiles_read
  on public.profiles for select
  using (true);

create policy profiles_insert_own
  on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));

create policy profiles_update_own
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- scores: private archive. Owner reads and appends; no updates or deletes.
-- The public boards never read this directly — they go through the functions
-- below, which run as definer and return only aggregated/top data.
drop policy if exists scores_read_own   on public.scores;
drop policy if exists scores_insert_own on public.scores;

create policy scores_read_own
  on public.scores for select to authenticated
  using (user_id = (select auth.uid()));

create policy scores_insert_own
  on public.scores for insert to authenticated
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Public boards — SECURITY DEFINER read functions
-- ---------------------------------------------------------------------------
-- These bypass scores' owner-only RLS on purpose, but return only the data the
-- boards already show publicly: a username and its score figures. Raw private
-- rows are never exposed. All are scoped to one scoring version, because scores
-- earned under different scoring rules are not comparable.

-- Top single-game scores across everyone, all time.
create or replace function public.get_top_scores(
  p_scoring integer,
  p_limit   integer default 10
) returns table (
  user_id    uuid,
  username   text,
  score      integer,
  accuracy   integer,
  qpm        integer,
  difficulty text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select s.user_id, p.username, s.score, s.accuracy, s.qpm, s.difficulty, s.created_at
  from public.scores s
  join public.profiles p on p.id = s.user_id
  where s.scoring = p_scoring
  order by s.score desc, s.created_at asc
  limit greatest(1, least(coalesce(p_limit, 10), 100));
$$;

-- Global leaderboard: players ranked by the sum of every game they have played.
create or replace function public.get_total_leaderboard(
  p_scoring integer,
  p_limit   integer default 10
) returns table (
  user_id     uuid,
  username    text,
  total_score bigint,
  games       integer,
  best_score  integer
)
language sql
security definer
set search_path = public
stable
as $$
  select s.user_id,
         p.username,
         sum(s.score)::bigint  as total_score,
         count(*)::integer      as games,
         max(s.score)::integer  as best_score
  from public.scores s
  join public.profiles p on p.id = s.user_id
  where s.scoring = p_scoring
  group by s.user_id, p.username
  order by total_score desc, games asc
  limit greatest(1, least(coalesce(p_limit, 10), 100));
$$;

-- Where a single round would place on the Top-scores board (1-based).
create or replace function public.get_score_rank(
  p_scoring integer,
  p_score   integer
) returns integer
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::integer + 1
  from public.scores
  where scoring = p_scoring and score > coalesce(p_score, 0);
$$;

-- The boards are visible to everyone, including signed-out and anonymous
-- visitors, so both roles may execute the read functions.
grant execute on function public.get_top_scores(integer, integer)        to anon, authenticated;
grant execute on function public.get_total_leaderboard(integer, integer) to anon, authenticated;
grant execute on function public.get_score_rank(integer, integer)        to anon, authenticated;
