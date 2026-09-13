-- Travel RDL reading_materials registration dry-run artifact.
-- Execute only after all 92 R2 objects have completed remote/public verification.
-- Generated from production indexes, Travel release-map authority, and authoritative suite DOCX instructions.

begin;

create temporary table travel_rdl_material_registration (
  material_id text primary key,
  title text,
  material_type text not null,
  source text not null,
  source_date date,
  year_month text not null,
  binding_status text not null,
  image_asset_path text not null,
  hitbox_data_path text not null
) on commit drop;

insert into travel_rdl_material_registration (
  material_id, title, material_type, source, source_date, year_month,
  binding_status, image_asset_path, hitbox_data_path
) values
  ('RDL-087', 'Study Abroad in Valencia', 'webpage', 'material-index.json#RDL-087', '2026-07-01', '2026-07', 'bound', 'reading/rdl/RDL-087/material_final.png', 'reading/rdl/RDL-087/selection_map.json'),
  ('RDL-088', 'Winter Creative Writing Seminar', 'course_description', 'material-index.json#RDL-088', '2026-07-01', '2026-07', 'bound', 'reading/rdl/RDL-088/material_final.png', 'reading/rdl/RDL-088/selection_map.json'),
  ('RDL-089', 'Join the Mechanicsburg Clean-Up Day!', 'poster', 'material-index.json#RDL-089', '2026-07-01', '2026-07', 'bound', 'reading/rdl/RDL-089/material_final.png', 'reading/rdl/RDL-089/selection_map.json'),
  ('RDL-090', 'Campus Iyengar Yoga Classes', 'article', 'material-index.json#RDL-090', '2026-07-15', '2026-07', 'bound', 'reading/rdl/RDL-090/material_final.png', 'reading/rdl/RDL-090/selection_map.json'),
  ('RDL-091', 'Join the Campus Historical Society!', 'poster', 'material-index.json#RDL-091', '2026-07-05', '2026-07', 'bound', 'reading/rdl/RDL-091/material_final.png', 'reading/rdl/RDL-091/selection_map.json'),
  ('RDL-092', 'Fairmount University Ceramics Workshop', 'poster', 'material-index.json#RDL-092', '2026-07-05', '2026-07', 'bound', 'reading/rdl/RDL-092/material_final.png', 'reading/rdl/RDL-092/selection_map.json'),
  ('RDL-093', 'Residence-Hall Vegan Menu Expansion', 'article', 'material-index.json#RDL-093', '2026-07-05', '2026-07', 'bound', 'reading/rdl/RDL-093/material_final.png', 'reading/rdl/RDL-093/selection_map.json'),
  ('RDL-094', 'Foundations of Graphic Design', 'course_description', 'material-index.json#RDL-094', '2026-07-06', '2026-07', 'bound', 'reading/rdl/RDL-094/material_final.png', 'reading/rdl/RDL-094/selection_map.json'),
  ('RDL-095', 'Physics for Engineers I', 'course_description', 'material-index.json#RDL-095', '2026-07-07', '2026-07', 'bound', 'reading/rdl/RDL-095/material_final.png', 'reading/rdl/RDL-095/selection_map.json'),
  ('RDL-096', 'Innovation Hub: Student Showcase', 'poster', 'material-index.json#RDL-096', '2026-07-07', '2026-07', 'bound', 'reading/rdl/RDL-096/material_final.png', 'reading/rdl/RDL-096/selection_map.json'),
  ('RDL-097', 'Campus Dining: Healthy Meal Options', 'notice', 'material-index.json#RDL-097', '2026-07-08', '2026-07', 'bound', 'reading/rdl/RDL-097/material_final.png', 'reading/rdl/RDL-097/selection_map.json'),
  ('RDL-098', 'Breakfast Service Changes', 'notice', 'material-index.json#RDL-098', '2026-07-14', '2026-07', 'bound', 'reading/rdl/RDL-098/material_final.png', 'reading/rdl/RDL-098/selection_map.json'),
  ('RDL-099', 'Prague Summer Study Program', 'poster', 'material-index.json#RDL-099', '2026-07-14', '2026-07', 'bound', 'reading/rdl/RDL-099/material_final.png', 'reading/rdl/RDL-099/selection_map.json'),
  ('RDL-100', 'Rescheduled Architecture Lecture', 'email', 'material-index.json#RDL-100', '2026-07-15', '2026-07', 'bound', 'reading/rdl/RDL-100/material_final.png', 'reading/rdl/RDL-100/selection_map.json'),
  ('RDL-101', 'The Review of Whispering Woods', 'review', 'material-index.json#RDL-101', '2026-07-20', '2026-07', 'bound', 'reading/rdl/RDL-101/material_final.png', 'reading/rdl/RDL-101/selection_map.json'),
  ('RDL-102', 'Harrison University Bike Sharing', 'article', 'material-index.json#RDL-102', '2026-07-20', '2026-07', 'bound', 'reading/rdl/RDL-102/material_final.png', 'reading/rdl/RDL-102/selection_map.json'),
  ('RDL-103', 'ALL-DAY CRAFT FAIR', 'advertisement', 'material-index.json#RDL-103', '2026-07-21', '2026-07', 'bound', 'reading/rdl/RDL-103/material_final.png', 'reading/rdl/RDL-103/selection_map.json'),
  ('RDL-104', 'Hamartia Discussion', 'online_discussion', 'material-index.json#RDL-104', '2026-07-21', '2026-07', 'bound', 'reading/rdl/RDL-104/material_final.png', 'reading/rdl/RDL-104/selection_map.json'),
  ('RDL-106', 'World Cultures Club', 'notice', 'material-index.json#RDL-106', '2026-07-21', '2026-07', 'bound', 'reading/rdl/RDL-106/material_final.png', 'reading/rdl/RDL-106/selection_map.json'),
  ('RDL-107', 'Contemporary Art History', 'course_description', 'material-index.json#RDL-107', '2026-07-22', '2026-07', 'bound', 'reading/rdl/RDL-107/material_final.png', 'reading/rdl/RDL-107/selection_map.json'),
  ('RDL-108', 'Student Engagement Initiatives', 'article', 'material-index.json#RDL-108', '2026-07-22', '2026-07', 'bound', 'reading/rdl/RDL-108/material_final.png', 'reading/rdl/RDL-108/selection_map.json'),
  ('RDL-110', 'Herb Garden at Newton University', 'article', 'material-index.json#RDL-110', '2026-07-22', '2026-07', 'bound', 'reading/rdl/RDL-110/material_final.png', 'reading/rdl/RDL-110/selection_map.json'),
  ('RDL-111', 'Library Café Early Closure', 'email', 'material-index.json#RDL-111', '2026-07-22', '2026-07', 'bound', 'reading/rdl/RDL-111/material_final.png', 'reading/rdl/RDL-111/selection_map.json'),
  ('RDL-112', 'Baker Rugby Championship', 'article', 'material-index.json#RDL-112', '2026-07-22', '2026-07', 'bound', 'reading/rdl/RDL-112/material_final.png', 'reading/rdl/RDL-112/selection_map.json'),
  ('RDL-113', 'Free Health Screening Event', 'poster', 'material-index.json#RDL-113', '2026-08-04', '2026-08', 'bound', 'reading/rdl/RDL-113/material_final.png', 'reading/rdl/RDL-113/selection_map.json'),
  ('RDL-114', 'Survey of Literary Theory', 'course_syllabus', 'material-index.json#RDL-114', '2026-08-04', '2026-08', 'bound', 'reading/rdl/RDL-114/material_final.png', 'reading/rdl/RDL-114/selection_map.json'),
  ('RDL-115', 'The Silent Echo', 'review', 'material-index.json#RDL-115', '2026-08-05', '2026-08', 'bound', 'reading/rdl/RDL-115/material_final.png', 'reading/rdl/RDL-115/selection_map.json'),
  ('RDL-116', 'Math Tutoring Program', 'advertisement', 'material-index.json#RDL-116', '2026-08-05', '2026-08', 'bound', 'reading/rdl/RDL-116/material_final.png', 'reading/rdl/RDL-116/selection_map.json'),
  ('RDL-117', 'History 302 Research Assignment', 'email', 'material-index.json#RDL-117', '2026-08-05', '2026-08', 'bound', 'reading/rdl/RDL-117/material_final.png', 'reading/rdl/RDL-117/selection_map.json'),
  ('RDL-118', 'Echoes of Tomorrow', 'review', 'material-index.json#RDL-118', '2026-08-08', '2026-08', 'bound', 'reading/rdl/RDL-118/material_final.png', 'reading/rdl/RDL-118/selection_map.json'),
  ('RDL-119', 'Application for Research Assistant Position', 'email', 'material-index.json#RDL-119', '2026-08-08', '2026-08', 'bound', 'reading/rdl/RDL-119/material_final.png', 'reading/rdl/RDL-119/selection_map.json'),
  ('RDL-120', 'Gardener’s Delight Soil Mix', 'review', 'material-index.json#RDL-120', '2026-08-08', '2026-08', 'bound', 'reading/rdl/RDL-120/material_final.png', 'reading/rdl/RDL-120/selection_map.json'),
  ('RDL-121', 'Science Research Proposal Workshop', 'schedule', 'material-index.json#RDL-121', '2026-08-08', '2026-08', 'bound', 'reading/rdl/RDL-121/material_final.png', 'reading/rdl/RDL-121/selection_map.json'),
  ('RDL-122', 'Mindfulness Workshop', 'announcement', 'material-index.json#RDL-122', '2026-08-09', '2026-08', 'bound', 'reading/rdl/RDL-122/material_final.png', 'reading/rdl/RDL-122/selection_map.json'),
  ('RDL-123', 'Renewable Energy Research Paper', 'email', 'material-index.json#RDL-123', '2026-08-09', '2026-08', 'bound', 'reading/rdl/RDL-123/material_final.png', 'reading/rdl/RDL-123/selection_map.json'),
  ('RDL-124', 'Eastwood Campus Dining Options', 'blog_post', 'material-index.json#RDL-124', '2026-08-12', '2026-08', 'bound', 'reading/rdl/RDL-124/material_final.png', 'reading/rdl/RDL-124/selection_map.json'),
  ('RDL-125', 'Mediation Options', 'email', 'material-index.json#RDL-125', '2026-08-12', '2026-08', 'bound', 'reading/rdl/RDL-125/material_final.png', 'reading/rdl/RDL-125/selection_map.json'),
  ('RDL-126', 'Summer House and Pet Sitting', 'advertisement', 'material-index.json#RDL-126', '2026-08-12', '2026-08', 'bound', 'reading/rdl/RDL-126/material_final.png', 'reading/rdl/RDL-126/selection_map.json'),
  ('RDL-127', 'Physics for Engineers I', 'course_description', 'material-index.json#RDL-127', '2026-08-12', '2026-08', 'bound', 'reading/rdl/RDL-127/material_final.png', 'reading/rdl/RDL-127/selection_map.json'),
  ('RDL-128', 'EX-5000 3D Printer Instructions', 'instructions', 'material-index.json#RDL-128', '2026-08-12', '2026-08', 'bound', 'reading/rdl/RDL-128/material_final.png', 'reading/rdl/RDL-128/selection_map.json'),
  ('RDL-129', 'Exploring Cultural Artifacts', 'course_description', 'material-index.json#RDL-129', '2026-08-18', '2026-08', 'bound', 'reading/rdl/RDL-129/material_final.png', 'reading/rdl/RDL-129/selection_map.json'),
  ('RDL-130', 'AI Robot Baristas', 'article', 'material-index.json#RDL-130', '2026-08-18', '2026-08', 'bound', 'reading/rdl/RDL-130/material_final.png', 'reading/rdl/RDL-130/selection_map.json'),
  ('RDL-131', 'Student Council Meeting Plans', 'text_message_chain', 'material-index.json#RDL-131', '2026-08-18', '2026-08', 'bound', 'reading/rdl/RDL-131/material_final.png', 'reading/rdl/RDL-131/selection_map.json'),
  ('RDL-132', 'TrailBlayzer Hiking Boots', 'review', 'material-index.json#RDL-132', '2026-08-19', '2026-08', 'bound', 'reading/rdl/RDL-132/material_final.png', 'reading/rdl/RDL-132/selection_map.json'),
  ('RDL-133', 'Remote Learning Assignment Discussion', 'text_message_chain', 'material-index.json#RDL-133', '2026-08-19', '2026-08', 'bound', 'reading/rdl/RDL-133/material_final.png', 'reading/rdl/RDL-133/selection_map.json'),
  ('RDL-134', 'Question About Group Project Guidelines', 'email', 'material-index.json#RDL-134', '2026-08-19', '2026-08', 'bound', 'reading/rdl/RDL-134/material_final.png', 'reading/rdl/RDL-134/selection_map.json');

do $$
declare
  conflicting_ids text;
begin
  select string_agg(existing.material_id, ', ' order by existing.material_id)
    into conflicting_ids
  from public.reading_materials existing
  join travel_rdl_material_registration proposed using (material_id)
  where row(existing.title, existing.material_type, existing.source, existing.source_date,
            existing.year_month, existing.binding_status, existing.image_asset_path, existing.hitbox_data_path)
        is distinct from
        row(proposed.title, proposed.material_type, proposed.source, proposed.source_date,
            proposed.year_month, proposed.binding_status, proposed.image_asset_path, proposed.hitbox_data_path);

  if conflicting_ids is not null then
    raise exception 'Travel RDL registration conflicts with existing rows: %', conflicting_ids;
  end if;
end
$$;

insert into public.reading_materials (
  material_id, title, material_type, source, source_date, year_month,
  binding_status, image_asset_path, hitbox_data_path
)
select material_id, title, material_type, source, source_date, year_month,
       binding_status, image_asset_path, hitbox_data_path
from travel_rdl_material_registration
on conflict (material_id) do nothing;

do $$
declare
  target_count integer;
  mismatch_count integer;
begin
  select count(*) into target_count
  from public.reading_materials existing
  join travel_rdl_material_registration target using (material_id);

  select count(*) into mismatch_count
  from public.reading_materials existing
  join travel_rdl_material_registration target using (material_id)
  where row(existing.title, existing.material_type, existing.source, existing.source_date,
            existing.year_month, existing.binding_status, existing.image_asset_path, existing.hitbox_data_path)
        is distinct from
        row(target.title, target.material_type, target.source, target.source_date,
            target.year_month, target.binding_status, target.image_asset_path, target.hitbox_data_path);

  if target_count <> 46 or mismatch_count <> 0 then
    raise exception 'Travel RDL post-check failed: target_count=%, mismatch_count=%', target_count, mismatch_count;
  end if;

  if exists (select 1 from public.reading_materials where material_id in ('RDL-105', 'RDL-109')) then
    raise exception 'Retired Travel RDL ID exists';
  end if;
end
$$;

commit;
