-- Register the verified 2026-08 additions / 2026-09 canonical RDL batch.
-- Review and run manually in the Supabase SQL Editor. This file is not run by Codex.
--
-- Authoritative Reading production inputs checked on 2026-09-17:
--   material-index.json
--     sha256 b9dd27f09d0fd1540b427e9f75b24f3a2592b5a215b773b115701c3db4d23f58
--   RDL_OCCURRENCE_MAP.json
--     sha256 91a54353316a6f1141bf58d058175ba37c79dcecd700ecb3e412dbf6ee028cc9
--   READING_202608_202609_RDL_MATERIAL_TYPE_MAP.json
--     sha256 07f400db8576beeb7b5d7a250616af948708bce3d2ad4d269b591050824f746a
--   RDL_RELEASE_202608_202609.json
--     sha256 9c56996d41a3ebb72b7338eeb2effd54794ae713f325e0396023fc56b8ba1812
--   RDL_R2_RELEASE_202608_202609.json
--     sha256 867d336887ce99e5faa777a83892504b773144fac600dcb97e6a3cf59b0b0192
--
-- All 21 asset.json files and their material_final / selection_map payloads were
-- SHA-256-checked against the frozen release. The R2 release reports 42/42 objects
-- verified for private API, public runtime, checksum, content type and cache control.
--
-- Guarantees:
--   * existing material_id rows are compared null-safely and never overwritten;
--   * only missing rows are inserted;
--   * any mismatch or incomplete post-write state aborts the whole transaction;
--   * no CSV, R2 object, material_id allocation or dedup state is changed.

begin;

-- Reading production owns the canonical taxonomy. TPS enforces only the stable
-- snake_case storage contract, so future authoritative types need no TPS DDL.
alter table public.reading_materials
  drop constraint if exists reading_materials_material_type_check;

alter table public.reading_materials
  add constraint reading_materials_material_type_check check (
    material_type ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
  );

create temporary table rdl_material_registration_expected (
  material_id text primary key,
  title text not null,
  material_type text not null,
  source text not null,
  source_date date not null,
  year_month text not null,
  binding_status text not null,
  image_asset_path text not null,
  hitbox_data_path text not null
) on commit drop;

insert into rdl_material_registration_expected (
  material_id, title, material_type, source, source_date, year_month,
  binding_status, image_asset_path, hitbox_data_path
) values
  ('RDL-135', 'BIO 101 Spring Semester', 'course_description', 'material-index.json#RDL-135', '2026-08-17', '2026-08', 'bound', 'reading/rdl/RDL-135/material_final.png', 'reading/rdl/RDL-135/selection_map.json'),
  ('RDL-136', 'Branford Art Exhibition', 'notice', 'material-index.json#RDL-136', '2026-08-17', '2026-08', 'bound', 'reading/rdl/RDL-136/material_final.png', 'reading/rdl/RDL-136/selection_map.json'),
  ('RDL-137', 'Campus Advice Email', 'email', 'material-index.json#RDL-137', '2026-08-17', '2026-08', 'bound', 'reading/rdl/RDL-137/material_final.png', 'reading/rdl/RDL-137/selection_map.json'),
  ('RDL-138', 'La Taberna Review', 'review', 'material-index.json#RDL-138', '2026-08-17', '2026-08', 'bound', 'reading/rdl/RDL-138/material_final.png', 'reading/rdl/RDL-138/selection_map.json'),
  ('RDL-139', 'Maplewood Housing Fair', 'notice', 'material-index.json#RDL-139', '2026-08-22', '2026-08', 'bound', 'reading/rdl/RDL-139/material_final.png', 'reading/rdl/RDL-139/selection_map.json'),
  ('RDL-140', 'Extended Library Hours', 'notice', 'material-index.json#RDL-140', '2026-08-22', '2026-08', 'bound', 'reading/rdl/RDL-140/material_final.png', 'reading/rdl/RDL-140/selection_map.json'),
  ('RDL-141', 'Career Guidance Request', 'email', 'material-index.json#RDL-141', '2026-08-22', '2026-08', 'bound', 'reading/rdl/RDL-141/material_final.png', 'reading/rdl/RDL-141/selection_map.json'),
  ('RDL-142', 'Library Study Room Request', 'form', 'material-index.json#RDL-142', '2026-08-23', '2026-08', 'bound', 'reading/rdl/RDL-142/material_final.png', 'reading/rdl/RDL-142/selection_map.json'),
  ('RDL-143', 'Energy Regulation Email', 'email', 'material-index.json#RDL-143', '2026-08-23', '2026-08', 'bound', 'reading/rdl/RDL-143/material_final.png', 'reading/rdl/RDL-143/selection_map.json'),
  ('RDL-144', 'Clothing Design Volunteers', 'notice', 'material-index.json#RDL-144', '2026-08-24', '2026-08', 'bound', 'reading/rdl/RDL-144/material_final.png', 'reading/rdl/RDL-144/selection_map.json'),
  ('RDL-145', 'Student Council Meeting', 'meeting_minutes', 'material-index.json#RDL-145', '2026-08-24', '2026-08', 'bound', 'reading/rdl/RDL-145/material_final.png', 'reading/rdl/RDL-145/selection_map.json'),
  ('RDL-146', 'Campus International Festival', 'advertisement', 'material-index.json#RDL-146', '2026-08-25', '2026-08', 'bound', 'reading/rdl/RDL-146/material_final.png', 'reading/rdl/RDL-146/selection_map.json'),
  ('RDL-147', 'Outdoor Culture Night', 'notice', 'material-index.json#RDL-147', '2026-08-26', '2026-08', 'bound', 'reading/rdl/RDL-147/material_final.png', 'reading/rdl/RDL-147/selection_map.json'),
  ('RDL-148', 'Zoning Policy Course', 'article', 'material-index.json#RDL-148', '2026-08-26', '2026-08', 'bound', 'reading/rdl/RDL-148/material_final.png', 'reading/rdl/RDL-148/selection_map.json'),
  ('RDL-149', 'Campus Transit Panel', 'article', 'material-index.json#RDL-149', '2026-08-26', '2026-08', 'bound', 'reading/rdl/RDL-149/material_final.png', 'reading/rdl/RDL-149/selection_map.json'),
  ('RDL-150', 'Anthropology 214 Syllabus', 'course_syllabus', 'material-index.json#RDL-150', '2026-08-26', '2026-08', 'bound', 'reading/rdl/RDL-150/material_final.png', 'reading/rdl/RDL-150/selection_map.json'),
  ('RDL-151', 'Dorm Repair Request', 'form', 'material-index.json#RDL-151', '2026-08-31', '2026-08', 'bound', 'reading/rdl/RDL-151/material_final.png', 'reading/rdl/RDL-151/selection_map.json'),
  ('RDL-152', 'Plant Intelligence Lecture', 'announcement', 'material-index.json#RDL-152', '2026-08-31', '2026-08', 'bound', 'reading/rdl/RDL-152/material_final.png', 'reading/rdl/RDL-152/selection_map.json'),
  ('RDL-153', 'Suncrest Beach Spring Break', 'poster', 'material-index.json#RDL-153', '2026-09-05', '2026-09', 'bound', 'reading/rdl/RDL-153/material_final.png', 'reading/rdl/RDL-153/selection_map.json'),
  ('RDL-154', 'Campus Mobility Drivers', 'advertisement', 'material-index.json#RDL-154', '2026-09-06', '2026-09', 'bound', 'reading/rdl/RDL-154/material_final.png', 'reading/rdl/RDL-154/selection_map.json'),
  ('RDL-155', 'Foraging Expedition', 'invitation', 'material-index.json#RDL-155', '2026-09-06', '2026-09', 'bound', 'reading/rdl/RDL-155/material_final.png', 'reading/rdl/RDL-155/selection_map.json');

-- Existing rows are verification-only. Any difference aborts before the insert.
do $$
declare
  mismatch_details text;
begin
  select string_agg(
    format('%s differs from the authoritative batch row', actual.material_id),
    E'\n' order by actual.material_id
  )
  into mismatch_details
  from public.reading_materials actual
  join rdl_material_registration_expected expected using (material_id)
  where row(
    actual.title,
    actual.material_type,
    actual.source,
    actual.source_date,
    actual.year_month,
    actual.binding_status,
    actual.image_asset_path,
    actual.hitbox_data_path
  ) is distinct from row(
    expected.title,
    expected.material_type,
    expected.source,
    expected.source_date,
    expected.year_month,
    expected.binding_status,
    expected.image_asset_path,
    expected.hitbox_data_path
  );

  if mismatch_details is not null then
    raise exception using
      message = 'Existing reading_materials rows do not match the authoritative batch',
      detail = mismatch_details;
  end if;
end
$$;

insert into public.reading_materials (
  material_id, title, material_type, source, source_date, year_month,
  binding_status, image_asset_path, hitbox_data_path
)
select
  expected.material_id,
  expected.title,
  expected.material_type,
  expected.source,
  expected.source_date,
  expected.year_month,
  expected.binding_status,
  expected.image_asset_path,
  expected.hitbox_data_path
from rdl_material_registration_expected expected
where not exists (
  select 1
  from public.reading_materials actual
  where actual.material_id = expected.material_id
)
order by expected.material_id;

-- Post-write assertion: all 21 rows must exist and still match every owned field.
do $$
declare
  verified_count integer;
  mismatch_count integer;
begin
  select count(*)
  into verified_count
  from public.reading_materials actual
  join rdl_material_registration_expected expected using (material_id);

  select count(*)
  into mismatch_count
  from public.reading_materials actual
  join rdl_material_registration_expected expected using (material_id)
  where row(
    actual.title,
    actual.material_type,
    actual.source,
    actual.source_date,
    actual.year_month,
    actual.binding_status,
    actual.image_asset_path,
    actual.hitbox_data_path
  ) is distinct from row(
    expected.title,
    expected.material_type,
    expected.source,
    expected.source_date,
    expected.year_month,
    expected.binding_status,
    expected.image_asset_path,
    expected.hitbox_data_path
  );

  if verified_count <> 21 or mismatch_count <> 0 then
    raise exception
      'RDL registration verification failed: verified_count=%, mismatch_count=%',
      verified_count,
      mismatch_count;
  end if;
end
$$;

select
  count(*) as verified_material_count,
  min(material_id) as first_material_id,
  max(material_id) as last_material_id
from public.reading_materials
where material_id between 'RDL-135' and 'RDL-155';

commit;
