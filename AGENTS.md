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
