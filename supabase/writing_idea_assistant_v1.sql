-- TPS WE / AD writing idea assistant.
--
-- One shared, validated idea pool per canonical question identity, plus one
-- stable random selection per writing attempt. Pools are written only by the
-- server using the service role; clients have no table or RPC access.
--
-- Apply this file manually in the Supabase SQL Editor. It is idempotent.

begin;

create extension if not exists pgcrypto;

create table if not exists public.writing_idea_pools (
  pool_id uuid primary key default gen_random_uuid(),
  task_type text not null
    constraint writing_idea_pools_task_type_check
    check (task_type in ('email', 'academic_discussion')),
  question_source text not null
    constraint writing_idea_pools_question_source_check
    check (question_source in ('question_bank', 'custom')),
  question_id text not null
    constraint writing_idea_pools_question_id_check
    check (length(btrim(question_id)) between 1 and 200),
  status text not null default 'generating'
    constraint writing_idea_pools_status_check
    check (status in ('generating', 'ready', 'failed')),
  content jsonb,
  prompt_version text not null,
  model text,
  generation_token uuid,
  lease_expires_at timestamptz,
  generation_attempts integer not null default 0
    constraint writing_idea_pools_generation_attempts_check
    check (generation_attempts >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ready_at timestamptz,
  constraint writing_idea_pools_identity_key
    unique (task_type, question_source, question_id),
  constraint writing_idea_pools_ready_content_check
    check (
      status <> 'ready'
      or (content is not null and jsonb_typeof(content) = 'object')
    ),
  constraint writing_idea_pools_generating_token_check
    check (status <> 'generating' or generation_token is not null)
);

create index if not exists writing_idea_pools_lease_idx
  on public.writing_idea_pools (status, lease_expires_at)
  where status = 'generating';

create table if not exists public.writing_idea_selections (
  attempt_id uuid primary key
    references public.writing_attempts(attempt_id) on delete cascade,
  pool_id uuid not null
    references public.writing_idea_pools(pool_id) on delete restrict,
  student_id uuid not null
    references public.profiles(id) on delete cascade,
  task_type text not null
    constraint writing_idea_selections_task_type_check
    check (task_type in ('email', 'academic_discussion')),
  question_id text not null,
  selection jsonb not null
    constraint writing_idea_selections_selection_object_check
    check (jsonb_typeof(selection) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists writing_idea_selections_student_idx
  on public.writing_idea_selections (student_id, created_at desc);
create index if not exists writing_idea_selections_pool_idx
  on public.writing_idea_selections (pool_id);

alter table public.writing_idea_pools enable row level security;
alter table public.writing_idea_selections enable row level security;

revoke all on table public.writing_idea_pools from public, anon, authenticated;
revoke all on table public.writing_idea_selections from public, anon, authenticated;
grant all on table public.writing_idea_pools to service_role;
grant all on table public.writing_idea_selections to service_role;

-- Atomically claims the right to generate one pool. A ready pool is returned
-- immediately. A fresh generation lease returns "busy" so concurrent callers
-- poll instead of calling the AI again. Failed or expired leases are reclaimed.
create or replace function public.writing_idea_claim_pool(
  p_task_type text,
  p_question_id text,
  p_question_source text,
  p_prompt_version text,
  p_lease_seconds integer default 90
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_token uuid := gen_random_uuid();
  v_lease integer := greatest(15, least(300, coalesce(p_lease_seconds, 90)));
  v_pool_id uuid;
  v_row public.writing_idea_pools%rowtype;
  v_retry integer;
begin
  insert into public.writing_idea_pools (
    task_type,
    question_id,
    question_source,
    status,
    prompt_version,
    generation_token,
    lease_expires_at,
    generation_attempts
  ) values (
    p_task_type,
    btrim(p_question_id),
    p_question_source,
    'generating',
    coalesce(nullif(btrim(p_prompt_version), ''), 'unknown'),
    v_token,
    v_now + make_interval(secs => v_lease),
    1
  )
  on conflict (task_type, question_source, question_id) do nothing
  returning pool_id into v_pool_id;

  if v_pool_id is not null then
    return jsonb_build_object(
      'state', 'claimed',
      'pool_id', v_pool_id,
      'token', v_token
    );
  end if;

  select *
  into v_row
  from public.writing_idea_pools
  where task_type = p_task_type
    and question_source = p_question_source
    and question_id = btrim(p_question_id)
  for update;

  if not found then
    return jsonb_build_object('state', 'busy', 'retry_after_ms', 1200);
  end if;

  if v_row.status = 'ready' then
    return jsonb_build_object(
      'state', 'ready',
      'pool_id', v_row.pool_id,
      'content', v_row.content
    );
  end if;

  if v_row.status = 'generating'
     and v_row.lease_expires_at is not null
     and v_row.lease_expires_at > v_now then
    v_retry := greatest(
      750,
      least(
        5000,
        ceil(extract(epoch from (v_row.lease_expires_at - v_now)) * 1000)::integer
      )
    );
    return jsonb_build_object(
      'state', 'busy',
      'retry_after_ms', v_retry
    );
  end if;

  update public.writing_idea_pools
  set status = 'generating',
      content = null,
      prompt_version = coalesce(nullif(btrim(p_prompt_version), ''), prompt_version),
      generation_token = v_token,
      lease_expires_at = v_now + make_interval(secs => v_lease),
      generation_attempts = v_row.generation_attempts + 1,
      last_error = null,
      ready_at = null,
      updated_at = v_now
  where pool_id = v_row.pool_id
  returning pool_id into v_pool_id;

  return jsonb_build_object(
    'state', 'claimed',
    'pool_id', v_pool_id,
    'token', v_token
  );
end;
$$;

create or replace function public.writing_idea_complete_pool(
  p_pool_id uuid,
  p_token uuid,
  p_content jsonb,
  p_model text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_content is null or jsonb_typeof(p_content) <> 'object' then
    raise exception 'INVALID_WRITING_IDEA_CONTENT';
  end if;

  update public.writing_idea_pools
  set status = 'ready',
      content = p_content,
      model = nullif(left(btrim(coalesce(p_model, '')), 200), ''),
      generation_token = null,
      lease_expires_at = null,
      last_error = null,
      ready_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where pool_id = p_pool_id
    and status = 'generating'
    and generation_token = p_token;

  return found;
end;
$$;

create or replace function public.writing_idea_fail_pool(
  p_pool_id uuid,
  p_token uuid,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.writing_idea_pools
  set status = 'failed',
      content = null,
      ready_at = null,
      generation_token = null,
      lease_expires_at = null,
      last_error = left(
        coalesce(nullif(btrim(p_error), ''), 'generation_failed'),
        500
      ),
      updated_at = clock_timestamp()
  where pool_id = p_pool_id
    and status = 'generating'
    and generation_token = p_token;

  return found;
end;
$$;

revoke all on function public.writing_idea_claim_pool(text, text, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.writing_idea_complete_pool(uuid, uuid, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.writing_idea_fail_pool(uuid, uuid, text)
  from public, anon, authenticated;

grant execute on function public.writing_idea_claim_pool(text, text, text, text, integer)
  to service_role;
grant execute on function public.writing_idea_complete_pool(uuid, uuid, jsonb, text)
  to service_role;
grant execute on function public.writing_idea_fail_pool(uuid, uuid, text)
  to service_role;

commit;
