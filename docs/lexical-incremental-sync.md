# Lexical V1 incremental sync

Permanent delta-only maintenance entry point for the frozen Lexical V1 corpus. It never
regenerates or rewrites historical blocks: only blocks whose canonical identity is new,
whose source text hash changed, or whose canonical source disappeared since the last
full generation are planned, generated, consolidated and imported.

Canonical source → production lexical baseline → delta plan → delta generation →
delta consolidation → delta QA → incremental import.

## Boundary

- Read-only against production until the explicit `--write` import.
- The frozen full-generation corpus under `tmp/lexical-v1` is never reused as new delta output.
- Local workspace `tmp/lexical-incremental/` is Git-ignored and holds all artifacts.
- Unchanged production blocks never enter regenerated artifacts and are provably untouched
  by the import transaction (identity hashes are recomputed before and after).

## Commands

```sh
pnpm lexical:incremental plan                 # read-only baseline + canonical enumeration + delta plan
pnpm lexical:incremental stage-annotation     # build immutable annotation batches for the delta
pnpm lexical:incremental stage-mwe            # build MWE batches after annotation is complete
pnpm lexical:incremental stage-mwe-qa         # build MWE QA batches after MWE is complete
pnpm lexical:incremental next --stage annotation --owner WORKER
pnpm lexical:incremental accept --stage annotation --owner WORKER <batch-id>
pnpm lexical:incremental abort --stage annotation --owner WORKER --reason "blocker"
pnpm lexical:incremental status
pnpm lexical:incremental verify-baseline       # read-only full-row and canonical drift check; never refreshes the baseline
pnpm lexical:incremental verify-checkpoints --stage annotation  # replay validators and verify hash-bound receipts
pnpm lexical:incremental finalize             # consolidation + QA + import artifacts + manifest
pnpm lexical:incremental import               # dry run: artifact checks + read-only live baseline preflight
pnpm lexical:incremental import --write       # explicit production write (requires SUPABASE_DB_URL)
```

`lexical:incremental-import` is the dry-run alias for `pnpm lexical:incremental import`.

For later sync cycles, set a new `LEXICAL_INCREMENTAL_RUN` name consistently for every CLI
command and worker (for example `2026-10-next`). Its immutable workspace lives under
`tmp/lexical-incremental/runs/<name>/`. Never delete or overwrite a previous run to start
another cycle. The first run uses the default root without this variable.
Finalization and import both re-enumerate canonical sources read-only and refuse source drift.
Full production snapshots use bounded primary-key keyset pages (no deep OFFSET scans),
then sort locally under the unchanged full-row SHA-256 contract. Pagination never refreshes
or substitutes the frozen baseline; malformed/non-advancing pages fail closed.

## Worker protocol

Semantic generation runs through the same OpenChamber agent contract as the frozen corpus,
with the frozen validators (`validateAnnotationBatch`, the MWE token-expression alignment,
the MWE QA record contract) unchanged. Stage plans and batch inputs are immutable and
hash-bound; `next` claims one batch per owner with an exclusive claim file, `accept`
validates and checkpoints it, `abort` releases a claim with a concrete reason.

- Annotation stage: tokens only. The batch input carries every eligible token candidate;
  the output returns one annotation per candidate with `context_pos`, `context_meaning_zh`,
  `context_definition_en`, `canonical_expression`, `lemma`, `expression_type`, `needs_review`
  and `review_notes`. Provenance is recorded per stage plan (OpenChamber agent, openai,
  configured model, high reasoning).
- MWE stage: expressions only, aligned to at least two eligible tokens of the same block,
  exact UTF-16 slices. Layer-1 occurrences are re-derived from the frozen annotation
  checkpoints and must stay byte-identical.
- MWE QA stage: one PASS/ISSUE record per expression; ISSUE either removes an
  over-collected expression or corrects whitelisted fields. Identity, offsets and surface
  text can never be mutated.

Accepted outputs and checkpoints have a durable SHA-256 receipt. An interrupted worker resumes
its existing claim via `next`; valid outputs are preserved rather than regenerated. Legacy
checkpoint/output pairs require full validator replay before they can become complete.
The first in-progress plan can be strengthened once with `capture-baseline`, without changing
its immutable stage inputs. Future `plan` runs capture full-row SHA-256 baselines automatically.

## Consolidation contract

Delta occurrences are consolidated against the live production entry universe captured at
plan time:

- exact base identity reuse (`normalized_expression` + `expression_type` + empty
  `identity_variant`) keeps the existing production `entry_id` and semantic fields;
- only genuinely missing identities create new deterministic entries
  (`productionId("entry", entry_key)`);
- canonical/lemma conflicts, production convention mismatches and homograph collisions
  (`identity_variant` variants) are withheld as unresolved review groups. Non-zero
  unresolved conflicts make the publication not import-ready and the importer refuses.

Ambiguous base/variant identities require explicit reviewed per-occurrence assignments in
`entry-identity-resolutions.jsonl` (`source_occurrence_id`, `identity_variant`, `concise_reason`).
Each resolution also carries the exact `source_occurrence_sha256`, existing production
`entry_id`, and stage `provenance`; stale, duplicate and identity-changing decisions fail.
An empty variant must be chosen explicitly when the production base identity is ambiguous.
Resolutions reuse the exact matching production variant ID; they never overwrite its semantics.
Case-only canonical/lemma convention overlays replay the frozen validators and preserve
original checkpoints, offsets, surface text and contextual semantics. New senses or lemma
changes cannot be smuggled through this review mechanism.

Enrichment stays skipped: new entries use the production V1 legal empty arrays.

## Import transaction

`delta-import.sql` is a single `BEGIN … COMMIT` transaction:

1. advisory lock (`pg_advisory_xact_lock(7631043)`) plus table write locks;
2. schema guard (`identity_variant` and the production unique identity indexes must exist);
3. COPY of staged entries/blocks/occurrences/delta/removals/meta into temp tables;
4. fresh/applied classification per delta identity. A mixture, or any state that is neither
   the exact pre-state nor the exact post-state, aborts — baseline drift is never reconciled;
5. exact old changed/removed blocks and occurrences must match their recorded full-row
   pre-state SHA-256. Unrelated production rows must match full-row SHA-256 before and after,
   including JSON semantics, context text and audit timestamps; null and empty remain distinct;
6. only fresh runs mutate: replace occurrences of changed blocks, delete removed blocks,
   insert new entries/blocks/complete occurrence sets; already-applied reruns are no-ops;
7. insert-only for `lexical_entries` (never UPDATE/DELETE) and `ON CONFLICT DO NOTHING`
   for idempotency;
8. post verification: delta block consistency, removed blocks absent, occurrence sets equal
   both directions, staged entries present with identical content, no orphan occurrences,
   exact final counts, unrelated hashes unchanged.

Any failure raises and rolls back the whole transaction.

## Required local checks

Run `pnpm build` and the standalone TypeScript check sequentially: Next.js recreates
`.next/types` during a build, so overlapping them can cause transient missing-file errors.

```sh
pnpm exec tsc --noEmit --incremental false
pnpm build
git diff --check
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test \
  tests/lexicalIncremental.test.js tests/lexicalIncrementalImport.test.js \
  tests/lexicalIncrementalStages.test.js \
  tests/lexicalCanonicalBlocks.test.js tests/lexicalLookup.test.js tests/lexicalReadingRuntimeUi.test.js
```

Actual transaction tests use a local PostgreSQL WASM engine, not production. Install the
test-only runtime inside the ignored workspace, then run:

```sh
npm install --prefix tmp/lexical-incremental/sql-test-runtime --no-audit --no-fund --ignore-scripts @electric-sql/pglite
LEXICAL_SQL_TEST_PGLITE=tmp/lexical-incremental/sql-test-runtime/node_modules/@electric-sql/pglite \
  node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  --test tests/lexicalIncrementalSql.test.js
```

Without that environment variable, SQL-engine tests are explicitly skipped (never represented
as transaction proof). Tests execute the generated transaction and identical COPY CSV bytes;
only psql's stdin transport is adapted to the engine's Blob transport. They verify rollback,
exact replacement, baseline drift, unchanged zero writes with trigger auditing, and idempotency.
