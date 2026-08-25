-- Required companion migration for the writing CSV importer.
-- Safe to run repeatedly. It does not delete or backfill raw question rows.
create or replace function public.finalize_practice_import_v2(
  p_task_type text,
  p_classification text,
  p_source_set_id text,
  p_source_question_id text,
  p_candidate_item_id uuid,
  p_content_fingerprint text,
  p_normalization_version integer,
  p_first_seen_date date,
  p_display_title text,
  p_occurrences jsonb,
  p_question_map jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_id uuid;
  v_source_id uuid;
  v_display_number text;
  v_created_item boolean := false;
  v_created_source boolean := false;
  v_occurrence_count integer := 0;
  v_inserted integer;
  v_occurrence jsonb;
  v_map jsonb;
  v_map_count integer;
  v_source_order_count integer;
  v_logical_order_count integer;
  v_first_seen_before date;
  v_first_seen_after date;
begin
  if p_task_type not in ('build_sentence', 'email', 'academic_discussion') then
    raise exception 'Unsupported task_type: %', p_task_type;
  end if;
  if p_classification not in ('AUTO_MERGE', 'NEW_ITEM') then
    raise exception 'Unsupported classification: %', p_classification;
  end if;
  if (p_task_type = 'build_sentence' and (p_source_set_id is null or p_source_question_id is not null))
     or (p_task_type <> 'build_sentence' and (p_source_set_id is null or p_source_question_id is null)) then
    raise exception 'Invalid source identity for task_type %', p_task_type;
  end if;
  if jsonb_typeof(p_occurrences) <> 'array' or jsonb_array_length(p_occurrences) = 0 then
    raise exception 'At least one occurrence is required';
  end if;
  if p_task_type = 'build_sentence' and p_display_title is not null then
    raise exception 'Build a Sentence display_title must be null';
  end if;
  if p_task_type in ('email', 'academic_discussion') and nullif(btrim(p_display_title), '') is null
     and p_classification = 'NEW_ITEM' then
    raise exception 'A title is required for new writing items';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'practice-import-source:' || p_task_type || ':' || coalesce(p_source_set_id, p_source_question_id), 0
  ));

  select source_id, item_id into v_source_id, v_item_id
  from public.practice_item_sources
  where task_type = p_task_type
    and (
      (p_task_type = 'build_sentence' and source_set_id = p_source_set_id)
      or
      (p_task_type <> 'build_sentence' and source_question_id = p_source_question_id)
    )
  limit 1;

  if v_source_id is null then
    if p_classification = 'AUTO_MERGE' then
      if p_candidate_item_id is null or not exists (
        select 1 from public.practice_items where item_id = p_candidate_item_id and task_type = p_task_type
      ) then
        raise exception 'AUTO_MERGE candidate item is missing or invalid';
      end if;
      v_item_id := p_candidate_item_id;
    else
      perform pg_advisory_xact_lock(hashtextextended(
        'practice-import-fingerprint:' || p_task_type || ':' || p_content_fingerprint, 0
      ));
      select item_id into v_item_id
      from public.practice_item_sources
      where task_type = p_task_type and content_fingerprint = p_content_fingerprint
      order by is_canonical desc, created_at, source_id
      limit 1;

      if v_item_id is not null and p_task_type = 'build_sentence' then
        raise exception using
          errcode = '40001',
          message = 'Concurrent identical BAS source detected; retry import to build canonical question mapping';
      end if;

      if v_item_id is null then
        v_display_number := public.practice_import_allocate_display_number(p_task_type, p_first_seen_date);
        v_item_id := gen_random_uuid();
        insert into public.practice_items (
          item_id, task_type, display_number, display_title, first_seen_date, is_active
        ) values (
          v_item_id, p_task_type, v_display_number,
          case when p_task_type = 'build_sentence' then null else p_display_title end,
          p_first_seen_date, true
        );
        v_created_item := true;
      end if;
    end if;

    v_source_id := gen_random_uuid();
    insert into public.practice_item_sources (
      source_id, item_id, task_type, source_set_id, source_question_id,
      content_fingerprint, normalization_version, is_canonical
    ) values (
      v_source_id, v_item_id, p_task_type, p_source_set_id, p_source_question_id,
      p_content_fingerprint, p_normalization_version, v_created_item
    );
    v_created_source := true;
  end if;

  select first_seen_date into v_first_seen_before
  from public.practice_items
  where item_id = v_item_id;

  for v_occurrence in select value from jsonb_array_elements(p_occurrences) loop
    insert into public.practice_item_occurrences (occurrence_id, source_id, occurred_on, source_label)
    select gen_random_uuid(), v_source_id,
      (v_occurrence->>'occurred_on')::date,
      nullif(v_occurrence->>'source_label', '')
    where not exists (
      select 1 from public.practice_item_occurrences existing
      where existing.source_id = v_source_id
        and existing.occurred_on = (v_occurrence->>'occurred_on')::date
        and coalesce(existing.source_label, '') = coalesce(v_occurrence->>'source_label', '')
    );
    get diagnostics v_inserted = row_count;
    v_occurrence_count := v_occurrence_count + v_inserted;
  end loop;

  if p_task_type = 'build_sentence' then
    if jsonb_typeof(p_question_map) <> 'array' or jsonb_array_length(p_question_map) <> 10 then
      raise exception 'A formal BAS source requires exactly 10 question-map rows';
    end if;
    select
      count(distinct value->>'source_question_id'),
      count(distinct (value->>'source_question_order')::integer),
      count(distinct (value->>'logical_question_order')::integer)
    into v_map_count, v_source_order_count, v_logical_order_count
    from jsonb_array_elements(p_question_map)
    where (value->>'source_question_order')::integer between 1 and 10
      and (value->>'logical_question_order')::integer between 1 and 10;
    if v_map_count <> 10 or v_source_order_count <> 10 or v_logical_order_count <> 10 then
      raise exception 'BAS question map must contain distinct source/logical orders 1-10';
    end if;

    for v_map in select value from jsonb_array_elements(p_question_map) loop
      insert into public.practice_item_question_map (
        map_id, source_id, source_question_id, source_question_order,
        logical_question_order, question_fingerprint
      )
      select gen_random_uuid(), v_source_id,
        v_map->>'source_question_id',
        (v_map->>'source_question_order')::integer,
        (v_map->>'logical_question_order')::integer,
        v_map->>'question_fingerprint'
      where not exists (
        select 1 from public.practice_item_question_map existing
        where existing.source_id = v_source_id
          and existing.source_question_id = v_map->>'source_question_id'
      );
    end loop;
  end if;

  select first_seen_date into v_first_seen_after
  from public.practice_items
  where item_id = v_item_id;

  return jsonb_build_object(
    'item_id', v_item_id,
    'source_id', v_source_id,
    'created_item', v_created_item,
    'created_source', v_created_source,
    'occurrences_inserted', v_occurrence_count,
    'first_seen_before', v_first_seen_before,
    'first_seen_after', v_first_seen_after
  );
end;
$$;

revoke all on function public.finalize_practice_import_v2(
  text, text, text, text, uuid, text, integer, date, text, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.finalize_practice_import_v2(
  text, text, text, text, uuid, text, integer, date, text, jsonb, jsonb
) to service_role;

notify pgrst, 'reload schema';
