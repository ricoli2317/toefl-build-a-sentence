## TPS Local Browser Test Accounts

Local Student and Teacher test credentials are stored in:

`.codex/tps-test-accounts.local`

When browser verification requires authentication:

- Read the required Student or Teacher credentials from this file.
- Use them only with the normal TPS localhost login UI.
- Do not ask the user for the credentials again if this file is available.
- Never print or expose passwords in responses.
- Never copy credentials into source code, tests, SQL, logs, screenshots, commits, or other tracked files.
- Never modify the credential file.
- Never create replacement test accounts unless explicitly requested.
- Keep browser verification on the same localhost origin and port for the entire authenticated session.

## pnpm in the shared-node_modules maintenance worktree

- For existing scripts, always use `pnpm --config.verify-deps-before-run=false <script>` (including `dev` and `test`). This skips pnpm's automatic pre-run dependency install; it does not disable deletion protection or rebuild dependencies. Do not ask the user to explain this again in a new session.
- Dependency installation is a separate, explicit operation. Preserve the existing shared `node_modules` symlink and both worktrees. When pnpm reports a virtual-store mismatch, use the existing real target's `.pnpm` directory via `--virtual-store-dir`, not a new dependency environment or a purge.
- Never use `CI=true` or disable purge confirmation to work around this layout. Keep TLS verification enabled; a broken mirror may be overridden per command with the official npm registry.

## Mandatory Local Browser Verification Flow

For every Codex browser verification involving Student or Teacher login or any localhost page:

1. Start the local development server normally before starting a browser session:

   ```bash
   cd "/Users/rico/Documents/Codex/2026-07-04/next-js-typescript-toefl-build-a" && pnpm --config.verify-deps-before-run=false dev
   ```

2. Do not proactively specify a hostname and do not proactively change the port.
3. Wait until the terminal explicitly reports that Next.js is Ready or the service has started before opening the browser.
4. Do not require a separate `curl` request or HTTP 200 check.
5. If this normal startup command itself fails to start, report the actual startup error separately and do not start the browser.
6. Never access localhost before the service is confirmed started. This prevents browser URL security-policy lockout from blocking the remaining verification.

## Permanent Reading Content Ownership Boundary

Reading content production is owned by the separate Reading source-preparation project, not TPS.

- Formal Reading content root: `/Users/rico/Desktop/真题/阅读/production`
- Temporary Reading processing root: `/Users/rico/Desktop/真题/阅读/_work`
- The Reading project owns source PDF, processing, QA, DOCX, RDL crop/HD material, selection maps, canonical assets, and the production handoff/R2 publishing workflow.
- TPS consumes only final Reading CSV files, stable `material_id` values, production asset references already registered in `reading_materials`, and R2 runtime assets through the existing resolver.
- Never create a second canonical RDL asset collection in TPS.
- Never copy `_work` files into TPS as formal assets or use `_work` as a runtime/production dependency.
- Never hard-code `/Users/rico/Desktop/...` as a new long-term TPS dependency.
- Never turn TPS `public/`, `data/`, `tmp/`, or another TPS directory into the formal Reading asset library.
- Future Reading handoff is strictly: Reading project `source -> _work -> production -> R2`; TPS `final CSV -> import -> database -> runtime consumption`.
- Direct TPS access to Reading PDF, DOCX, canonical local images, selection files, or `_work` requires an explicitly approved one-time migration/debug task.

Existing May/June DOCX tooling and Batch 1B-R2 publisher/manifests are retained only as completed historical initialization tooling. Do not delete, rerun, migrate, or reinterpret them as the future production workflow. Do not change the existing Reading database rows, object keys, or R2 objects merely to enforce this boundary.

## Long-term Markdown, SQL and Git Submission Policy

### Markdown files

- Do not create Markdown execution reports, audit reports, test reports or phase summaries for future development tasks, including extra `docs/*.md` files solely to record the development process.
- Deliver the complete task report directly in the final ChatGPT/OpenChamber response: changed files, implementation details, test results, remaining issues and safety status.
- Markdown that is not required to run the project must not be included in Git submissions. This includes README files, designs, feasibility studies, intermediate audits, benchmark reports, test records and implementation summaries.
- `AGENTS.md` is the explicit exception: it is a version-controlled project development policy and should be submitted.
- Other Markdown may be submitted only when it is a necessary input to project runtime, deployment or tool execution. State the concrete consumer and purpose; being useful documentation or historical evidence alone is insufficient.

### SQL files

- Submit necessary formal schema migrations for new database structures that must be versioned with the project. Distinguish a schema migration from a one-off data operation, and distinguish installation in a database from inclusion in Git history.
- Do not submit one-time data fixes, standalone UPDATE scripts or historical data migration scripts merely because they have been executed.
- Do not submit read-only inspection SQL, acceptance SQL or temporary troubleshooting SQL. Do not add completed, non-repeatable historical SQL merely for record completeness.
- Preserve migrations already committed in Git history; do not delete or rewrite them as part of cleanup.
- Never submit scripts that would cause accidental re-execution, duplicate production data changes or ambiguous migration ordering. An already-applied formal migration retained as a versioned definition is not authorization to run it again.

### Git scope and safe exclusion

- Git primarily stores formal business code, required runtime configuration, `package.json`, `pnpm-lock.yaml`, necessary automated tests and formal database migrations that must accompany the project version. It is not a development-process archive.
- Review all modified, deleted and untracked files before delivery. Preserve valid prior Phase 1–4, Tiptap and other work; do not delete previously committed formal project files or discard effective workspace changes.
- Prefer preserving excluded files in an archive outside both working trees, with their original paths and a recoverable inventory. Keep sensitive local data local. Remove obsolete script entries or file dependencies when archiving their targets so the submitted project remains self-contained.
- Do not use `git reset --hard`, `git clean`, forced checkouts, bulk overwrites, `skip-worktree`, `assume-unchanged` or similar change-hiding techniques to manufacture a clean status. Do not use broad `*.md` ignore rules to hide files that should be submitted.
- Preserve the dual-worktree workflow and shared `node_modules` layout. Use `pnpm --config.verify-deps-before-run=false` for project commands; do not rebuild or reinstall shared dependencies merely for cleanup.
- If runtime code has not changed, retain previously verified Build, TypeScript, ESLint and test evidence instead of rerunning everything. Run targeted checks for changed code, configuration or tests and explain which results are reused.
- Keep `WRITING_CORRECTION_ENTRY_ENABLED` false and do not alter or bypass the production Gate. Cleanup never authorizes SQL execution, production environment changes, staging, commit, push or deployment.
