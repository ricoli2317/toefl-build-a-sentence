-- TPS question-category practice: READ-ONLY live schema preflight.
-- Run this file manually in the Supabase SQL Editor and return the JSON result.
-- No DDL, DML, business RPC calls, student rows, answers, or credentials are read.
-- Repository SQL is incomplete and is not an authoritative live schema baseline.
-- This is NOT the feature migration. Do not rerun historical initialization SQL.

with requested_tables(table_name) as (
  values
    ('profiles'),
    ('reading_logical_items'),
    ('reading_questions'),
    ('reading_question_options'),
    ('reading_passages'),
    ('reading_passage_paragraphs'),
    ('reading_passage_sentences'),
    ('reading_rap_insertion_anchors'),
    ('reading_attempts'),
    ('reading_attempt_answers'),
    ('reading_wrongbook_attempts'),
    ('reading_wrongbook_attempt_answers'),
    ('student_wrong_questions'),
    ('student_wrong_question_sessions'),
    ('student_practice_item_state'),
    ('student_practice_summary'),
    -- Proposed new names: check whether they already exist before designing DDL.
    ('reading_practice_sessions'),
    ('reading_practice_session_sources'),
    ('reading_practice_session_answers')
), selected_tables as (
  select requested.table_name, relation.oid, relation.relkind,
         relation.relrowsecurity, relation.relforcerowsecurity, relation.relacl
  from requested_tables requested
  left join pg_namespace namespace on namespace.nspname = 'public'
  left join pg_class relation
    on relation.relnamespace = namespace.oid
   and relation.relname = requested.table_name
), selected_triggers as (
  select selected.table_name, trigger_row.oid, trigger_row.tgname,
         trigger_row.tgenabled, trigger_row.tgfoid
  from selected_tables selected
  join pg_trigger trigger_row on trigger_row.tgrelid = selected.oid
  where not trigger_row.tgisinternal
), selected_functions as (
  select function_row.oid, function_row.proname, function_row.prosecdef,
         function_row.proconfig, function_row.proacl
  from pg_proc function_row
  join pg_namespace namespace on namespace.oid = function_row.pronamespace
  where namespace.nspname = 'public'
    and function_row.prokind = 'f'
    and (
      function_row.proname in (
        'get_or_create_reading_attempt',
        'submit_reading_attempt',
        'submit_reading_attempt_with_times',
        'reading_attempt_result_json',
        'retake_reading_attempt',
        'get_or_create_reading_wrongbook_attempt',
        'submit_reading_wrongbook_attempt',
        'reading_wrongbook_attempt_result_json',
        'apply_student_wrong_question_events',
        'apply_student_practice_summary_increment',
        'rebuild_student_practice_summary',
        'rebuild_student_practice_item_state',
        'rebuild_student_practice_item_state_reading'
      )
      or function_row.oid in (select tgfoid from selected_triggers)
    )
)
select jsonb_build_object(
  'tables', (
    select jsonb_agg(jsonb_build_object(
      'table', table_name,
      'exists', oid is not null,
      'kind', relkind,
      'rlsEnabled', relrowsecurity,
      'rlsForced', relforcerowsecurity,
      'acl', relacl
    ) order by table_name)
    from selected_tables
  ),
  'columns', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'table', selected.table_name,
      'column', attribute.attname,
      'type', format_type(attribute.atttypid, attribute.atttypmod),
      'notNull', attribute.attnotnull,
      'default', pg_get_expr(default_row.adbin, default_row.adrelid)
    ) order by selected.table_name, attribute.attnum), '[]'::jsonb)
    from selected_tables selected
    join pg_attribute attribute on attribute.attrelid = selected.oid
    left join pg_attrdef default_row
      on default_row.adrelid = selected.oid
     and default_row.adnum = attribute.attnum
    where attribute.attnum > 0 and not attribute.attisdropped
  ),
  'constraints', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'table', selected.table_name,
      'name', constraint_row.conname,
      'type', constraint_row.contype,
      'definition', pg_get_constraintdef(constraint_row.oid, true)
    ) order by selected.table_name, constraint_row.conname), '[]'::jsonb)
    from selected_tables selected
    join pg_constraint constraint_row on constraint_row.conrelid = selected.oid
  ),
  'indexes', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'table', selected.table_name,
      'definition', pg_get_indexdef(index_row.indexrelid)
    ) order by selected.table_name, index_row.indexrelid), '[]'::jsonb)
    from selected_tables selected
    join pg_index index_row on index_row.indrelid = selected.oid
  ),
  'policies', (
    select coalesce(jsonb_agg(to_jsonb(policy_row)
      order by policy_row.tablename, policy_row.policyname), '[]'::jsonb)
    from pg_policies policy_row
    where policy_row.schemaname = 'public'
      and policy_row.tablename in (select table_name from requested_tables)
  ),
  'triggers', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'table', table_name,
      'name', tgname,
      'enabled', tgenabled,
      'definition', pg_get_triggerdef(oid, true)
    ) order by table_name, tgname), '[]'::jsonb)
    from selected_triggers
  ),
  'functions', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'name', proname,
      'arguments', pg_get_function_identity_arguments(oid),
      'securityDefiner', prosecdef,
      'config', proconfig,
      'acl', proacl,
      'definition', pg_get_functiondef(oid)
    ) order by proname, oid), '[]'::jsonb)
    from selected_functions
  )
) as question_category_schema_preflight;
