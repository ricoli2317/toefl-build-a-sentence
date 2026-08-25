-- Student catalog and dashboard read-path indexes.
-- Safe to run repeatedly.

create index if not exists practice_items_active_catalog_idx
  on public.practice_items (task_type, first_seen_date desc, display_number desc, item_id)
  where is_active = true
    and display_number is not null
    and display_number <> '';

create index if not exists practice_item_sources_catalog_idx
  on public.practice_item_sources (task_type, item_id, source_id);

create index if not exists practice_item_occurrences_catalog_idx
  on public.practice_item_occurrences (source_id, occurred_on desc);

create index if not exists attempts_student_set_latest_idx
  on public.attempts (student_id, set_id, submitted_at desc nulls last, attempt_id desc);

create index if not exists writing_attempts_student_dashboard_idx
  on public.writing_attempts (user_id, task_type, status, updated_at desc, attempt_id desc);

create index if not exists writing_reviews_published_attempt_idx
  on public.writing_reviews (attempt_id)
  where status = 'published' and published_at is not null;
