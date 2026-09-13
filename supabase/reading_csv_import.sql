-- One transaction boundary for one normalized ReadingImportPackage.
-- No new tables/columns are required. Existing canonical content changes only
-- when the caller sends an explicitly confirmed replace_canonical_content flag;
-- RDL display-title normalization remains safe on ordinary reuse.

create or replace function public.import_reading_package_atomic(
  p_rows jsonb,
  p_created_by uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_logical_item_id text;
  v_module text;
  v_dedup_fingerprint text;
  v_fingerprint_owner_id text;
  v_fingerprint_owner_module text;
  v_id_owner_fingerprint text;
  v_expected_logical_item_action text;
  v_logical_item_existed boolean := false;
  v_occurrence_count integer := 0;
  v_existing_occurrence_count integer := 0;
  v_existing_question_count integer := 0;
  v_question_count integer := 0;
  v_replace_canonical_content boolean := false;
begin
  if jsonb_array_length(coalesce(p_rows->'reading_logical_items', '[]'::jsonb)) <> 1 then
    raise exception 'Reading atomic import requires exactly one logical item';
  end if;

  select logical_item_id, module, dedup_fingerprint
  into v_logical_item_id, v_module, v_dedup_fingerprint
  from jsonb_to_recordset(p_rows->'reading_logical_items') as x(
    logical_item_id text, module text, dedup_fingerprint text
  );

  v_replace_canonical_content := coalesce((p_rows->>'replace_canonical_content')::boolean, false);
  v_expected_logical_item_action := nullif(p_rows->>'expected_logical_item_action', '');
  if v_expected_logical_item_action is not null
    and v_expected_logical_item_action not in ('reuse_existing', 'create_new') then
    raise exception 'Invalid expected Reading logical item action: %', v_expected_logical_item_action;
  end if;

  -- Fingerprint locking closes the gap between a batch preflight snapshot and
  -- later per-item execution. The unique key remains the final database guard.
  perform pg_advisory_xact_lock(hashtextextended('reading-dedup:' || v_dedup_fingerprint, 0));
  perform pg_advisory_xact_lock(hashtextextended(v_logical_item_id, 0));

  select item.logical_item_id, item.module
  into v_fingerprint_owner_id, v_fingerprint_owner_module
  from public.reading_logical_items item
  where item.dedup_fingerprint = v_dedup_fingerprint;

  if v_fingerprint_owner_id is not null and (
    v_fingerprint_owner_id <> v_logical_item_id
    or v_fingerprint_owner_module <> v_module
  ) then
    raise exception using
      errcode = 'P0001',
      message = format(
        'READING_DEDUP_FINGERPRINT_IDENTITY_INCONSISTENCY fingerprint=%s existing=%s attempted=%s',
        v_dedup_fingerprint, v_fingerprint_owner_id, v_logical_item_id
      ),
      detail = format('existing_module=%s attempted_module=%s', v_fingerprint_owner_module, v_module),
      hint = 'Re-run Reading preflight and remap the occurrence to the fingerprint owner; do not retry the INSERT unchanged.';
  end if;

  select item.dedup_fingerprint into v_id_owner_fingerprint
  from public.reading_logical_items item
  where item.logical_item_id = v_logical_item_id;

  if v_id_owner_fingerprint is not null and v_id_owner_fingerprint <> v_dedup_fingerprint then
    raise exception using
      errcode = 'P0001',
      message = format(
        'READING_DEDUP_FINGERPRINT_IDENTITY_INCONSISTENCY logical_item_id=%s existing_fingerprint=%s attempted_fingerprint=%s',
        v_logical_item_id, v_id_owner_fingerprint, v_dedup_fingerprint
      ),
      hint = 'Re-run Reading preflight; a logical item cannot change its strict dedup fingerprint during atomic import.';
  end if;

  select exists (
    select 1 from public.reading_logical_items item
    where item.logical_item_id = v_logical_item_id
  ) into v_logical_item_existed;

  if v_expected_logical_item_action = 'reuse_existing' and not v_logical_item_existed then
    raise exception using
      errcode = 'P0001',
      message = format(
        'READING_IMPORT_PLAN_STALE expected=reuse_existing missing_logical_item_id=%s',
        v_logical_item_id
      ),
      hint = 'Re-run Reading preflight before executing this plan.';
  end if;

  select count(*) into v_occurrence_count
  from jsonb_to_recordset(coalesce(p_rows->'reading_source_occurrences', '[]'::jsonb)) as x(occurrence_id text);

  select count(*) into v_existing_occurrence_count
  from public.reading_source_occurrences occurrence
  where occurrence.occurrence_id in (
    select occurrence_id
    from jsonb_to_recordset(coalesce(p_rows->'reading_source_occurrences', '[]'::jsonb)) as x(occurrence_id text)
  );

  select count(*) into v_question_count
  from jsonb_to_recordset(coalesce(p_rows->'reading_questions', '[]'::jsonb)) as x(question_id text);

  select count(*) into v_existing_question_count
  from public.reading_questions q
  where q.question_id in (
    select question_id
    from jsonb_to_recordset(coalesce(p_rows->'reading_questions', '[]'::jsonb)) as x(question_id text)
  );

  insert into public.reading_materials (
    material_id, title, material_type, source, source_date, year_month, binding_status,
    image_asset_path, hitbox_data_path
  )
  select material_id, title, material_type, source, source_date, year_month, binding_status,
    image_asset_path, hitbox_data_path
  from jsonb_to_recordset(coalesce(p_rows->'reading_materials', '[]'::jsonb)) as x(
    material_id text, title text, material_type text, source text, source_date date, year_month text,
    binding_status text, image_asset_path text, hitbox_data_path text
  )
  on conflict (material_id) do update set
    -- Display-title canonicalization is safe and does not alter material
    -- identity or any frozen R2 asset binding.
    title = excluded.title;

  insert into public.reading_logical_items (
    logical_item_id, module, title, first_seen_date, first_seen_source_label,
    first_seen_source_order, dedup_fingerprint, question_count, scored_item_count,
    is_active, created_by
  )
  select logical_item_id, module, title, first_seen_date, first_seen_source_label,
    first_seen_source_order, dedup_fingerprint, question_count, scored_item_count,
    is_active, coalesce(created_by, p_created_by)
  from jsonb_to_recordset(p_rows->'reading_logical_items') as x(
    logical_item_id text, module text, title text, first_seen_date date,
    first_seen_source_label text, first_seen_source_order integer,
    dedup_fingerprint text, question_count integer, scored_item_count integer,
    is_active boolean, created_by uuid
  )
  on conflict (logical_item_id) do update set
    title = excluded.title,
    -- The service supplies the earlier tuple using the same numeric source-label
    -- collation as dynamic display ranking (for example, 5.3A sorts before 5.10A).
    first_seen_date = excluded.first_seen_date,
    first_seen_source_label = excluded.first_seen_source_label,
    first_seen_source_order = excluded.first_seen_source_order,
    dedup_fingerprint = excluded.dedup_fingerprint,
    question_count = excluded.question_count,
    scored_item_count = excluded.scored_item_count;

  insert into public.reading_source_occurrences (
    occurrence_id, logical_item_id, source_kind, source_label, occurrence_date,
    year_month, source_question_file, source_answer_file, source_module,
    source_order, source_question_start, source_question_end
  )
  select occurrence_id, logical_item_id, source_kind, source_label, occurrence_date,
    year_month, source_question_file, source_answer_file, source_module,
    source_order, source_question_start, source_question_end
  from jsonb_to_recordset(coalesce(p_rows->'reading_source_occurrences', '[]'::jsonb)) as x(
    occurrence_id text, logical_item_id text, source_kind text, source_label text,
    occurrence_date date, year_month text, source_question_file text,
    source_answer_file text, source_module text, source_order integer,
    source_question_start integer, source_question_end integer
  )
  on conflict (occurrence_id) do update set
    logical_item_id = excluded.logical_item_id,
    source_kind = excluded.source_kind,
    source_label = excluded.source_label,
    occurrence_date = excluded.occurrence_date,
    year_month = excluded.year_month,
    source_question_file = excluded.source_question_file,
    source_answer_file = excluded.source_answer_file,
    source_module = excluded.source_module,
    source_order = excluded.source_order,
    source_question_start = excluded.source_question_start,
    source_question_end = excluded.source_question_end;

  insert into public.reading_passages (passage_id, logical_item_id, title)
  select passage_id, logical_item_id, title
  from jsonb_to_recordset(coalesce(p_rows->'reading_passages', '[]'::jsonb)) as x(
    passage_id text, logical_item_id text, title text
  )
  on conflict (passage_id) do update set title = excluded.title;

  insert into public.reading_passage_paragraphs (
    passage_id, paragraph_id, paragraph_order, paragraph_text, raw_text
  )
  select passage_id, paragraph_id, paragraph_order, paragraph_text, raw_text
  from jsonb_to_recordset(coalesce(p_rows->'reading_passage_paragraphs', '[]'::jsonb)) as x(
    passage_id text, paragraph_id text, paragraph_order integer, paragraph_text text, raw_text text
  )
  on conflict (passage_id, paragraph_id) do update set
    paragraph_order = excluded.paragraph_order,
    paragraph_text = excluded.paragraph_text,
    raw_text = excluded.raw_text;

  insert into public.reading_passage_sentences (
    passage_id, paragraph_id, sentence_id, sentence_order, sentence_text
  )
  select passage_id, paragraph_id, sentence_id, sentence_order, sentence_text
  from jsonb_to_recordset(coalesce(p_rows->'reading_passage_sentences', '[]'::jsonb)) as x(
    passage_id text, paragraph_id text, sentence_id text, sentence_order integer, sentence_text text
  )
  on conflict (passage_id, sentence_id) do update set
    paragraph_id = excluded.paragraph_id,
    sentence_order = excluded.sentence_order,
    sentence_text = excluded.sentence_text;

  insert into public.reading_questions (
    question_id, logical_item_id, question_order, module, question_type, stem,
    raw_display_text, passage_highlight_ranges, passage_id, material_id, correct_option_id, insert_sentence,
    correct_anchor_id, target_paragraph_id, correct_sentence_id
  )
  select question_id, logical_item_id, question_order, module, question_type, stem,
    raw_display_text, coalesce(passage_highlight_ranges, '[]'::jsonb), passage_id, material_id, correct_option_id, insert_sentence,
    correct_anchor_id, target_paragraph_id, correct_sentence_id
  from jsonb_to_recordset(coalesce(p_rows->'reading_questions', '[]'::jsonb)) as x(
    question_id text, logical_item_id text, question_order integer, module text,
    question_type text, stem text, raw_display_text text, passage_highlight_ranges jsonb, passage_id text,
    material_id text, correct_option_id text, insert_sentence text,
    correct_anchor_id text, target_paragraph_id text, correct_sentence_id text
  )
  on conflict (question_id) do update set
    question_order = excluded.question_order,
    module = case when v_replace_canonical_content then excluded.module else reading_questions.module end,
    question_type = case when v_replace_canonical_content then excluded.question_type else reading_questions.question_type end,
    stem = excluded.stem,
    raw_display_text = excluded.raw_display_text,
    passage_highlight_ranges = excluded.passage_highlight_ranges,
    passage_id = excluded.passage_id,
    material_id = excluded.material_id,
    correct_option_id = excluded.correct_option_id,
    insert_sentence = excluded.insert_sentence,
    correct_anchor_id = excluded.correct_anchor_id,
    target_paragraph_id = excluded.target_paragraph_id,
    correct_sentence_id = excluded.correct_sentence_id;

  insert into public.reading_question_options (question_id, option_id, option_order, option_text)
  select question_id, option_id, option_order, option_text
  from jsonb_to_recordset(coalesce(p_rows->'reading_question_options', '[]'::jsonb)) as x(
    question_id text, option_id text, option_order integer, option_text text
  )
  on conflict (question_id, option_id) do update set
    option_order = excluded.option_order, option_text = excluded.option_text;

  insert into public.reading_ctw_paragraphs (question_id, paragraph_id, paragraph_order, raw_text)
  select question_id, paragraph_id, paragraph_order, raw_text
  from jsonb_to_recordset(coalesce(p_rows->'reading_ctw_paragraphs', '[]'::jsonb)) as x(
    question_id text, paragraph_id text, paragraph_order integer, raw_text text
  )
  on conflict (question_id, paragraph_id) do update set
    paragraph_order = excluded.paragraph_order, raw_text = excluded.raw_text;

  insert into public.reading_ctw_slots (
    question_id, slot_id, slot_order, paragraph_id, answer, prefix,
    display_text, missing_text, missing_length
  )
  select question_id, slot_id, slot_order, paragraph_id, answer, prefix,
    display_text, missing_text, missing_length
  from jsonb_to_recordset(coalesce(p_rows->'reading_ctw_slots', '[]'::jsonb)) as x(
    question_id text, slot_id text, slot_order integer, paragraph_id text,
    answer text, prefix text, display_text text, missing_text text, missing_length integer
  )
  on conflict (question_id, slot_id) do update set
    slot_order = excluded.slot_order, paragraph_id = excluded.paragraph_id,
    answer = excluded.answer, prefix = excluded.prefix, display_text = excluded.display_text,
    missing_text = excluded.missing_text, missing_length = excluded.missing_length;

  insert into public.reading_ctw_segments (
    question_id, paragraph_id, segment_order, segment_type, text_content, slot_id
  )
  select question_id, paragraph_id, segment_order, segment_type, text_content, slot_id
  from jsonb_to_recordset(coalesce(p_rows->'reading_ctw_segments', '[]'::jsonb)) as x(
    question_id text, paragraph_id text, segment_order integer, segment_type text,
    text_content text, slot_id text
  )
  on conflict (question_id, paragraph_id, segment_order) do update set
    segment_type = excluded.segment_type, text_content = excluded.text_content, slot_id = excluded.slot_id;

  insert into public.reading_rap_insertion_anchors (
    question_id, passage_id, anchor_id, anchor_order, paragraph_id,
    boundary_index, after_sentence_id
  )
  select question_id, passage_id, anchor_id, anchor_order, paragraph_id,
    boundary_index, after_sentence_id
  from jsonb_to_recordset(coalesce(p_rows->'reading_rap_insertion_anchors', '[]'::jsonb)) as x(
    question_id text, passage_id text, anchor_id text, anchor_order integer,
    paragraph_id text, boundary_index integer, after_sentence_id text
  )
  on conflict (question_id, anchor_id) do update set
    anchor_order = excluded.anchor_order, paragraph_id = excluded.paragraph_id,
    boundary_index = excluded.boundary_index, after_sentence_id = excluded.after_sentence_id;

  insert into public.reading_question_occurrences (
    occurrence_id, logical_item_id, question_id, source_question_start, source_question_end
  )
  select occurrence_id, logical_item_id, question_id, source_question_start, source_question_end
  from jsonb_to_recordset(coalesce(p_rows->'reading_question_occurrences', '[]'::jsonb)) as x(
    occurrence_id text, logical_item_id text, question_id text,
    source_question_start integer, source_question_end integer
  )
  on conflict (occurrence_id, question_id) do update set
    source_question_start = excluded.source_question_start,
    source_question_end = excluded.source_question_end;

  -- A confirmed source correction replaces subtype/structure rows that no
  -- longer exist in the incoming canonical package. Ordinary reuse never
  -- deletes canonical content.
  if v_replace_canonical_content then
    delete from public.reading_question_options existing
    where existing.question_id in (
      select question_id from public.reading_questions where logical_item_id = v_logical_item_id
    ) and not exists (
      select 1
      from jsonb_to_recordset(coalesce(p_rows->'reading_question_options', '[]'::jsonb)) as x(question_id text, option_id text)
      where x.question_id = existing.question_id and x.option_id = existing.option_id
    );

    delete from public.reading_rap_insertion_anchors existing
    where existing.question_id in (
      select question_id from public.reading_questions where logical_item_id = v_logical_item_id
    ) and not exists (
      select 1
      from jsonb_to_recordset(coalesce(p_rows->'reading_rap_insertion_anchors', '[]'::jsonb)) as x(question_id text, anchor_id text)
      where x.question_id = existing.question_id and x.anchor_id = existing.anchor_id
    );

    delete from public.reading_ctw_segments existing
    where existing.question_id in (
      select question_id from public.reading_questions where logical_item_id = v_logical_item_id
    ) and not exists (
      select 1
      from jsonb_to_recordset(coalesce(p_rows->'reading_ctw_segments', '[]'::jsonb)) as x(question_id text, paragraph_id text, segment_order integer)
      where x.question_id = existing.question_id
        and x.paragraph_id = existing.paragraph_id
        and x.segment_order = existing.segment_order
    );

    delete from public.reading_ctw_slots existing
    where existing.question_id in (
      select question_id from public.reading_questions where logical_item_id = v_logical_item_id
    ) and not exists (
      select 1
      from jsonb_to_recordset(coalesce(p_rows->'reading_ctw_slots', '[]'::jsonb)) as x(question_id text, slot_id text)
      where x.question_id = existing.question_id and x.slot_id = existing.slot_id
    );

    delete from public.reading_ctw_paragraphs existing
    where existing.question_id in (
      select question_id from public.reading_questions where logical_item_id = v_logical_item_id
    ) and not exists (
      select 1
      from jsonb_to_recordset(coalesce(p_rows->'reading_ctw_paragraphs', '[]'::jsonb)) as x(question_id text, paragraph_id text)
      where x.question_id = existing.question_id and x.paragraph_id = existing.paragraph_id
    );

    delete from public.reading_passage_sentences existing
    where existing.passage_id in (
      select passage_id from public.reading_passages where logical_item_id = v_logical_item_id
    ) and not exists (
      select 1
      from jsonb_to_recordset(coalesce(p_rows->'reading_passage_sentences', '[]'::jsonb)) as x(passage_id text, sentence_id text)
      where x.passage_id = existing.passage_id and x.sentence_id = existing.sentence_id
    );

    delete from public.reading_passage_paragraphs existing
    where existing.passage_id in (
      select passage_id from public.reading_passages where logical_item_id = v_logical_item_id
    ) and not exists (
      select 1
      from jsonb_to_recordset(coalesce(p_rows->'reading_passage_paragraphs', '[]'::jsonb)) as x(passage_id text, paragraph_id text)
      where x.passage_id = existing.passage_id and x.paragraph_id = existing.paragraph_id
    );
  end if;

  return jsonb_build_object(
    'logical_item_id', v_logical_item_id,
    'logical_item_action', case
      when v_logical_item_existed then 'reuse_existing'
      else 'create_new'
    end,
    'inserted_occurrence_count', v_occurrence_count - v_existing_occurrence_count,
    'existing_occurrence_count', v_existing_occurrence_count,
    'inserted_question_count', v_question_count - v_existing_question_count,
    'updated_question_count', v_existing_question_count
  );
end;
$$;

revoke all on function public.import_reading_package_atomic(jsonb, uuid) from public;
revoke all on function public.import_reading_package_atomic(jsonb, uuid) from anon;
revoke all on function public.import_reading_package_atomic(jsonb, uuid) from authenticated;
grant execute on function public.import_reading_package_atomic(jsonb, uuid) to service_role;
