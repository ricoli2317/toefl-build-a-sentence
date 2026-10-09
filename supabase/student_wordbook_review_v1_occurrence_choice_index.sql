-- USER-MANUAL: run this file ALONE, outside any explicit transaction.
-- CONCURRENTLY avoids blocking normal occurrence ingestion. One statement only.
-- If interrupted, inspect the named index; do not silently reuse an invalid one.
create index concurrently wordbook_review_occurrence_meaning_idx
on public.lexical_occurrences ((btrim(context_meaning_zh) collate "C"),entry_id)
include (context_meaning_zh)
where review_status='generated' and context_meaning_zh~'[一-龥]'
  and length(context_meaning_zh) between 1 and 160;
