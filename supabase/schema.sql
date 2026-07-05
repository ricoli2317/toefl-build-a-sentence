-- TOEFL Build a Sentence - Supabase schema
-- Copy this whole file into the Supabase SQL Editor and run it.
--
-- This script is intended for a fresh project or a reset during development.
-- It drops the app tables first so the schema can be re-run safely while building.

create extension if not exists "pgcrypto";

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

drop table if exists public.attempt_answers cascade;
drop table if exists public.attempts cascade;
drop table if exists public.questions cascade;
drop table if exists public.question_sets cascade;
drop table if exists public.profiles cascade;

drop type if exists public.user_role cascade;

create type public.user_role as enum ('student', 'teacher');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique,
  full_name text,
  role public.user_role not null default 'student',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.question_sets (
  set_id uuid primary key default gen_random_uuid(),
  set_title text not null,
  description text,
  level text,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.questions (
  question_id uuid primary key default gen_random_uuid(),
  set_id uuid not null references public.question_sets(set_id) on delete cascade,
  set_title text not null,
  question_order int not null check (question_order between 1 and 10),
  prompt text not null,
  sentence_template text not null,
  blank_count int not null default 1 check (blank_count > 0),
  options_text text not null,
  correct_order_text text not null,
  distractors_text text,
  final_sentence text not null,
  grammar_tags_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (set_id, question_order)
);

create table public.attempts (
  attempt_id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  set_id uuid not null references public.question_sets(set_id) on delete cascade,
  set_title text not null,
  correct_count int not null default 0 check (correct_count >= 0),
  total_questions int not null default 10 check (total_questions > 0),
  accuracy numeric(5, 4) not null default 0 check (accuracy >= 0 and accuracy <= 1),
  time_spent_seconds int not null default 0 check (time_spent_seconds >= 0),
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.attempt_answers (
  attempt_answer_id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.attempts(attempt_id) on delete cascade,
  question_id uuid not null references public.questions(question_id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  set_id uuid not null references public.question_sets(set_id) on delete cascade,
  question_order int not null,
  prompt text not null,
  submitted_order_text text not null,
  correct_order_text text not null,
  is_correct boolean not null default false,
  grammar_tags_text text,
  answered_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (attempt_id, question_id)
);

create index profiles_role_idx on public.profiles(role);
create index question_sets_active_idx on public.question_sets(is_active);
create index questions_set_id_idx on public.questions(set_id);
create index questions_set_order_idx on public.questions(set_id, question_order);
create index attempts_student_id_idx on public.attempts(student_id);
create index attempts_set_id_idx on public.attempts(set_id);
create index attempts_submitted_at_idx on public.attempts(submitted_at);
create index attempt_answers_attempt_id_idx on public.attempt_answers(attempt_id);
create index attempt_answers_question_id_idx on public.attempt_answers(question_id);
create index attempt_answers_student_id_idx on public.attempt_answers(student_id);
create index attempt_answers_set_id_idx on public.attempt_answers(set_id);
create index attempt_answers_is_correct_idx on public.attempt_answers(is_correct);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger question_sets_set_updated_at
before update on public.question_sets
for each row execute function public.set_updated_at();

create trigger questions_set_updated_at
before update on public.questions
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_role public.user_role;
begin
  requested_role := coalesce(
    nullif(new.raw_user_meta_data ->> 'role', '')::public.user_role,
    'student'
  );

  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    requested_role
  );

  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_teacher()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = 'teacher'
  );
$$;

alter table public.profiles enable row level security;
alter table public.question_sets enable row level security;
alter table public.questions enable row level security;
alter table public.attempts enable row level security;
alter table public.attempt_answers enable row level security;

create policy "profiles_select_own"
on public.profiles
for select
to authenticated
using (auth.uid() = id);

create policy "profiles_update_own"
on public.profiles
for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

create policy "teachers_select_all_profiles"
on public.profiles
for select
to authenticated
using (public.is_teacher());

create policy "authenticated_select_active_question_sets"
on public.question_sets
for select
to authenticated
using (is_active = true);

create policy "teachers_manage_question_sets"
on public.question_sets
for all
to authenticated
using (public.is_teacher())
with check (public.is_teacher());

create policy "teachers_select_questions"
on public.questions
for select
to authenticated
using (public.is_teacher());

create policy "teachers_manage_questions"
on public.questions
for all
to authenticated
using (public.is_teacher())
with check (public.is_teacher());

create policy "students_select_own_attempts"
on public.attempts
for select
to authenticated
using (auth.uid() = student_id);

create policy "students_insert_own_attempts"
on public.attempts
for insert
to authenticated
with check (auth.uid() = student_id);

create policy "teachers_select_all_attempts"
on public.attempts
for select
to authenticated
using (public.is_teacher());

create policy "students_select_own_attempt_answers"
on public.attempt_answers
for select
to authenticated
using (auth.uid() = student_id);

create policy "students_insert_own_attempt_answers"
on public.attempt_answers
for insert
to authenticated
with check (auth.uid() = student_id);

create policy "teachers_select_all_attempt_answers"
on public.attempt_answers
for select
to authenticated
using (public.is_teacher());

insert into public.question_sets (
  set_id,
  set_title,
  description,
  level,
  is_active
) values (
  '11111111-1111-1111-1111-111111111111',
  'TOEFL Sentence Set 1',
  'Academic sentence structure practice.',
  'Foundation',
  true
);

insert into public.questions (
  set_id,
  set_title,
  question_order,
  prompt,
  sentence_template,
  blank_count,
  options_text,
  correct_order_text,
  distractors_text,
  final_sentence,
  grammar_tags_text
) values
  (
    '11111111-1111-1111-1111-111111111111',
    'TOEFL Sentence Set 1',
    1,
    'Complete the cause-and-effect sentence.',
    'The experiment demonstrated that ____ can alter plant growth.',
    1,
    'limited sunlight|over time|significantly',
    'limited sunlight|over time|significantly',
    'rare minerals|almost never',
    'The experiment demonstrated that limited sunlight over time significantly can alter plant growth.',
    'cause-effect|adverb placement'
  ),
  (
    '11111111-1111-1111-1111-111111111111',
    'TOEFL Sentence Set 1',
    2,
    'Build a contrast sentence.',
    'Although the theory was widely accepted, ____ challenged its central assumption.',
    1,
    'new evidence|from field studies|gradually',
    'new evidence|from field studies|gradually',
    'the committee|nearby',
    'Although the theory was widely accepted, new evidence from field studies gradually challenged its central assumption.',
    'contrast clause|noun phrase'
  ),
  (
    '11111111-1111-1111-1111-111111111111',
    'TOEFL Sentence Set 1',
    3,
    'Complete the sentence with a clear subject phrase.',
    '____ explains why coastal cities face increasing flood risks.',
    1,
    'The rise|in global sea levels|over recent decades',
    'The rise|in global sea levels|over recent decades',
    'A prediction|under the surface',
    'The rise in global sea levels over recent decades explains why coastal cities face increasing flood risks.',
    'subject phrase|prepositional phrase'
  ),
  (
    '11111111-1111-1111-1111-111111111111',
    'TOEFL Sentence Set 1',
    4,
    'Build the sentence modifier.',
    'Researchers collected samples ____ to compare seasonal changes.',
    1,
    'from several remote lakes|during the summer|and winter',
    'from several remote lakes|during the summer|and winter',
    'because quickly|the conclusion',
    'Researchers collected samples from several remote lakes during the summer and winter to compare seasonal changes.',
    'modifier|parallel structure'
  ),
  (
    '11111111-1111-1111-1111-111111111111',
    'TOEFL Sentence Set 1',
    5,
    'Complete the academic claim.',
    'A successful public transportation system depends on ____.',
    1,
    'reliable schedules|affordable fares|and convenient routes',
    'reliable schedules|affordable fares|and convenient routes',
    'sudden weather|therefore',
    'A successful public transportation system depends on reliable schedules affordable fares and convenient routes.',
    'parallel nouns|academic claim'
  ),
  (
    '11111111-1111-1111-1111-111111111111',
    'TOEFL Sentence Set 1',
    6,
    'Build the noun phrase.',
    '____ has transformed how historians interpret ancient trade.',
    1,
    'The discovery|of shipwreck artifacts|near the harbor',
    'The discovery|of shipwreck artifacts|near the harbor',
    'Several debates|carefully',
    'The discovery of shipwreck artifacts near the harbor has transformed how historians interpret ancient trade.',
    'noun phrase|prepositional phrase'
  ),
  (
    '11111111-1111-1111-1111-111111111111',
    'TOEFL Sentence Set 1',
    7,
    'Complete the sentence with sequence logic.',
    'After the volcano erupted, ____ across nearby farmland.',
    1,
    'a layer of ash|settled|rapidly',
    'a layer of ash|settled|rapidly',
    'the ocean current|although',
    'After the volcano erupted, a layer of ash settled rapidly across nearby farmland.',
    'sequence|subject verb adverb'
  ),
  (
    '11111111-1111-1111-1111-111111111111',
    'TOEFL Sentence Set 1',
    8,
    'Build the evidence phrase.',
    'The survey suggests that ____ prefer flexible study schedules.',
    1,
    'many first-year students|at large universities|strongly',
    'many first-year students|at large universities|strongly',
    'the conclusion|because of',
    'The survey suggests that many first-year students at large universities strongly prefer flexible study schedules.',
    'that clause|adverb placement'
  ),
  (
    '11111111-1111-1111-1111-111111111111',
    'TOEFL Sentence Set 1',
    9,
    'Complete the comparison.',
    'Compared with handwritten notes, ____ are easier to search and organize.',
    1,
    'digital records|stored in cloud systems|often',
    'digital records|stored in cloud systems|often',
    'careful readers|despite',
    'Compared with handwritten notes, digital records stored in cloud systems often are easier to search and organize.',
    'comparison|reduced relative clause'
  ),
  (
    '11111111-1111-1111-1111-111111111111',
    'TOEFL Sentence Set 1',
    10,
    'Build the final clause.',
    'The museum expanded its online archive so that ____ without traveling abroad.',
    1,
    'international scholars|could examine rare documents|more easily',
    'international scholars|could examine rare documents|more easily',
    'local weather|in contrast',
    'The museum expanded its online archive so that international scholars could examine rare documents more easily without traveling abroad.',
    'purpose clause|modal verb'
  );
