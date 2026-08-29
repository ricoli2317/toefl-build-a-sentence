# Reading data pipeline

## Permanent project boundary

The separate Reading source-preparation project owns all Reading content production:

```text
/Users/rico/Desktop/真题/阅读/production  # formal content handoff
/Users/rico/Desktop/真题/阅读/_work       # temporary processing only

Reading project: source -> processing/QA -> production -> R2 handoff
TPS:             final CSV -> database import -> runtime consumption
```

TPS consumes only final Reading CSV, stable `material_id`, production references already registered in `reading_materials`, and R2 runtime assets through `lib/reading/assets.ts`. TPS must not produce or manage source PDFs, Reading DOCX, RDL crops/HD materials, selection maps, canonical assets, or content-production intermediates. Do not create a second canonical asset library under TPS `public/`, `data/`, or `tmp/`; do not copy `_work` into TPS; and do not add new `/Users/rico/Desktop/...` production/runtime dependencies.

The remaining sections describe the completed May/June Batch 1B and Batch 1B-R2 historical initialization. Their files and paths are retained for audit/reproducibility only. They are not the workflow for future Reading months and must not be rerun unless a one-time migration/debug task is explicitly approved.

The production boundary separates real source occurrences from student-facing logical practice items:

```text
May/June DOCX + answer DOCX
  -> source-packages/<month>/<source-set>.json
  -> reusable global grouping/fingerprint service
  -> import-packages/{ctw,rdl,rap}/<logical-item-id>.json
  -> validation
  -> idempotent importer
```

Date labels such as `5.3A` and `6.21B` are source occurrences, not Reading practice-item IDs. A logical item stores one complete CTW interaction, one RDL material plus its question group, or one RAP passage plus its question group. Exact duplicate occurrences share one stable `logicalItemId`; their source dates, labels, files, modules, orders, and question ranges remain structured occurrence records.

Dynamic catalog numbers are intentionally absent from persisted identity and titles. `computeReadingDisplayRanks` ranks each module independently by `firstSeenDate`, natural source-label order, source order, then stable logical ID.

## Historical May/June source conversion

The external directories are read-only. Run the adapter with the bundled document Python runtime:

```bash
/Users/rico/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  scripts/reading_docx_adapter.py \
  --project-root . \
  --may-questions '/Users/rico/Desktop/真题/阅读/5月/题目/套题' \
  --may-answers '/Users/rico/Desktop/真题/阅读/5月/最终答案/套题' \
  --june-questions '/Users/rico/Desktop/真题/阅读/6月/题目/套题' \
  --june-answers '/Users/rico/Desktop/真题/阅读/6月/答案/套题' \
  --material-index '/Users/rico/Desktop/真题/阅读/rdl-image-hitbox-prototype/data/material-index.json'
```

This archives all source DOCX files under `source-docx/`, copies canonical RDL files byte-for-byte to `public/reading/rdl/<material-id>/`, records checksums in `manifests/`, and emits source occurrence packages. Runtime data does not reference Desktop paths.

## Historical May/June global grouping

```bash
pnpm group:reading
```

The grouping service is independent of DOCX parsing and can receive future CSV-adapter occurrences. It creates conservative exact fingerprints from complete interaction content and writes:

- formal logical packages to `import-packages/ctw`, `import-packages/rdl`, and `import-packages/rap`;
- exact/possible duplicate findings to `reports/reading-dedup-report.json`;
- dynamically ranked inventory to `reports/reading-logical-inventory.json`.

Possible duplicates are reported and are never fuzzy-merged automatically.

## Historical May/June dry-runs/import

These validate every logical package, occurrence mapping, dedup fingerprint, archived DOCX reference, and bound runtime asset without opening a database connection:

```bash
pnpm import:reading -- data/reading/import-packages --dry-run --occurrence-month 2026-05
pnpm import:reading -- data/reading/import-packages --dry-run --occurrence-month 2026-06
```

After `supabase/reading_data_layer.sql` is explicitly applied and service-role variables are configured, an individual logical package can be imported with:

```bash
pnpm import:reading -- data/reading/import-packages/<module>/<logical-item-id>.json
```

The Batch 1B workflow does not apply the migration or write to Supabase.

## Historical Batch 1B-R2 asset initialization

The one-time TPS-hosted Cloudflare R2 initialization was separate from question importing. Its frozen protocol, local manifest preparation, controlled database-reference switch, runtime verification, and Batch 1C `material_id` contract are documented in [`r2/README.md`](r2/README.md). No full Cloudflare URL is stored in `reading_materials`. Future asset production/publishing belongs to the Reading project; TPS remains a runtime consumer.
