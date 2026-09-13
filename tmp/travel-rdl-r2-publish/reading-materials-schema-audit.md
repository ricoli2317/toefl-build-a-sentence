# Travel RDL reading_materials schema audit

## Runtime asset contract

- Canonical helper: `readingRdlObjectKeys(material_id)`.
- New Work-created keys: `reading/rdl/<RDL-ID>/material_final.png` and `reading/rdl/<RDL-ID>/selection_map.json`.
- Paths are stable, non-versioned object keys. URLs are not stored in `reading_materials`.
- Runtime calls `resolveReadingAssetUrl`, trims trailing slashes from `READING_ASSET_BASE_URL`, URL-encodes each key segment, then joins `baseUrl + "/" + encodedKey`.
- Historical database state is mixed by design: 10 recovered assets use hash-versioned keys; 76 use stable non-versioned keys. The importer permits a registered matching versioned image/selection pair only through its explicit compatibility option.

## Table schema

- Actual table: `public.reading_materials`.
- Primary/unique key: `material_id text primary key`.
- Required: `material_type`, `source`, `year_month`, `binding_status`.
- `title` and `source_date` are nullable at table level, but RDL CSV import requires the canonical title to exist and match.
- Bound rows require non-empty `image_asset_path` and `hitbox_data_path`; pending rows require both to be null.
- There are no width, height, image hash, selection hash, or URL columns.
- IDs are canonical `RDL-[0-9]{3}` values.

## Runtime/import acceptance

CSV import accepts an RDL material only when the ID already exists in `reading_materials`, `binding_status='bound'`, both object keys are present and valid, `material_type` matches the CSV instruction mapping, and the canonical title matches. New assets use the stable key pair returned by `readingRdlObjectKeys`; explicitly registered historical versioned pairs are compatibility-only.

## Database read-only audit

- Existing table rows: 86.
- Existing historical rows bound: 86.
- Historical hash-versioned key pairs: 10.
- Historical stable key pairs: 76.
- Target Work-created rows: 46; MISSING=46, EXISTS_SAME=0, EXISTS_DIFFERENT=0.
- No SQL was executed.

## Material-type authority

Material types are derived from explicit `rdl_type` values in the Travel release map where present. When Group B release rows omit that field, the script reads the matching numbered “Read …” instruction from the authoritative generated suite DOCX. It never infers type from title or image content.

Type evidence rows: 67 occurrence-level records covering 46 canonical IDs.
