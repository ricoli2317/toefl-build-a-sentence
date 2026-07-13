begin;

update public.questions
set
  options_text = '["obstruct", "appealing", "the artwork", "find", "not", "did", "I"]',
  distractors_text = '["obstruct"]'
where question_id = '202602-0202-3-Q02';

update public.questions
set
  options_text = '["her", "if", "suggestions", "I", "for improving", "the curriculum", "asked", "had"]',
  distractors_text = '["her"]'
where question_id = '202602-0202-3-Q07';

update public.questions
set
  options_text = '["start", "it", "you", "started working", "have", "on"]',
  distractors_text = '["start"]'
where question_id = '202603-0308-4-Q04';

commit;

select
  question_id,
  options_text,
  distractors_text
from public.questions
where question_id in (
  '202602-0202-3-Q02',
  '202602-0202-3-Q07',
  '202603-0308-4-Q04'
)
order by question_id;
