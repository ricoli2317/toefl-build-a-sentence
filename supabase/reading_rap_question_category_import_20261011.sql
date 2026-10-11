-- MANUAL ONLY. No table/schema changes and no question data updates.
-- Baseline: production public.import_reading_package_atomic(jsonb,uuid),
-- inspected read-only on 2026-10-11. Patch its exact question INSERT mapping,
-- not the repository's historical full function. All other deployed code,
-- owner, permissions, SECURITY DEFINER and search_path are preserved.
-- Run this file first, then reading_rap_question_category_import_verify_20261011.sql.
-- If the mapping has drifted, this transaction aborts: inspect/rebase manually.

begin;

do $patch$
declare
  v_oid oid := to_regprocedure('public.import_reading_package_atomic(jsonb,uuid)');
  v_definition text;
  v_metadata jsonb;
  v_after_metadata jsonb;
  v_old_mapping constant text := $old$  insert into public.reading_questions (
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
  on conflict (question_id) do update set$old$;
  v_new_mapping constant text := $new$  insert into public.reading_questions (
    question_id, logical_item_id, question_order, module, question_type, question_category, stem,
    raw_display_text, passage_highlight_ranges, passage_id, material_id, correct_option_id, insert_sentence,
    correct_anchor_id, target_paragraph_id, correct_sentence_id
  )
  select question_id, logical_item_id, question_order, module, question_type, case when module = 'rap' then question_category else null end, stem,
    raw_display_text, coalesce(passage_highlight_ranges, '[]'::jsonb), passage_id, material_id, correct_option_id, insert_sentence,
    correct_anchor_id, target_paragraph_id, correct_sentence_id
  from jsonb_to_recordset(coalesce(p_rows->'reading_questions', '[]'::jsonb)) as x(
    question_id text, logical_item_id text, question_order integer, module text,
    question_type text, question_category text, stem text, raw_display_text text, passage_highlight_ranges jsonb, passage_id text,
    material_id text, correct_option_id text, insert_sentence text,
    correct_anchor_id text, target_paragraph_id text, correct_sentence_id text
  )
  on conflict (question_id) do update set$new$;
begin
  if v_oid is null then
    raise exception 'Missing public.import_reading_package_atomic(jsonb,uuid); do not install a historical replacement';
  end if;
  if not exists (
    select 1 from pg_attribute
    where attrelid = 'public.reading_questions'::regclass
      and attname = 'question_category' and not attisdropped
      and atttypid = 'text'::regtype
  ) then
    raise exception 'Expected existing reading_questions.question_category text column';
  end if;

  select pg_get_functiondef(p.oid),
    jsonb_build_object('owner', p.proowner, 'acl', p.proacl,
      'security_definer', p.prosecdef, 'config', p.proconfig,
      'arguments', p.proargtypes::text, 'return_type', p.prorettype)
  into v_definition, v_metadata
  from pg_proc p where p.oid = v_oid;

  if strpos(v_definition, v_new_mapping) > 0
    and strpos(v_definition, v_old_mapping) = 0 then
    raise notice 'RAP question_category INSERT mapping already installed; no changes';
    return;
  end if;
  if (length(v_definition) - length(replace(v_definition, v_old_mapping, '')))
    <> length(v_old_mapping) then
    raise exception 'Production question INSERT mapping differs from the inspected baseline; refusing to replace the RPC';
  end if;

  -- Exactly three mapping edits. Deliberately leave ON CONFLICT unchanged:
  -- existing canonical classifications must never be overwritten or cleared.
  execute replace(v_definition, v_old_mapping, v_new_mapping);

  select jsonb_build_object('owner', p.proowner, 'acl', p.proacl,
    'security_definer', p.prosecdef, 'config', p.proconfig,
    'arguments', p.proargtypes::text, 'return_type', p.prorettype)
  into v_after_metadata
  from pg_proc p where p.oid = v_oid;
  if v_after_metadata is distinct from v_metadata
    or pg_get_functiondef(v_oid) <> replace(v_definition, v_old_mapping, v_new_mapping) then
    raise exception 'RPC changed outside the approved question INSERT mapping; rolling back';
  end if;
end;
$patch$;

commit;
