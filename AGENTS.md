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