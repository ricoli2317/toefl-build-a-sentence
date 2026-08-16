create extension if not exists pgcrypto;

create table if not exists public.writing_review_ai_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  attempt_id uuid not null,
  task_type text check (task_type is null or task_type in ('email', 'academic_discussion')),
  operation text not null check (operation in ('generate_ai', 'full_regenerate', 'feedback_regenerate')),
  request_id uuid not null,
  generation_id text,
  provider_request_id text,
  model text not null,
  prompt_version text not null,
  schema_version text not null,
  status text not null check (status in ('success', 'recovered', 'failed')),
  pipeline_stage text not null check (pipeline_stage in (
    'request_preparation', 'provider_request', 'provider_response',
    'response_parsing', 'schema_validation', 'localization', 'normalization',
    'final_validation', 'review_persistence', 'unknown'
  )),
  error_type text,
  error_code text,
  error_message text,
  elapsed_ms bigint not null check (elapsed_ms >= 0),
  end_to_end_elapsed_ms bigint check (end_to_end_elapsed_ms is null or end_to_end_elapsed_ms >= 0),
  prompt_tokens bigint check (prompt_tokens is null or prompt_tokens >= 0),
  cached_tokens bigint check (cached_tokens is null or cached_tokens >= 0),
  completion_tokens bigint check (completion_tokens is null or completion_tokens >= 0),
  reasoning_tokens bigint check (reasoning_tokens is null or reasoning_tokens >= 0),
  accepted_prediction_tokens bigint check (accepted_prediction_tokens is null or accepted_prediction_tokens >= 0),
  rejected_prediction_tokens bigint check (rejected_prediction_tokens is null or rejected_prediction_tokens >= 0),
  total_tokens bigint check (total_tokens is null or total_tokens >= 0),
  cost numeric(20, 10),
  upstream_inference_cost numeric(20, 10),
  upstream_inference_prompt_cost numeric(20, 10),
  upstream_inference_completions_cost numeric(20, 10),
  provider_name text,
  http_status integer check (http_status is null or http_status between 100 and 599),
  provider_error_type text,
  provider_error_code text,
  hedge_triggered boolean,
  requests_started smallint check (requests_started is null or requests_started in (1, 2)),
  winner text check (winner is null or winner in ('primary', 'hedge')),
  primary_result text,
  primary_elapsed_ms bigint check (primary_elapsed_ms is null or primary_elapsed_ms >= 0),
  primary_cost numeric(20, 10),
  hedge_result text,
  hedge_elapsed_ms bigint check (hedge_elapsed_ms is null or hedge_elapsed_ms >= 0),
  hedge_cost numeric(20, 10),
  loser_status text,
  winner_cost numeric(20, 10),
  observed_completed_cost numeric(20, 10),
  normalization_applied boolean not null default false,
  validation_issues jsonb not null default '[]'::jsonb,
  diagnostics jsonb not null default '{}'::jsonb,
  constraint writing_review_ai_logs_validation_issues_array
    check (jsonb_typeof(validation_issues) = 'array'),
  constraint writing_review_ai_logs_diagnostics_object
    check (jsonb_typeof(diagnostics) = 'object')
);

create index if not exists writing_review_ai_logs_created_at_idx
  on public.writing_review_ai_logs (created_at desc);
create index if not exists writing_review_ai_logs_attempt_created_idx
  on public.writing_review_ai_logs (attempt_id, created_at desc);
create index if not exists writing_review_ai_logs_status_created_idx
  on public.writing_review_ai_logs (status, created_at desc);
create index if not exists writing_review_ai_logs_error_created_idx
  on public.writing_review_ai_logs (error_type, error_code, created_at desc)
  where error_type is not null;
create index if not exists writing_review_ai_logs_operation_created_idx
  on public.writing_review_ai_logs (operation, created_at desc);

alter table public.writing_review_ai_logs enable row level security;

drop policy if exists "Teachers can read writing AI logs"
  on public.writing_review_ai_logs;
create policy "Teachers can read writing AI logs"
  on public.writing_review_ai_logs
  for select
  to authenticated
  using (public.is_teacher());

revoke all on table public.writing_review_ai_logs from anon;
revoke insert, update, delete on table public.writing_review_ai_logs from authenticated;
grant select on table public.writing_review_ai_logs to authenticated;
grant all on table public.writing_review_ai_logs to service_role;
