-- Read-only acceptance checkpoint. Run BEFORE the assistant cancels the sample.
-- One real garden entry for jiangzhuocheng2; no corpus scan, no mutation or RPC.
-- Expected: 1 entry / 1 canonical link / 2 senses / 2 examples / 2 M:N links.
with target as materialized (
  select * from public.student_wordbook_entries
  where wordbook_entry_id = '297dbb44-123b-4de3-89e0-bb5b7dc9f747'::uuid
), expected(pos, zh, definition, example_text) as (
  values
    ('noun', '庭园', 'Landscaped spaces arranged with rocks.',
      'Japanese rock gardens, known as karesansui or “dry landscape gardens,” constitute a highly formalized mode of artistic representation closely associated with Zen Buddhist temples, especially during the Muromachi period (circa fourteenth–sixteenth centuries).'),
    ('noun', '庭园', 'Cultivated outdoor spaces.',
      'Unlike gardens that recreate natural abundance, they deliberately exclude water and dense vegetation.')
), checks as (
  select
    (select count(*) from target) as target_entries,
    (select count(*) from target w join public.student_wordbook_entries e
      on e.student_id=w.student_id and e.domain=w.domain and e.lexeme_key=w.lexeme_key) as same_identity_entries,
    (select count(*) from target w join public.student_wordbook_canonical_links l
      on l.wordbook_entry_id=w.wordbook_entry_id and l.student_id=w.student_id and l.domain=w.domain) as canonical_links,
    (select count(*) from target w join public.student_wordbook_senses s
      on s.wordbook_entry_id=w.wordbook_entry_id and s.student_id=w.student_id and s.domain=w.domain) as senses,
    (select count(*) from target w join public.student_wordbook_examples x
      on x.wordbook_entry_id=w.wordbook_entry_id and x.student_id=w.student_id and x.domain=w.domain) as examples,
    (select count(*) from target w join public.student_wordbook_example_senses m
      on m.student_id=w.student_id and m.domain=w.domain and m.wordbook_entry_id=w.wordbook_entry_id) as example_sense_links,
    (select count(*) from expected c where exists (
      select 1 from target w
      join public.student_wordbook_senses s on s.wordbook_entry_id=w.wordbook_entry_id
      join public.student_wordbook_examples x on x.wordbook_entry_id=w.wordbook_entry_id
      join public.student_wordbook_example_senses m on m.example_id=x.example_id and m.sense_id=s.sense_id
      where s.student_id=w.student_id and s.domain=w.domain
        and x.student_id=w.student_id and x.domain=w.domain
        and m.student_id=w.student_id and m.domain=w.domain and m.wordbook_entry_id=w.wordbook_entry_id
        and s.context_pos=c.pos and s.context_meaning_zh=c.zh and s.context_definition_en=c.definition
        and x.example_text=c.example_text and x.context_kind='sentence'
        and x.extraction_method='canonical_sentence' and x.source_types=array['rap']::text[]
    )) as exact_contexts_preserved,
    exists(select 1 from target w join public.student_wordbook_canonical_links l
      on l.wordbook_entry_id=w.wordbook_entry_id
      where w.expression='garden' and w.domain='reading'
        and l.lexical_entry_id='ebb78eda-b1b5-55da-84e4-85c17eaaebd2'::uuid
        and l.association_kind='exact_identity') as canonical_identity_ok,
    not exists(select 1 from public.student_wordbook_entries
      where wordbook_entry_id='a6b4d0b6-f5d1-4554-ae74-2ad065d35009'::uuid) as earlier_cancelled_entry_absent,
    (select first_saved_at from target) as first_saved_at
)
select case when target_entries=1 and same_identity_entries=1 and canonical_links=1
  and senses=2 and examples=2 and example_sense_links=2 and exact_contexts_preserved=2
  and canonical_identity_ok and earlier_cancelled_entry_absent
  then 'WORDBOOK_A2_REAL_ACCEPTANCE_PASS' else 'WORDBOOK_A2_REAL_ACCEPTANCE_CHECK_REQUIRED' end as result,
  checks.* from checks;
