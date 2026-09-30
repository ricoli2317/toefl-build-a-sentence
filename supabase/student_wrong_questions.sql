-- Student wrong-question bank, daily pending state, and history practice sessions.
--
-- Companion to the TPS student wrongbook redesign:
--   * lib/wrongQuestionBank.ts           (shared identity / amount rules)
--   * lib/wrongQuestionBusinessDate.ts   (one server-side business date)
--   * lib/wrongQuestionBank.server.ts    (server loaders and event application)
--   * app/api/wrong-questions/**         (summary, sessions, BAS today/entry practice)
--   * app/api/reading/wrongbook-attempts/** (Reading bank sessions/entry corrections)
--
-- Run once in the Supabase SQL Editor (manual execution by the operator).
-- The tables are maintained incrementally at practice-submit time, so the
-- wrongbook home never scans attempts / attempt_answers / Reading history.
--
-- Identity (canonical / logical question):
--   bas                -> the existing BAS wrongbook content key
--                         (`sentence:<normalized final sentence>` when present,
--                          else `question:<id>`) so different question_ids of the
--                          same logical BAS question share one row.
--   ctw / rdl / rap    -> logical_item_id:question_id:(slot_id | 'question')
--   (Full Set wrong questions use the same canonical Reading identity; the
--    occurrence_id is intentionally NOT part of the identity.)
--
-- Two responsibilities, kept apart:
--   * history: every formal-practice wrong is permanent; date-independent.
--   * daily pending: `pending_date` is the ONE business date a question is
--     currently waiting to be corrected for. A formal wrong stamps the current
--     business date (re-dating an older pending date); a successful correction
--     clears it. Rows pending for an older date simply stop matching today's
--     summary, so no midnight cleanup exists or is needed.
--
-- The business date is always derived on the Next.js server
-- (`wrongQuestionBusinessDate`, the project's Asia/Shanghai calendar rule) and
-- passed in as `p_practice_date`; the database never guesses "today" itself.

create table if not exists public.student_wrong_questions (
  student_id uuid not null references public.profiles(id) on delete cascade,
  task_type text not null check (task_type in ('bas', 'ctw', 'rdl', 'rap')),
  question_key text not null,
  logical_item_id text,
  question_id text not null,
  slot_id text,
  pending_date date,
  first_wrong_at timestamptz not null default now(),
  last_wrong_at timestamptz not null default now(),
  corrected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (student_id, task_type, question_key)
);

-- Today's summary is served from this partial index (O(today's pending rows)).
create index if not exists student_wrong_questions_pending_idx
  on public.student_wrong_questions (student_id, task_type, pending_date)
  where pending_date is not null;

alter table public.student_wrong_questions enable row level security;

revoke all on public.student_wrong_questions from public, anon, authenticated;
grant all on public.student_wrong_questions to service_role;

-- Incremental pending/history transitions. Called by the submission API routes
-- with the service-role client after a successful attempt write.
--
--   wrong      formal practice wrong for `p_practice_date`:
--                * row absent            -> insert with pending_date = today
--                * pending for today     -> unchanged (no double count)
--                * pending for an older
--                  date                  -> re-date to today (wrong again today)
--                * already corrected     -> re-open for today
--   corrected  clearing-flow correction success:
--                * pending for any date  -> clear pending_date
--                * not pending           -> unchanged
create or replace function public.apply_student_wrong_question_events(
  p_student_id uuid,
  p_practice_date date,
  p_events jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event jsonb;
  v_task_type text;
  v_question_key text;
begin
  if p_student_id is null then
    raise exception using errcode = '22023', message = 'WRONG_QUESTION_STUDENT_REQUIRED';
  end if;
  if p_practice_date is null then
    raise exception using errcode = '22023', message = 'WRONG_QUESTION_PRACTICE_DATE_REQUIRED';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception using errcode = '22023', message = 'WRONG_QUESTION_EVENTS_INVALID';
  end if;
  for v_event in select * from jsonb_array_elements(p_events) loop
    v_task_type := v_event ->> 'taskType';
    v_question_key := v_event ->> 'questionKey';
    if v_task_type is null or v_task_type not in ('bas', 'ctw', 'rdl', 'rap')
      or v_question_key is null or btrim(v_question_key) = ''
      or v_event ->> 'questionId' is null or btrim(v_event ->> 'questionId') = ''
    then
      raise exception using errcode = '22023', message = 'WRONG_QUESTION_EVENTS_INVALID';
    end if;

    if v_event ->> 'event' = 'wrong' then
      insert into public.student_wrong_questions as target (
        student_id, task_type, question_key, logical_item_id, question_id, slot_id,
        pending_date, first_wrong_at, last_wrong_at, corrected_at, updated_at
      ) values (
        p_student_id,
        v_task_type,
        v_question_key,
        nullif(btrim(coalesce(v_event ->> 'logicalItemId', '')), ''),
        btrim(v_event ->> 'questionId'),
        nullif(btrim(coalesce(v_event ->> 'slotId', '')), ''),
        p_practice_date, now(), now(), null, now()
      )
      on conflict (student_id, task_type, question_key) do update
        set pending_date = excluded.pending_date,
            corrected_at = null,
            last_wrong_at = excluded.last_wrong_at,
            updated_at = now()
        where target.pending_date is null
           or target.pending_date < excluded.pending_date;
    elsif v_event ->> 'event' = 'corrected' then
      update public.student_wrong_questions
        set pending_date = null, corrected_at = now(), updated_at = now()
        where student_id = p_student_id
          and task_type = v_task_type
          and question_key = v_question_key
          and pending_date is not null;
    else
      raise exception using errcode = '22023', message = 'WRONG_QUESTION_EVENTS_INVALID';
    end if;
  end loop;
end;
$$;

revoke all on function public.apply_student_wrong_question_events(uuid, date, jsonb) from public, anon, authenticated;
grant execute on function public.apply_student_wrong_question_events(uuid, date, jsonb) to service_role;

-- Lightweight, fixed manifest for history (and today) wrong-question practice.
-- The drawn question set and order are frozen here so a refresh / resume never
-- re-randomizes; Reading never downloads every source up front.
create table if not exists public.student_wrong_question_sessions (
  session_id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  task_type text not null check (task_type in ('bas', 'ctw', 'rdl', 'rap')),
  mode text not null check (mode in ('today', 'history')),
  amount integer check (amount between 1 and 500),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  progress jsonb not null default '{}'::jsonb check (jsonb_typeof(progress) = 'object'),
  status text not null default 'active' check (status in ('active', 'completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists student_wrong_question_sessions_student_idx
  on public.student_wrong_question_sessions (student_id, task_type, created_at desc);

alter table public.student_wrong_question_sessions enable row level security;

revoke all on public.student_wrong_question_sessions from public, anon, authenticated;
grant all on public.student_wrong_question_sessions to service_role;
