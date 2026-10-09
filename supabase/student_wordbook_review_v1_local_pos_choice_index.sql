-- USER-MANUAL: run ALONE, outside BEGIN/COMMIT, after occurrence-choice patch.
-- Existing POS7 immutable functions are required. No timeout change or data write.
create index concurrently wordbook_review_occurrence_pos_meaning_idx
on public.lexical_occurrences (public.wordbook_review_teaching_pos(context_pos),
  (btrim(context_meaning_zh) collate "C"),entry_id)
include (context_meaning_zh)
where review_status='generated' and context_meaning_zh~'[一-龥]'
  and length(context_meaning_zh) between 1 and 160
  and public.wordbook_review_teaching_pos(context_pos) is not null;
