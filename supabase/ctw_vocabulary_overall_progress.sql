-- Incremental install after ctw_vocabulary_review_sync.sql. Test locally first.
-- No vocabulary/attempt/session rewrites. Historical JSON is read once at install.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';

create table public.student_ctw_vocabulary_mastered_words (
  student_id uuid not null references auth.users(id) on delete cascade,
  -- Deliberately no entry FK: retain historical mastery when a word is removed.
  -- Reads ALWAYS intersect these stable IDs with today's visible vocabulary.
  entry_id uuid not null,
  primary key (student_id, entry_id)
);
alter table public.student_ctw_vocabulary_mastered_words enable row level security;
create policy ctw_mastered_self_read on public.student_ctw_vocabulary_mastered_words
  for select to authenticated using (
    student_id = (select auth.uid()) and
    (select exists(select 1 from public.profiles p where p.id = (select auth.uid())
      and p.is_active and p.role::text in ('student','teacher','admin')))
  );
revoke all on public.student_ctw_vocabulary_mastered_words from public, anon, authenticated, service_role;
grant select on public.student_ctw_vocabulary_mastered_words to authenticated;

-- Trigger-only writers. Existing service-only paths still validate and grade
-- answers in JavaScript; browsers cannot supply mastery or invoke these helpers.
create function ctw_vocab_private.record_mastered_attempt()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.student_ctw_vocabulary_mastered_words(student_id, entry_id)
    select distinct new.student_id, (a->>'entryId')::uuid
    from jsonb_array_elements(new.answers) a where a->'correct' = 'true'::jsonb
    order by 1, 2 on conflict do nothing;
  return new;
end $$;
revoke all on function ctw_vocab_private.record_mastered_attempt() from public, anon, authenticated, service_role;
create trigger ctw_vocabulary_mastered_attempt after insert on public.student_ctw_vocabulary_attempts
  for each row execute function ctw_vocab_private.record_mastered_attempt();

create function ctw_vocab_private.record_mastered_review()
returns trigger language plpgsql security definer set search_path = '' as $$
declare previous_answers jsonb := '{}';
begin
  if tg_op = 'UPDATE' then
    previous_answers := coalesce(old.state->'answers', '{}'::jsonb);
    if new.state->'answers' is not distinct from old.state->'answers' then return new; end if;
  end if;
  insert into public.student_ctw_vocabulary_mastered_words(student_id, entry_id)
    select new.student_id, a.key::uuid from jsonb_each(new.state->'answers') a
    where a.value->'correct' = 'true'::jsonb
      and previous_answers->a.key->'correct' is distinct from 'true'::jsonb
    order by 1, 2 on conflict do nothing;
  return new;
end $$;
revoke all on function ctw_vocab_private.record_mastered_review() from public, anon, authenticated, service_role;
create trigger ctw_vocabulary_mastered_review after insert or update of state
  on public.student_ctw_vocabulary_review_sessions
  for each row execute function ctw_vocab_private.record_mastered_review();

-- Include pre-upgrade attempts AND already-correct answers in unfinished rounds.
-- Install and trigger creation are atomic, so concurrent submissions cannot be lost.
insert into public.student_ctw_vocabulary_mastered_words(student_id, entry_id)
  select a.student_id, (answer->>'entryId')::uuid
    from public.student_ctw_vocabulary_attempts a cross join lateral jsonb_array_elements(a.answers) answer
    where answer->'correct' = 'true'::jsonb
  union
  select s.student_id, answer.key::uuid
    from public.student_ctw_vocabulary_review_sessions s cross join lateral jsonb_each(s.state->'answers') answer
    where answer.value->'correct' = 'true'::jsonb
  order by 1, 2 on conflict do nothing;

-- Same effective set as the catalog: entries are unique by normalized_word;
-- there is currently no per-entry active flag. Invoker preserves vocabulary RLS
-- (including future visibility restrictions) and owner-only mastery RLS.
create function public.read_ctw_vocabulary_overall_progress_v1()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('total', count(*), 'mastered', count(m.entry_id))
  from public.ctw_vocabulary_entries e
  left join public.student_ctw_vocabulary_mastered_words m
    on m.student_id = (select auth.uid()) and m.entry_id = e.entry_id
$$;
revoke all on function public.read_ctw_vocabulary_overall_progress_v1() from public, anon, authenticated, service_role;
grant execute on function public.read_ctw_vocabulary_overall_progress_v1() to authenticated;
notify pgrst, 'reload schema';
commit;
