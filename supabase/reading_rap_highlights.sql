-- Adds authoritative per-question RAP passage highlight ranges.
-- Offsets are zero-based, end-exclusive Unicode code-point positions within
-- reading_passage_paragraphs.paragraph_text. An empty array means the source
-- explicitly supplies no highlight for that question.

alter table public.reading_questions
  add column if not exists passage_highlight_ranges jsonb not null default '[]'::jsonb;

alter table public.reading_questions
  drop constraint if exists reading_questions_passage_highlight_ranges_check;

alter table public.reading_questions
  add constraint reading_questions_passage_highlight_ranges_check
  check (jsonb_typeof(passage_highlight_ranges) = 'array');

comment on column public.reading_questions.passage_highlight_ranges is
  'Authoritative DOCX-derived RAP ranges: [{paragraphId,startOffset,endOffset}], using zero-based end-exclusive Unicode code-point offsets.';

-- Apply the updated reading_csv_import.sql after this migration so the atomic
-- importer writes passage_highlight_ranges in the same transaction.
