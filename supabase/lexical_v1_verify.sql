-- Run manually after the one-command production import.
SELECT
  (SELECT count(*) FROM public.lexical_entries) AS entries,
  (SELECT count(*) FROM public.lexical_occurrences) AS occurrences,
  (SELECT count(*) FROM public.lexical_source_blocks) AS source_blocks,
  (SELECT count(*) FROM public.lexical_occurrences o LEFT JOIN public.lexical_entries e USING (entry_id) WHERE e.entry_id IS NULL) AS orphan_occurrences,
  (SELECT count(*) FROM public.lexical_occurrences o LEFT JOIN public.lexical_source_blocks b USING (source_type, source_item_id, content_block_id) WHERE b.block_id IS NULL) AS missing_blocks,
  (SELECT count(*) FROM (SELECT source_type, source_item_id, content_block_id, start_offset, end_offset FROM public.lexical_occurrences GROUP BY 1,2,3,4,5 HAVING count(*) > 1) d) AS duplicate_spans,
  (SELECT count(*) FROM (SELECT normalized_expression, expression_type, identity_variant FROM public.lexical_entries GROUP BY 1,2,3 HAVING count(*) > 1) d) AS duplicate_entry_keys;

SELECT source_type, count(*) AS occurrences FROM public.lexical_occurrences GROUP BY source_type ORDER BY source_type;
