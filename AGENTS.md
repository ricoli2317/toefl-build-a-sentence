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

## Mandatory Local Browser Verification Flow

For every Codex browser verification involving Student or Teacher login or any localhost page:

1. Start the local development server normally before starting a browser session:

   ```bash
   cd "/Users/rico/Documents/Codex/2026-07-04/next-js-typescript-toefl-build-a" && pnpm dev
   ```

2. Do not proactively specify a hostname and do not proactively change the port.
3. Wait until the terminal explicitly reports that Next.js is Ready or the service has started before opening the browser.
4. Do not require a separate `curl` request or HTTP 200 check.
5. If normal `pnpm dev` itself fails to start, report the actual startup error separately and do not start the browser.
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
