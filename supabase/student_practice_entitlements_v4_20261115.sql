-- TPS student practice entitlements V4 (phase 4: BAS Grammar / RAP Question
-- Category practice quotas and persisted category sessions).
--
-- MANUAL, additive migration. Execute in the Supabase SQL Editor before
-- deploying the accompanying application code.
--
-- Scope:
--   * independent bas_category / rap_category spend helpers;
--   * a persisted BAS Grammar random-practice session (10 questions, 410s);
--   * an idempotent, atomic RAP Question Category Start RPC;
--   * owner-only resume/draft RPCs;
--   * service-role-only session creation; no student-callable RPC can bypass
--     the category entitlement.
--
-- This migration does NOT:
--   * enable practice_entitlement_runtime_config.enforcement_enabled;
--   * write student_practice_unlocks from either category practice;
--   * change ordinary BAS / Reading / Writing / Full Set / Wrongbook rules;
--   * delete or rewrite historical RAP category active sessions;
--   * implement teacher category assignments (phase 5).
--
-- The category quota is spent only when a new self-practice session is
-- created while enforcement is ON. Resuming, refreshing, retrying the same
-- request id, and historical sessions never spend.

begin;

-- ---------------------------------------------------------------------------
-- 0. Production-shape guards
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.practice_entitlement_enforcement_enabled()') is null
     or to_regprocedure('public.practice_entitlement_current_remaining(uuid,text)') is null then
    raise exception 'TPS_PHASE4_V3_ENTITLEMENTS_REQUIRED';
  end if;
  if to_regclass('public.reading_question_category_sessions') is null
     or to_regprocedure('public.reading_category_session_json(public.reading_question_category_sessions)') is null then
    raise exception 'TPS_PHASE4_RAP_CATEGORY_SESSION_REQUIRED';
  end if;
  if to_regclass('public.questions') is null
     or not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'questions'
         and column_name = 'grammar_tags_text'
     ) then
    raise exception 'TPS_PHASE4_GRAMMAR_QUESTIONS_SHAPE_MISMATCH';
  end if;
  if to_regclass('public.attempts') is null
     or to_regclass('public.attempt_answers') is null
     or not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'attempts'
         and column_name = 'attempt_id'
     ) then
    raise exception 'TPS_PHASE4_BAS_ATTEMPT_SHAPE_MISMATCH';
  end if;
  if to_regclass('public.practice_entitlement_runtime_config') is null then
    raise exception 'TPS_PHASE4_RUNTIME_CONFIG_REQUIRED';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Independent category quota spend
-- ---------------------------------------------------------------------------
-- This helper intentionally has no unlock side effect. BAS/RAP category
-- practice must never consume the ordinary BAS/RAP five-question quota, and it
-- must never create a student_practice_unlocks row.
create or replace function public.practice_entitlement_spend_category(
  p_student_id uuid,
  p_entitlement_kind text,
  p_reason text default 'category_practice_start',
  p_request_id text default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_remaining integer;
  v_new_remaining integer;
  v_reason text;
begin
  if p_student_id is null
     or p_entitlement_kind not in ('bas_category', 'rap_category') then
    raise exception 'INVALID_CATEGORY_PRACTICE_ENTITLEMENT';
  end if;

  -- Same per-student transaction lock as the phase-1 Admin setter. The lock
  -- covers both category kinds, so concurrent BAS and RAP starts cannot
  -- overdraw either row.
  perform pg_advisory_xact_lock(hashtextextended(p_student_id::text, 0));

  v_remaining := public.practice_entitlement_current_remaining(
    p_student_id,
    p_entitlement_kind
  );
  if v_remaining is null then
    raise exception 'PRACTICE_ENTITLEMENT_DEFAULT_NOT_FOUND';
  end if;
  if v_remaining <= 0 then
    raise exception 'PRACTICE_ENTITLEMENT_CATEGORY_EXHAUSTED';
  end if;

  v_new_remaining := v_remaining - 1;
  insert into public.student_practice_entitlements as entitlements (
    student_id, entitlement_kind, remaining, updated_at, updated_by
  ) values (
    p_student_id, p_entitlement_kind, v_new_remaining, clock_timestamp(), p_student_id
  )
  on conflict on constraint student_practice_entitlements_pkey do update
  set remaining = excluded.remaining,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by;

  v_reason := left(coalesce(nullif(btrim(p_reason), ''), 'category_practice_start'), 500);
  insert into public.student_practice_entitlement_events (
    student_id, entitlement_kind, operation, reason,
    previous_remaining, new_remaining, actor_id,
    item_id, assignment_id, request_id
  ) values (
    p_student_id, p_entitlement_kind, 'spend', v_reason,
    v_remaining, v_new_remaining, p_student_id,
    null, null, nullif(btrim(p_request_id), '')
  );

  return v_new_remaining;
end;
$$;

revoke all on function public.practice_entitlement_spend_category(uuid,text,text,text)
  from public, anon, authenticated;
grant execute on function public.practice_entitlement_spend_category(uuid,text,text,text)
  to service_role;

comment on function public.practice_entitlement_spend_category(uuid,text,text,text) is
  'Atomic category quota spend. Never writes ordinary unlock rows.';

-- ---------------------------------------------------------------------------
-- 2. BAS Grammar persisted random session
-- ---------------------------------------------------------------------------
create table if not exists public.bas_grammar_practice_sessions (
  session_id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  category text not null,
  mode text not null default 'random',
  origin text not null default 'self_practice',
  assignment_id uuid,
  start_request_id uuid,
  manifest jsonb not null,
  draft jsonb not null default '{}'::jsonb,
  status text not null default 'active',
  elapsed_seconds integer not null default 0,
  total_questions integer not null default 0,
  correct_count integer not null default 0,
  attempt_id uuid references public.attempts(attempt_id) on delete set null,
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint bas_grammar_practice_sessions_category_check
    check (nullif(btrim(category), '') is not null),
  constraint bas_grammar_practice_sessions_mode_check
    check (mode = 'random'),
  constraint bas_grammar_practice_sessions_origin_check
    check (origin in ('self_practice', 'teacher_assigned')),
  constraint bas_grammar_practice_sessions_manifest_check
    check (jsonb_typeof(manifest) = 'object'),
  constraint bas_grammar_practice_sessions_draft_check
    check (jsonb_typeof(draft) = 'object'),
  constraint bas_grammar_practice_sessions_status_check
    check (status in ('active', 'completed')),
  constraint bas_grammar_practice_sessions_elapsed_check
    check (elapsed_seconds between 0 and 604800),
  constraint bas_grammar_practice_sessions_total_check
    check (total_questions between 0 and 10),
  constraint bas_grammar_practice_sessions_correct_check
    check (correct_count between 0 and total_questions),
  constraint bas_grammar_practice_sessions_completion_shape_check
    check (
      (status = 'active' and completed_at is null)
      or (status = 'completed' and completed_at is not null)
    )
);

create unique index if not exists bas_grammar_practice_student_request_uidx
  on public.bas_grammar_practice_sessions(student_id, start_request_id)
  where start_request_id is not null;
create unique index if not exists bas_grammar_practice_attempt_uidx
  on public.bas_grammar_practice_sessions(attempt_id)
  where attempt_id is not null;
create index if not exists bas_grammar_practice_student_status_idx
  on public.bas_grammar_practice_sessions(student_id, status, started_at desc);

alter table public.bas_grammar_practice_sessions enable row level security;
revoke all on table public.bas_grammar_practice_sessions
  from public, anon, authenticated;
grant select, insert, update, delete on table public.bas_grammar_practice_sessions
  to service_role;

comment on table public.bas_grammar_practice_sessions is
  'Persisted BAS Grammar random practice. Manifest is frozen at Start; only service-role session creation is allowed.';

-- Parse the existing questions.grammar_tags_text representation. The JS
-- loader accepts either a JSON array string or a semicolon-delimited string.
create or replace function public.practice_grammar_question_has_tag(
  p_tags text,
  p_tag text
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_tags text;
  v_item jsonb;
begin
  v_tags := btrim(coalesce(p_tags, ''));
  if v_tags = '' or v_tags = '[]' or nullif(btrim(p_tag), '') is null then
    return false;
  end if;

  if left(v_tags, 1) = '[' and right(v_tags, 1) = ']' then
    begin
      for v_item in select value from jsonb_array_elements(v_tags::jsonb) loop
        if btrim(v_item #>> '{}') = btrim(p_tag) then
          return true;
        end if;
      end loop;
      return false;
    exception when others then
      -- Fall through to the legacy semicolon representation.
      null;
    end;
  end if;

  return exists (
    select 1
    from unnest(string_to_array(v_tags, ';')) part
    where btrim(part) = btrim(p_tag)
  );
end;
$$;

revoke all on function public.practice_grammar_question_has_tag(text,text)
  from public, anon, authenticated;

create or replace function public.guard_bas_grammar_practice_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if tg_op = 'UPDATE' then
    if new.student_id is distinct from old.student_id
       or new.category is distinct from old.category
       or new.mode is distinct from old.mode
       or new.origin is distinct from old.origin
       or new.assignment_id is distinct from old.assignment_id
       or new.start_request_id is distinct from old.start_request_id
       or new.manifest is distinct from old.manifest then
      raise exception 'BAS_GRAMMAR_SESSION_IDENTITY_IMMUTABLE';
    end if;
    if old.status = 'completed' and (
      new.status is distinct from old.status
      or new.completed_at is distinct from old.completed_at
      or new.elapsed_seconds is distinct from old.elapsed_seconds
      or new.total_questions is distinct from old.total_questions
      or new.correct_count is distinct from old.correct_count
      or new.attempt_id is distinct from old.attempt_id
      or new.draft is distinct from old.draft
    ) then
      raise exception 'BAS_GRAMMAR_SESSION_COMPLETED_IMMUTABLE';
    end if;
    return new;
  end if;

  if new.mode <> 'random' or new.origin <> 'self_practice' then
    raise exception 'BAS_GRAMMAR_ORIGIN_NOT_AVAILABLE';
  end if;
  if not exists (
    select 1 from public.profiles profile
    where profile.id = new.student_id
      and profile.is_active
      and profile.role::text in ('student', 'teacher', 'admin')
  ) then
    raise exception 'BAS_GRAMMAR_STUDENT_REQUIRED';
  end if;
  if new.manifest ->> 'kind' is distinct from 'bas_grammar'
     or new.manifest ->> 'category' is distinct from new.category
     or jsonb_typeof(new.manifest -> 'questions') is distinct from 'array' then
    raise exception 'BAS_GRAMMAR_INVALID_MANIFEST';
  end if;

  v_count := jsonb_array_length(new.manifest -> 'questions');
  if v_count < 1 or v_count > 10 then
    raise exception 'BAS_GRAMMAR_INVALID_MANIFEST';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(new.manifest -> 'questions') question
    where jsonb_typeof(question) is distinct from 'object'
      or nullif(btrim(question ->> 'question_id'), '') is null
  ) or exists (
    select 1
    from jsonb_array_elements(new.manifest -> 'questions') question
    group by question ->> 'question_id'
    having count(*) > 1
  ) or exists (
    select 1
    from jsonb_array_elements(new.manifest -> 'questions') question
    left join public.questions source
      on source.question_id::text = question ->> 'question_id'
    where source.question_id is null
      or not public.practice_grammar_question_has_tag(
        source.grammar_tags_text,
        new.category
      )
  ) then
    raise exception 'BAS_GRAMMAR_INVALID_MANIFEST';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_bas_grammar_practice_session()
  from public, anon, authenticated;

drop trigger if exists bas_grammar_practice_session_guard
  on public.bas_grammar_practice_sessions;
create trigger bas_grammar_practice_session_guard
before insert or update on public.bas_grammar_practice_sessions
for each row execute function public.guard_bas_grammar_practice_session();

create or replace function public.touch_bas_grammar_practice_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

revoke all on function public.touch_bas_grammar_practice_session()
  from public, anon, authenticated;

drop trigger if exists bas_grammar_practice_session_updated_at
  on public.bas_grammar_practice_sessions;
create trigger bas_grammar_practice_session_updated_at
before update on public.bas_grammar_practice_sessions
for each row execute function public.touch_bas_grammar_practice_session();

create or replace function public.bas_grammar_session_json(
  p_session public.bas_grammar_practice_sessions
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'sessionId', p_session.session_id,
    'category', p_session.category,
    'mode', p_session.mode,
    'origin', p_session.origin,
    'status', p_session.status,
    'questions', p_session.manifest -> 'questions',
    'draft', p_session.draft,
    'startedAt', p_session.started_at,
    'completedAt', p_session.completed_at,
    'elapsedSeconds', p_session.elapsed_seconds,
    'totalQuestions', p_session.total_questions,
    'correctCount', p_session.correct_count,
    'attemptId', p_session.attempt_id
  );
$$;

revoke all on function public.bas_grammar_session_json(public.bas_grammar_practice_sessions)
  from public, anon, authenticated;

-- Service-role only. The Next.js route verifies the caller and draws the
-- manifest from the canonical questions table; this function validates the
-- manifest and spends + inserts in one transaction.
create or replace function public.start_bas_grammar_practice_session(
  p_student_id uuid,
  p_category text,
  p_manifest jsonb,
  p_request_id uuid,
  p_origin text default 'self_practice',
  p_assignment_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_existing public.bas_grammar_practice_sessions%rowtype;
  v_session public.bas_grammar_practice_sessions%rowtype;
  v_origin text;
begin
  if p_student_id is null or p_request_id is null
     or nullif(btrim(p_category), '') is null
     or jsonb_typeof(p_manifest) is distinct from 'object' then
    raise exception 'BAS_GRAMMAR_INVALID_START';
  end if;

  v_origin := coalesce(nullif(btrim(p_origin), ''), 'self_practice');
  if v_origin <> 'self_practice' or p_assignment_id is not null then
    raise exception 'BAS_GRAMMAR_ORIGIN_NOT_AVAILABLE';
  end if;

  select profile.role::text into v_role
  from public.profiles profile
  where profile.id = p_student_id and profile.is_active;
  if v_role is null or v_role not in ('student', 'teacher', 'admin') then
    raise exception using errcode = '42501', message = 'BAS_GRAMMAR_STUDENT_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_student_id::text, 0));

  select * into v_existing
  from public.bas_grammar_practice_sessions session
  where session.student_id = p_student_id
    and session.start_request_id = p_request_id;
  if found then
    if v_existing.category is distinct from btrim(p_category) then
      raise exception 'BAS_GRAMMAR_REQUEST_ID_CONFLICT';
    end if;
    return jsonb_build_object(
      'created', false,
      'session', public.bas_grammar_session_json(v_existing)
    );
  end if;

  if public.practice_entitlement_enforcement_enabled() and v_role = 'student' then
    perform public.practice_entitlement_spend_category(
      p_student_id,
      'bas_category',
      'grammar_category_start',
      p_request_id::text
    );
  end if;

  insert into public.bas_grammar_practice_sessions (
    student_id, category, mode, origin, assignment_id,
    start_request_id, manifest
  ) values (
    p_student_id, btrim(p_category), 'random', 'self_practice', null,
    p_request_id, p_manifest
  )
  returning * into v_session;

  return jsonb_build_object(
    'created', true,
    'session', public.bas_grammar_session_json(v_session)
  );
end;
$$;

revoke all on function public.start_bas_grammar_practice_session(uuid,text,jsonb,uuid,text,uuid)
  from public, anon, authenticated;
grant execute on function public.start_bas_grammar_practice_session(uuid,text,jsonb,uuid,text,uuid)
  to service_role;

create or replace function public.get_bas_grammar_practice_session(
  p_session_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_session public.bas_grammar_practice_sessions%rowtype;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'BAS_GRAMMAR_UNAUTHORIZED';
  end if;
  if not exists (
    select 1 from public.profiles profile
    where profile.id = auth.uid()
      and profile.is_active
      and profile.role in ('student', 'teacher', 'admin')
  ) then
    raise exception using errcode = '42501', message = 'BAS_GRAMMAR_UNAUTHORIZED';
  end if;

  select * into v_session
  from public.bas_grammar_practice_sessions session
  where session.session_id = p_session_id
    and session.student_id = auth.uid();
  if not found then
    raise exception 'BAS_GRAMMAR_SESSION_NOT_FOUND';
  end if;

  return jsonb_build_object(
    'session', public.bas_grammar_session_json(v_session)
  );
end;
$$;

revoke all on function public.get_bas_grammar_practice_session(uuid)
  from public, anon, authenticated;
grant execute on function public.get_bas_grammar_practice_session(uuid)
  to authenticated;

create or replace function public.save_bas_grammar_practice_draft(
  p_session_id uuid,
  p_draft jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session public.bas_grammar_practice_sessions%rowtype;
  v_question_count integer;
  v_revision bigint;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'BAS_GRAMMAR_UNAUTHORIZED';
  end if;
  if jsonb_typeof(p_draft) is distinct from 'object'
     or jsonb_typeof(p_draft -> 'answers') is distinct from 'object'
     or jsonb_typeof(p_draft -> 'questionTimes') is distinct from 'object'
     or not coalesce(p_draft ->> 'currentIndex', '') ~ '^[0-9]{1,2}$'
     or not coalesce(p_draft ->> 'elapsedSeconds', '') ~ '^[0-9]{1,6}$'
     or not coalesce(p_draft ->> 'revision', '') ~ '^[0-9]{1,16}$' then
    raise exception 'BAS_GRAMMAR_INVALID_DRAFT';
  end if;

  select * into v_session
  from public.bas_grammar_practice_sessions session
  where session.session_id = p_session_id
    and session.student_id = auth.uid()
  for update;
  if not found then
    raise exception 'BAS_GRAMMAR_SESSION_NOT_FOUND';
  end if;
  if v_session.status = 'completed' then
    return;
  end if;

  v_question_count := jsonb_array_length(v_session.manifest -> 'questions');
  v_revision := (p_draft ->> 'revision')::bigint;
  if v_revision < 1
     or v_revision > 9007199254740991
     or (p_draft ->> 'currentIndex')::integer >= v_question_count
     or (p_draft ->> 'elapsedSeconds')::integer > 604800
     or exists (
       select 1
       from jsonb_object_keys(p_draft -> 'answers') answer_key
       where not exists (
         select 1
         from jsonb_array_elements(v_session.manifest -> 'questions') question
         where question ->> 'question_id' = answer_key
       )
     )
     or exists (
       select 1
       from jsonb_each(p_draft -> 'answers') answer
       where jsonb_typeof(answer.value) is distinct from 'array'
          or jsonb_array_length(answer.value) > 10
     )
     or exists (
       select 1
       from jsonb_each_text(p_draft -> 'questionTimes') time
       where not time.value ~ '^[0-9]{1,6}$'
          or time.value::integer > 604800
          or not exists (
            select 1
            from jsonb_array_elements(v_session.manifest -> 'questions') question
            where question ->> 'question_id' = time.key
          )
     ) then
    raise exception 'BAS_GRAMMAR_INVALID_DRAFT';
  end if;

  -- A late packet from another tab cannot overwrite a newer snapshot.
  if v_revision <= coalesce((v_session.draft ->> 'revision')::bigint, 0) then
    return;
  end if;

  update public.bas_grammar_practice_sessions
  set draft = p_draft,
      elapsed_seconds = greatest(elapsed_seconds, (p_draft ->> 'elapsedSeconds')::integer)
  where session_id = p_session_id;
end;
$$;

revoke all on function public.save_bas_grammar_practice_draft(uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.save_bas_grammar_practice_draft(uuid,jsonb)
  to authenticated;

create or replace function public.complete_bas_grammar_practice_session(
  p_student_id uuid,
  p_session_id uuid,
  p_attempt_id uuid,
  p_correct_count integer,
  p_total_questions integer,
  p_elapsed_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session public.bas_grammar_practice_sessions%rowtype;
  v_total integer;
  v_answer_count integer;
begin
  if p_student_id is null or p_session_id is null or p_attempt_id is null
     or p_correct_count is null or p_total_questions is null or p_elapsed_seconds is null
     or p_correct_count < 0 or p_elapsed_seconds < 0 or p_elapsed_seconds > 604800 then
    raise exception 'BAS_GRAMMAR_INVALID_COMPLETION';
  end if;

  select * into v_session
  from public.bas_grammar_practice_sessions session
  where session.session_id = p_session_id
    and session.student_id = p_student_id
  for update;
  if not found then
    raise exception 'BAS_GRAMMAR_SESSION_NOT_FOUND';
  end if;

  v_total := jsonb_array_length(v_session.manifest -> 'questions');
  if p_total_questions <> v_total or p_correct_count > v_total then
    raise exception 'BAS_GRAMMAR_INVALID_COMPLETION';
  end if;

  if v_session.status = 'completed' then
    if v_session.attempt_id = p_attempt_id then
      return public.bas_grammar_session_json(v_session);
    end if;
    raise exception 'BAS_GRAMMAR_SESSION_COMPLETED';
  end if;

  if not exists (
    select 1
    from public.attempts attempt
    where attempt.attempt_id = p_attempt_id
      and attempt.student_id = p_student_id
      and attempt.set_id::text = 'grammar-random-' || p_session_id::text
      and attempt.correct_count = p_correct_count
      and attempt.total_questions = v_total
  ) then
    raise exception 'BAS_GRAMMAR_ATTEMPT_MISMATCH';
  end if;

  select count(*) into v_answer_count
  from public.attempt_answers answer
  where answer.attempt_id = p_attempt_id;
  if v_answer_count <> v_total
     or exists (
       select 1
       from public.attempt_answers answer
       where answer.attempt_id = p_attempt_id
         and not exists (
           select 1
           from jsonb_array_elements(v_session.manifest -> 'questions') question
           where question ->> 'question_id' = answer.question_id::text
         )
     ) then
    raise exception 'BAS_GRAMMAR_ATTEMPT_MISMATCH';
  end if;

  update public.bas_grammar_practice_sessions
  set status = 'completed',
      attempt_id = p_attempt_id,
      correct_count = p_correct_count,
      total_questions = v_total,
      elapsed_seconds = greatest(elapsed_seconds, p_elapsed_seconds),
      draft = '{}'::jsonb,
      completed_at = clock_timestamp()
  where session_id = p_session_id
  returning * into v_session;

  return public.bas_grammar_session_json(v_session);
end;
$$;

revoke all on function public.complete_bas_grammar_practice_session(uuid,uuid,uuid,integer,integer,integer)
  from public, anon, authenticated;
grant execute on function public.complete_bas_grammar_practice_session(uuid,uuid,uuid,integer,integer,integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. RAP Question Category idempotent Start
-- ---------------------------------------------------------------------------
alter table public.reading_question_category_sessions
  add column if not exists start_request_id uuid;
alter table public.reading_question_category_sessions
  add column if not exists origin text;
alter table public.reading_question_category_sessions
  add column if not exists assignment_id uuid;

update public.reading_question_category_sessions
set origin = 'self_practice'
where origin is null;

alter table public.reading_question_category_sessions
  alter column origin set default 'self_practice';
alter table public.reading_question_category_sessions
  alter column origin set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.reading_question_category_sessions'::regclass
      and conname = 'reading_category_session_origin_check'
  ) then
    alter table public.reading_question_category_sessions
      add constraint reading_category_session_origin_check
      check (origin in ('self_practice', 'teacher_assigned'));
  end if;
end;
$$;

create unique index if not exists reading_category_student_request_uidx
  on public.reading_question_category_sessions(student_id, start_request_id)
  where start_request_id is not null;
create index if not exists reading_category_student_active_idx
  on public.reading_question_category_sessions(student_id, question_category, created_at desc)
  where status = 'active';

-- The legacy manifest guard freezes manifest identity. This additional guard
-- freezes the phase-4 origin/request columns without rewriting that function.
create or replace function public.guard_reading_category_practice_origin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (
    new.origin is distinct from old.origin
    or new.assignment_id is distinct from old.assignment_id
    or new.start_request_id is distinct from old.start_request_id
  ) then
    raise exception 'READING_INVALID_CATEGORY_MANIFEST_MUTATION';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_reading_category_practice_origin()
  from public, anon, authenticated;

drop trigger if exists reading_category_practice_origin_guard
  on public.reading_question_category_sessions;
create trigger reading_category_practice_origin_guard
before update on public.reading_question_category_sessions
for each row execute function public.guard_reading_category_practice_origin();

create or replace function public.reading_category_session_json(
  p_session public.reading_question_category_sessions
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'sessionId', p_session.session_id,
    'questionCategory', p_session.question_category,
    'amount', p_session.amount,
    'groups', p_session.manifest -> 'groups',
    'progress', p_session.progress,
    'draft', p_session.draft,
    'status', p_session.status,
    'elapsedSeconds', p_session.elapsed_seconds,
    'totalPoints', p_session.total_points,
    'correctPoints', p_session.correct_points,
    'createdAt', p_session.created_at,
    'completedAt', p_session.completed_at,
    'origin', p_session.origin,
    'assignmentId', p_session.assignment_id,
    'startRequestId', p_session.start_request_id
  );
$$;

revoke all on function public.reading_category_session_json(public.reading_question_category_sessions)
  from public, anon, authenticated;

-- Service-role only. The Next.js route draws the frozen manifest; this function
-- validates its basic shape, then spends + inserts in one transaction.
create or replace function public.start_reading_question_category_practice(
  p_student_id uuid,
  p_question_category text,
  p_amount integer,
  p_manifest jsonb,
  p_request_id uuid,
  p_origin text default 'self_practice',
  p_assignment_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_origin text;
  v_existing public.reading_question_category_sessions%rowtype;
  v_session public.reading_question_category_sessions%rowtype;
begin
  if p_student_id is null or p_request_id is null
     or p_question_category is null
     or p_question_category not in (
       '事实信息题','否定信息题','主旨题','词汇题','选句题',
       '句子简化题','指代题','推断题','修辞目的题','句子插入题'
     )
     or p_amount not in (5, 10, 15, 20)
     or jsonb_typeof(p_manifest) is distinct from 'object'
     or p_manifest ->> 'kind' is distinct from 'question_category'
     or p_manifest ->> 'category' is distinct from p_question_category
     or jsonb_typeof(p_manifest -> 'groups') is distinct from 'array'
     or jsonb_array_length(p_manifest -> 'groups') = 0 then
    raise exception 'READING_INVALID_CATEGORY_START';
  end if;

  v_origin := coalesce(nullif(btrim(p_origin), ''), 'self_practice');
  if v_origin <> 'self_practice' or p_assignment_id is not null then
    raise exception 'CATEGORY_PRACTICE_ORIGIN_NOT_AVAILABLE';
  end if;

  select profile.role::text into v_role
  from public.profiles profile
  where profile.id = p_student_id and profile.is_active;
  if v_role is null or v_role not in ('student', 'teacher', 'admin') then
    raise exception using errcode = '42501', message = 'READING_STUDENT_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_student_id::text, 0));

  select * into v_existing
  from public.reading_question_category_sessions session
  where session.student_id = p_student_id
    and session.start_request_id = p_request_id;
  if found then
    if v_existing.question_category is distinct from p_question_category
       or v_existing.amount <> p_amount then
      raise exception 'CATEGORY_REQUEST_ID_CONFLICT';
    end if;
    return jsonb_build_object(
      'created', false,
      'session', public.reading_category_session_json(v_existing),
      'answers', public.reading_category_answers_json(v_existing.session_id)
    );
  end if;

  if public.practice_entitlement_enforcement_enabled() and v_role = 'student' then
    perform public.practice_entitlement_spend_category(
      p_student_id,
      'rap_category',
      'rap_category_start',
      p_request_id::text
    );
  end if;

  insert into public.reading_question_category_sessions (
    student_id, question_category, amount, manifest,
    start_request_id, origin, assignment_id
  ) values (
    p_student_id, p_question_category, p_amount, p_manifest,
    p_request_id, 'self_practice', null
  )
  returning * into v_session;

  return jsonb_build_object(
    'created', true,
    'session', public.reading_category_session_json(v_session),
    'answers', '[]'::jsonb
  );
end;
$$;

revoke all on function public.start_reading_question_category_practice(uuid,text,integer,jsonb,uuid,text,uuid)
  from public, anon, authenticated;
grant execute on function public.start_reading_question_category_practice(uuid,text,integer,jsonb,uuid,text,uuid)
  to service_role;

comment on function public.start_reading_question_category_practice(uuid,text,integer,jsonb,uuid,text,uuid) is
  'Idempotent RAP category Start. Request id retries return the same session without a second spend.';

notify pgrst, 'reload schema';

commit;
