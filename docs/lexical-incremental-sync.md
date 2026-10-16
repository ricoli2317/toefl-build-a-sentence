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
pnpm lexical:incremental post-verify          # read-only exact applied/no-delta proof; never advances a checkpoint itself
```

`lexical:incremental-import` is the dry-run alias for `pnpm lexical:incremental import`.

For coordinated CTW vocabulary + lexical maintenance, use
[vocabulary-maintenance.md](vocabulary-maintenance.md). The coordinator invokes these
same stages/importer; it does not replace the lexical baseline or semantic protocol.

For later sync cycles, set a new `LEXICAL_INCREMENTAL_RUN` name consistently for every CLI
command and worker (for example `2026-10-next`). Its immutable workspace lives under
`tmp/lexical-incremental/runs/<name>/`. Never delete or overwrite a previous run to start
another cycle. The first run uses the default root without this variable.
Finalization and import both re-enumerate canonical sources read-only: every planned block's
identity, kind, exact text and anchors must remain identical, with no duplicate identities.
Extra blocks are allowed only for wholly new source items absent from the planned canonical
corpus; they are deferred to a later run and never added to this run's artifacts. Additions
inside planned items, modifications, deletions and invalid blocks still fail closed.
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

The same explicit hash-bound review may record `new_entry_convention` with
`canonical_expression` and `lemma` for a genuinely missing base identity (for example,
initial-capital program name vs its lowercase URL path). Its target ID must equal
`productionId("entry", entry_key)`, its variant must be empty, and **no** production
identity of that normalized expression/type may exist. This is not permission to create
a homograph variant or alter a lemma: only equivalence already recognized by the frozen
normalizer (case, whitespace, straight/curly apostrophes) is accepted. The original
checkpoint bytes, offsets, types and contextual semantics remain unchanged; validators
are replayed. Existing identities still require the exact existing production entry ID.
This convention overlay is explicitly Layer-1 only; Layer-2 identity corrections must
pass through the existing MWE QA validator instead of bypassing canonical-work replay.

### Layer-1 semantic review

`needs_review` is not publication approval. Finalize and import refuse any unresolved
occurrence, including publications made before this gate was introduced. A reviewed
Layer-1 correction is separate from identity review and MWE QA:

- `layer1-semantic-reviews.jsonl` records one `confirm` or `correct` decision for every
  flagged occurrence, bound to its full original-row SHA-256 and stage provenance.
- Each decision quotes immutable canonical evidence from the same source item, with
  block identity and text hash. Related passage/question blocks can resolve an isolated
  vocabulary option or pronoun; no invented source context is added to the occurrence.
- Only `context_pos`, `context_meaning_zh` and `context_definition_en` may be corrected.
  Source, offsets, surface, canonical/lemma, entry identity, type and generation version
  cannot change. Reviewed notes retain the original flag for audit.
- The original complete-token annotation validator replays every affected block. A
  source-level review reason cannot be cleared by this overlay. Accepted checkpoints
  and earlier publications remain unchanged; publish a separate review revision.
- The importer replays the accepted annotation plus identity and semantic reviews and
  compares the resulting Layer-1 rows to the publication, not just its claimed counters.

`lexical:incremental verify-publication` validates local artifact hashes, semantic review
replay and reproducible SQL only: **no remote reads, no database connection, no writes**.
It does not replace import-time live canonical/baseline guards or post-import proof.

Enrichment stays skipped: new entries use the production V1 legal empty arrays.

## Complete hyphenated compounds

The frozen Layer-1 tokenizer intentionally preserves separately selectable components
(`eco` / `friendly`, `fun` / `filled`). That is not complete compound coverage.
Every canonical lexical hyphen compound also requires an exact full-span occurrence:
`eco-friendly`, `fun-filled`, `meat-eating`, etc. A larger containing expression is not
a substitute. Generate the compound's POS, concise Chinese meaning and English definition
as a whole from its original canonical context, never by joining component definitions.

Stage inputs expose `required_hyphenated_compounds`. MWE acceptance, post-QA validation,
delta publication QA, and import artifact loading independently enforce this coverage.
QA may correct compound fields but cannot remove mandatory coverage. The import loader
recomputes from canonical text even for an older manifest claiming `import_ready`.
Existing accepted artifacts remain immutable; do not rewrite historical checkpoints to
make them satisfy a new coverage gate.

### Explicit nonlexical punctuation adjudication

A detector hit at a source punctuation junction (for example a subject-line delimiter)
must not be given an invented compound definition. Before building MWE, an independently
reviewed exact span may be recorded in `nonlexical-scope-reviews.json` with version
`lexical-incremental-nonlexical-review-v1`. The artifact binds the delta plan, complete
canonical block artifact and `independent-nonlexical-review.json` by SHA-256. Each decision
includes the exact source/block identity, UTF-16 offsets, surface, complete canonical
context, source text SHA-256, `not_lexical_compound` decision and a concrete reason;
provenance uses the configured incremental agent contract. The independent record must
adjudicate the same exact span and source hash. The minimal protocol currently accepts
one independently adjudicated span per run, not an unrestricted exclusion inventory.

Only new/changed delta blocks qualify. Duplicate, unknown, stale, extra-field and
out-of-scope decisions fail closed. MWE and MWE QA plans freeze the review artifact's
SHA-256; adding, deleting or modifying reviews after those plans exist is rejected.
MWE inputs separate reviewed nonlexical spans from mandatory compounds. MWE acceptance,
post-QA validation, publication QA and import loading independently recompute coverage:
unreviewed lexical compounds remain mandatory, and a reviewed nonlexical span cannot
be published as an exact lexical occurrence. QA separately reports raw detector spans,
reviewed exclusions and required lexical compounds. The manifest binds both review
artifacts. Without a review artifact, the original complete-coverage gate is unchanged.

This is an explicit semantic review overlay, not a tokenizer change, a global regex
exception, a canonical source edit or permission to omit genuine compounds. Original
component tokens, offsets, semantics, checkpoints and production entries stay intact.

Detection handles ASCII, Unicode hyphen and non-breaking hyphen with exact UTF-16 offsets;
repeated uses count separately. Spaced separators, en/em dashes, dates and numeric ranges
are not lexical compounds. Explicit person-name coverage exclusions remain excluded.

For an explicitly requested missing-compound repair after a run was imported:

```sh
LEXICAL_INCREMENTAL_RUN=UNIQUE_REPAIR_RUN pnpm lexical:hyphen-repair audit --source-run IMPORTED_RUN
# Author compound-annotations.json from the audit's missing spans and canonical contexts.
LEXICAL_INCREMENTAL_RUN=UNIQUE_REPAIR_RUN pnpm lexical:hyphen-repair finalize
LEXICAL_INCREMENTAL_RUN=UNIQUE_REPAIR_RUN pnpm lexical:hyphen-repair import
# Only the user-authorized production operation:
LEXICAL_INCREMENTAL_RUN=UNIQUE_REPAIR_RUN pnpm lexical:hyphen-repair import --write
```

Repair audit covers all canonical blocks of the source run's new/changed items, including
an existing material if only its option changed. It captures a fresh full-row baseline and
uses only production canonical tables and registered R2 references. Finalization validates
the new expressions against frozen component-token alignment, consolidates against current
entries, and binds every artifact by SHA-256. Only the newly authored expression fields
pass through the frozen semantic parser; existing component rows are used for alignment,
not renormalized or reannotated to change legacy production conventions. Repair import is a separate **append-only**
transaction: no block writes, no occurrence replacement, no entry updates. Existing rows
(including component tokens, context text, JSON fields and audit timestamps) must retain
their full-row hashes before and after. Partial/mixed application and semantic/baseline drift
fail closed; an exact applied rerun is zero-write. Both dry-run and write recheck live sources.

Historical repair may carry an explicit `approved-repair-spans.jsonl` whitelist from a
completed audit. It is hash-bound into the publication and dataset, must cover every
ordinary missing compound in scoped blocks, and cannot include already-covered spans.
This permits individually reviewed numeric lexical forms such as `10-page`, `mid-2020s`
or `CRISPR-Cas9` without changing the frozen Layer-1 tokenizer or granting an arbitrary
single-token MWE exception. Materialization only accepts the exact whitelisted canonical
hyphen span and context; ordinary MWE validation remains unchanged. Explicit excluded
source items are rejected by finalization and import dataset validation. A history repair
does not silently sync new materials or include product codes excluded by its audit.

An audit regex can also match ASCII punctuation at title/description or clause boundaries
(`efficiency-but`, `order-the`). Independent semantic QA must not invent glossary meanings
for these fragments. A history repair can carry exact, hash-bound
`nonlexical-scope-reviews.json` decisions after original-context adjudication. The original
approved inventory and batch outputs remain immutable; the publication separately reports
lexical insertions, adjudicated nonlexical exclusions, and any raw detector misses. Reviews
cannot skip other spans, change canonical text or cover unreviewed missing compounds.
All batch inputs, original outputs, QA, reviewed outputs and receipts are bound into the
repair manifest when the staged semantic protocol is used. These decisions are lexical
repair overlays, not edits to Reading-owned canonical assets or a generic exclusion rule.

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
