-- Restore the official RDL material type retained by the Reading production
-- material-index. The VALUES list was generated from each material's stable
-- asset_id + occurrences[].rdl_type mapping, never from title or image content.

alter table public.reading_materials
  add column if not exists material_type text;

alter table public.reading_materials
  drop constraint if exists reading_materials_material_type_check;

alter table public.reading_materials
  add constraint reading_materials_material_type_check check (material_type in (
    'advertisement', 'agenda', 'announcement', 'article', 'blog_post',
    'course_description', 'course_syllabus', 'email', 'email_exchange', 'flyer',
    'following_notice', 'form', 'instructions', 'label', 'message_exchange',
    'newspaper_article', 'notice', 'online_discussion', 'poster', 'review',
    'schedule', 'sign', 'social_media_post', 'student_magazine_article',
    'student_newspaper_article', 'syllabus', 'syllabus_excerpt', 'text_chain',
    'text_message_chain', 'travel_flyer', 'webpage'
  ));

with recovered(material_id, material_type) as (values
  ('RDL-001', 'flyer'),
  ('RDL-002', 'instructions'),
  ('RDL-003', 'text_message_chain'),
  ('RDL-004', 'notice'),
  ('RDL-005', 'advertisement'),
  ('RDL-006', 'schedule'),
  ('RDL-007', 'notice'),
  ('RDL-008', 'email'),
  ('RDL-009', 'notice'),
  ('RDL-010', 'article'),
  ('RDL-011', 'notice'),
  ('RDL-012', 'notice'),
  ('RDL-013', 'review'),
  ('RDL-014', 'newspaper_article'),
  ('RDL-015', 'email'),
  ('RDL-016', 'syllabus_excerpt'),
  ('RDL-017', 'text_chain'),
  ('RDL-018', 'email'),
  ('RDL-019', 'course_description'),
  ('RDL-020', 'instructions'),
  ('RDL-021', 'advertisement'),
  ('RDL-022', 'newspaper_article'),
  ('RDL-023', 'syllabus_excerpt'),
  ('RDL-024', 'email'),
  ('RDL-025', 'webpage'),
  ('RDL-026', 'article'),
  ('RDL-027', 'notice'),
  ('RDL-028', 'article'),
  ('RDL-029', 'email'),
  ('RDL-030', 'blog_post'),
  ('RDL-031', 'email'),
  ('RDL-032', 'message_exchange'),
  ('RDL-033', 'form'),
  ('RDL-034', 'notice'),
  ('RDL-035', 'course_description'),
  ('RDL-036', 'webpage'),
  ('RDL-037', 'social_media_post'),
  ('RDL-038', 'course_description'),
  ('RDL-039', 'email_exchange'),
  ('RDL-040', 'advertisement'),
  ('RDL-041', 'notice'),
  ('RDL-042', 'label'),
  ('RDL-043', 'syllabus_excerpt'),
  ('RDL-044', 'following_notice'),
  ('RDL-045', 'agenda'),
  ('RDL-046', 'review'),
  ('RDL-047', 'email'),
  ('RDL-048', 'notice'),
  ('RDL-049', 'flyer'),
  ('RDL-050', 'webpage'),
  ('RDL-051', 'social_media_post'),
  ('RDL-052', 'article'),
  ('RDL-053', 'notice'),
  ('RDL-054', 'article'),
  ('RDL-055', 'social_media_post'),
  ('RDL-056', 'flyer'),
  ('RDL-057', 'notice'),
  ('RDL-058', 'webpage'),
  ('RDL-059', 'syllabus_excerpt'),
  ('RDL-060', 'announcement'),
  ('RDL-061', 'sign'),
  ('RDL-062', 'webpage'),
  ('RDL-063', 'notice'),
  ('RDL-064', 'text_message_chain'),
  ('RDL-065', 'review'),
  ('RDL-066', 'article'),
  ('RDL-067', 'notice'),
  ('RDL-068', 'email'),
  ('RDL-069', 'notice'),
  ('RDL-070', 'email'),
  ('RDL-071', 'syllabus_excerpt'),
  ('RDL-072', 'notice'),
  ('RDL-073', 'email'),
  ('RDL-074', 'notice'),
  ('RDL-075', 'course_description'),
  ('RDL-076', 'travel_flyer'),
  ('RDL-077', 'announcement'),
  ('RDL-078', 'notice'),
  ('RDL-079', 'student_newspaper_article'),
  ('RDL-080', 'notice'),
  ('RDL-081', 'article'),
  ('RDL-082', 'course_description'),
  ('RDL-083', 'text_message_chain'),
  ('RDL-084', 'course_description'),
  ('RDL-085', 'article'),
  ('RDL-086', 'newspaper_article')
)
update public.reading_materials material
set material_type = recovered.material_type
from recovered
where material.material_id = recovered.material_id;

do $$
declare
  unresolved_ids text;
begin
  select string_agg(material_id, ', ' order by material_id)
  into unresolved_ids
  from public.reading_materials
  where material_type is null;

  if unresolved_ids is not null then
    raise exception 'RDL material_type backfill is incomplete: %', unresolved_ids;
  end if;
end
$$;

alter table public.reading_materials
  alter column material_type set not null;

comment on column public.reading_materials.material_type is
  'Stable RDL material identity mapped to the official source instruction in lib/reading/materialTypes.ts.';
