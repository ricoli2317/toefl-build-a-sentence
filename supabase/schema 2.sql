create extension if not exists "pgcrypto";

create type public.user_role as enum ('student', 'teacher');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  role public.user_role not null default 'student',
  created_at timestamptz not null default now()
);

create table public.practice_sets (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  level text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references public.practice_sets(id) on delete cascade,
  position int not null check (position between 1 and 10),
  prompt text not null,
  sentence_before text not null,
  sentence_after text not null default '',
  word_chunks text[] not null,
  correct_order text[] not null,
  created_at timestamptz not null default now(),
  unique (set_id, position)
);

create table public.attempts (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  set_id uuid not null references public.practice_sets(id) on delete cascade,
  score int not null default 0,
  total int not null default 10,
  submitted_at timestamptz not null default now()
);

create table public.answers (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.attempts(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  submitted_order text[] not null,
  is_correct boolean not null,
  created_at timestamptz not null default now(),
  unique (attempt_id, question_id)
);

create index answers_question_id_idx on public.answers(question_id);
create index attempts_student_id_idx on public.attempts(student_id);
create index attempts_set_id_idx on public.attempts(set_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    coalesce((new.raw_user_meta_data ->> 'role')::public.user_role, 'student')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.practice_sets enable row level security;
alter table public.questions enable row level security;
alter table public.attempts enable row level security;
alter table public.answers enable row level security;

create policy "profiles can read own row"
on public.profiles for select
using (auth.uid() = id);

create policy "students can read own attempts"
on public.attempts for select
using (auth.uid() = student_id);

create policy "students can read own answers"
on public.answers for select
using (
  exists (
    select 1 from public.attempts
    where attempts.id = answers.attempt_id
    and attempts.student_id = auth.uid()
  )
);

insert into public.practice_sets (id, title, description, level)
values
  ('11111111-1111-1111-1111-111111111111', 'TOEFL Sentence Set 1', 'Academic sentence structure practice.', 'Foundation');

insert into public.questions
  (set_id, position, prompt, sentence_before, sentence_after, word_chunks, correct_order)
values
  ('11111111-1111-1111-1111-111111111111', 1, 'Complete the cause-and-effect sentence.', 'The experiment demonstrated that', 'can alter plant growth.', array['limited sunlight', 'over time', 'significantly'], array['limited sunlight', 'over time', 'significantly']),
  ('11111111-1111-1111-1111-111111111111', 2, 'Build a contrast sentence.', 'Although the theory was widely accepted,', 'challenged its central assumption.', array['new evidence', 'from field studies', 'gradually'], array['new evidence', 'from field studies', 'gradually']),
  ('11111111-1111-1111-1111-111111111111', 3, 'Complete the sentence with a clear subject phrase.', '', 'explains why coastal cities face increasing flood risks.', array['The rise', 'in global sea levels', 'over recent decades'], array['The rise', 'in global sea levels', 'over recent decades']),
  ('11111111-1111-1111-1111-111111111111', 4, 'Build the sentence modifier.', 'Researchers collected samples', 'to compare seasonal changes.', array['from several remote lakes', 'during the summer', 'and winter'], array['from several remote lakes', 'during the summer', 'and winter']),
  ('11111111-1111-1111-1111-111111111111', 5, 'Complete the academic claim.', 'A successful public transportation system depends on', '.', array['reliable schedules', 'affordable fares', 'and convenient routes'], array['reliable schedules', 'affordable fares', 'and convenient routes']),
  ('11111111-1111-1111-1111-111111111111', 6, 'Build the noun phrase.', '', 'has transformed how historians interpret ancient trade.', array['The discovery', 'of shipwreck artifacts', 'near the harbor'], array['The discovery', 'of shipwreck artifacts', 'near the harbor']),
  ('11111111-1111-1111-1111-111111111111', 7, 'Complete the sentence with sequence logic.', 'After the volcano erupted,', 'across nearby farmland.', array['a layer of ash', 'settled', 'rapidly'], array['a layer of ash', 'settled', 'rapidly']),
  ('11111111-1111-1111-1111-111111111111', 8, 'Build the evidence phrase.', 'The survey suggests that', 'prefer flexible study schedules.', array['many first-year students', 'at large universities', 'strongly'], array['many first-year students', 'at large universities', 'strongly']),
  ('11111111-1111-1111-1111-111111111111', 9, 'Complete the comparison.', 'Compared with handwritten notes,', 'are easier to search and organize.', array['digital records', 'stored in cloud systems', 'often'], array['digital records', 'stored in cloud systems', 'often']),
  ('11111111-1111-1111-1111-111111111111', 10, 'Build the final clause.', 'The museum expanded its online archive so that', 'without traveling abroad.', array['international scholars', 'could examine rare documents', 'more easily'], array['international scholars', 'could examine rare documents', 'more easily']);
