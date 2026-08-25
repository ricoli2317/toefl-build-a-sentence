-- Adds the missing teacher confirmation transaction for pending writing duplicates.
-- Safe to run repeatedly. It does not delete or rewrite raw question records.
create or replace function public.queue_practice_import_review_v2(
  p_task_type text,
  p_source_set_id text,
  p_source_question_id text,
  p_candidate_item_id uuid,
  p_candidate_item_ids jsonb,
  p_similarity_summary jsonb,
  p_occurrences jsonb,
  p_content_fingerprint text,
  p_normalization_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_review_id uuid;
  v_created boolean := false;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'practice-import-source:' || p_task_type || ':' || coalesce(p_source_set_id, p_source_question_id), 0
  ));

  select review_id into v_review_id
  from public.practice_import_review_queue
  where task_type = p_task_type
    and source_set_id is not distinct from p_source_set_id
    and source_question_id is not distinct from p_source_question_id
    and status = 'pending'
  limit 1;

  if v_review_id is null then
    v_review_id := gen_random_uuid();
    insert into public.practice_import_review_queue (
      review_id, task_type, source_set_id, source_question_id, candidate_item_id,
      candidate_item_ids, similarity_summary, occurrences, content_fingerprint, normalization_version
    ) values (
      v_review_id, p_task_type, p_source_set_id, p_source_question_id, p_candidate_item_id,
      coalesce(p_candidate_item_ids, '[]'::jsonb), coalesce(p_similarity_summary, '{}'::jsonb),
      coalesce(p_occurrences, '[]'::jsonb), p_content_fingerprint, p_normalization_version
    );
    v_created := true;
  else
    update public.practice_import_review_queue
    set candidate_item_id = p_candidate_item_id,
        candidate_item_ids = coalesce(p_candidate_item_ids, '[]'::jsonb),
        similarity_summary = coalesce(p_similarity_summary, '{}'::jsonb),
        occurrences = coalesce(p_occurrences, '[]'::jsonb),
        content_fingerprint = p_content_fingerprint,
        normalization_version = p_normalization_version
    where review_id = v_review_id;
  end if;

  return jsonb_build_object('review_id', v_review_id, 'created', v_created);
end;
$$;

create or replace function public.resolve_practice_import_review_v2(
  p_review_id uuid,
  p_resolution text,
  p_candidate_item_id uuid default null,
  p_display_title text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_review public.practice_import_review_queue%rowtype;
  v_source_set_id text;
  v_candidate_item_id uuid;
  v_display_title text;
  v_first_seen_date date;
  v_result jsonb;
  v_numbering_reason text;
  v_numbering_result jsonb := jsonb_build_object('changes', 0);
  v_existing_item_id uuid;
begin
  if p_resolution not in ('merge', 'new') then
    raise exception using errcode = '22023', message = 'Resolution must be merge or new';
  end if;

  select * into v_review
  from public.practice_import_review_queue
  where review_id = p_review_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Practice import review was not found';
  end if;

  if v_review.task_type not in ('email', 'academic_discussion') then
    raise exception using
      errcode = '0A000',
      message = 'Only Email and Academic Discussion reviews can currently be resolved here';
  end if;

  if v_review.status <> 'pending' then
    select item_id into v_existing_item_id
    from public.practice_item_sources
    where task_type = v_review.task_type
      and source_question_id = v_review.source_question_id
    limit 1;
    return jsonb_build_object(
      'review_id', v_review.review_id,
      'status', v_review.status,
      'item_id', v_existing_item_id,
      'already_resolved', true,
      'occurrences_inserted', 0,
      'numbering_changes', 0
    );
  end if;

  if v_review.task_type = 'email' then
    select set_id into v_source_set_id
    from public.email_questions
    where question_id = v_review.source_question_id;
  else
    select set_id into v_source_set_id
    from public.academic_discussion_questions
    where question_id = v_review.source_question_id;
  end if;

  if nullif(btrim(v_source_set_id), '') is null then
    raise exception using
      errcode = 'P0002',
      message = 'The raw question for this review is missing';
  end if;

  if jsonb_typeof(v_review.occurrences) <> 'array'
     or jsonb_array_length(v_review.occurrences) = 0 then
    raise exception using
      errcode = '23514',
      message = 'The review has no occurrence records';
  end if;

  select min((occurrence->>'occurred_on')::date) into v_first_seen_date
  from jsonb_array_elements(v_review.occurrences) occurrence;

  if p_resolution = 'merge' then
    v_candidate_item_id := coalesce(p_candidate_item_id, v_review.candidate_item_id);
    if v_candidate_item_id is null
       or not (
         v_candidate_item_id = v_review.candidate_item_id
         or exists (
           select 1
           from jsonb_array_elements_text(coalesce(v_review.candidate_item_ids, '[]'::jsonb)) candidate(value)
           where candidate.value = v_candidate_item_id::text
         )
       ) then
      raise exception using
        errcode = '22023',
        message = 'The selected merge candidate is not part of this review';
    end if;
  else
    v_candidate_item_id := null;
    v_display_title := coalesce(
      nullif(btrim(p_display_title), ''),
      nullif(btrim(v_review.similarity_summary->>'proposedDisplayTitle'), '')
    );
    if v_display_title is null then
      raise exception using
        errcode = '23502',
        message = 'A logical title is required when confirming a new writing item',
        column = 'display_title',
        table = 'practice_items';
    end if;
  end if;

  select public.finalize_practice_import_v2(
    v_review.task_type,
    case when p_resolution = 'merge' then 'AUTO_MERGE' else 'NEW_ITEM' end,
    v_source_set_id,
    v_review.source_question_id,
    v_candidate_item_id,
    v_review.content_fingerprint,
    v_review.normalization_version,
    v_first_seen_date,
    v_display_title,
    v_review.occurrences,
    '[]'::jsonb
  ) into v_result;

  if coalesce((v_result->>'created_item')::boolean, false) then
    v_numbering_reason := 'historical_new_item_insert';
  elsif (v_result->>'first_seen_before') is not null
        and (v_result->>'first_seen_after')::date < (v_result->>'first_seen_before')::date then
    v_numbering_reason := 'earlier_duplicate_occurrence';
  end if;

  if v_numbering_reason is not null then
    select public.reconcile_practice_item_numbers_v2(
      v_review.task_type,
      jsonb_build_array(jsonb_build_object(
        'item_id', v_result->>'item_id',
        'reason', v_numbering_reason
      ))
    ) into v_numbering_result;
  end if;

  update public.practice_import_review_queue
  set status = case when p_resolution = 'merge' then 'resolved_merge' else 'resolved_new' end,
      resolved_at = now()
  where review_id = v_review.review_id;

  return jsonb_build_object(
    'review_id', v_review.review_id,
    'status', case when p_resolution = 'merge' then 'resolved_merge' else 'resolved_new' end,
    'item_id', v_result->>'item_id',
    'created_item', coalesce((v_result->>'created_item')::boolean, false),
    'created_source', coalesce((v_result->>'created_source')::boolean, false),
    'occurrences_inserted', coalesce((v_result->>'occurrences_inserted')::integer, 0),
    'numbering_changes', coalesce((v_numbering_result->>'changes')::integer, 0),
    'already_resolved', false
  );
end;
$$;

revoke all on function public.queue_practice_import_review_v2(
  text, text, text, uuid, jsonb, jsonb, jsonb, text, integer
) from public, anon, authenticated;
grant execute on function public.queue_practice_import_review_v2(
  text, text, text, uuid, jsonb, jsonb, jsonb, text, integer
) to service_role;

revoke all on function public.resolve_practice_import_review_v2(uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.resolve_practice_import_review_v2(uuid, text, uuid, text)
  to service_role;

notify pgrst, 'reload schema';
