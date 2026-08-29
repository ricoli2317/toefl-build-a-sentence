-- Batch 1C: one transaction boundary for one normalized ReadingImportPackage.
-- This adds no tables or columns and does not change existing Reading records.

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
  v_existing_question_count integer := 0;
  v_question_count integer := 0;
begin
  if jsonb_array_length(coalesce(p_rows->'reading_logical_items', '[]'::jsonb)) <> 1 then
    raise exception 'Reading atomic import requires exactly one logical item';
  end if;

  select logical_item_id into v_logical_item_id
  from jsonb_to_recordset(p_rows->'reading_logical_items') as x(logical_item_id text);

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
  on conflict (material_id) do nothing;

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
    raw_display_text, passage_id, material_id, correct_option_id, insert_sentence,
    correct_anchor_id, target_paragraph_id, correct_sentence_id
  )
  select question_id, logical_item_id, question_order, module, question_type, stem,
    raw_display_text, passage_id, material_id, correct_option_id, insert_sentence,
    correct_anchor_id, target_paragraph_id, correct_sentence_id
  from jsonb_to_recordset(coalesce(p_rows->'reading_questions', '[]'::jsonb)) as x(
    question_id text, logical_item_id text, question_order integer, module text,
    question_type text, stem text, raw_display_text text, passage_id text,
    material_id text, correct_option_id text, insert_sentence text,
    correct_anchor_id text, target_paragraph_id text, correct_sentence_id text
  )
  on conflict (question_id) do update set
    question_order = excluded.question_order,
    stem = excluded.stem,
    raw_display_text = excluded.raw_display_text,
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

  return jsonb_build_object(
    'logical_item_id', v_logical_item_id,
    'inserted_question_count', v_question_count - v_existing_question_count,
    'updated_question_count', v_existing_question_count
  );
end;
$$;

revoke all on function public.import_reading_package_atomic(jsonb, uuid) from public;
revoke all on function public.import_reading_package_atomic(jsonb, uuid) from anon;
revoke all on function public.import_reading_package_atomic(jsonb, uuid) from authenticated;
grant execute on function public.import_reading_package_atomic(jsonb, uuid) to service_role;
