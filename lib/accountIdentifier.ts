export const INTERNAL_ACCOUNT_DOMAIN = "bas.com";
export const ADMIN_LOGIN_ACCOUNT = "admin";
export const ADMIN_LOGIN_AUTH_EMAIL = "student@test.com";

const LEGACY_ACCOUNT_DISPLAY_ALIASES: Readonly<Record<string, string>> = {
  [ADMIN_LOGIN_AUTH_EMAIL]: ADMIN_LOGIN_ACCOUNT,
  "teacher@test.com": "teacher"
};

const NEW_ACCOUNT_PATTERN = /^[A-Za-z0-9]+$/;

export type NewAccountResult =
  | { ok: true; account: string; authEmail: string }
  | { ok: false; error: string };

export function resolveLoginAuthEmail(input: string) {
  const trimmed = input.trim();
  const normalized = trimmed.toLocaleLowerCase();

  if (normalized === ADMIN_LOGIN_ACCOUNT) return ADMIN_LOGIN_AUTH_EMAIL;
  if (trimmed.includes("@")) return trimmed;
  return normalized ? `${normalized}@${INTERNAL_ACCOUNT_DOMAIN}` : "";
}

export function normalizeNewAccountInput(input: string) {
  return input.trim().toLocaleLowerCase();
}

export function prepareNewAccount(input: string): NewAccountResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "请输入账号。" };
  if (!NEW_ACCOUNT_PATTERN.test(trimmed)) {
    return { ok: false, error: "账号只能包含英文字母和数字。" };
  }

  const account = trimmed.toLocaleLowerCase();
  if (account === ADMIN_LOGIN_ACCOUNT) {
    return { ok: false, error: "该账号不可使用。" };
  }

  return {
    ok: true,
    account,
    authEmail: `${account}@${INTERNAL_ACCOUNT_DOMAIN}`
  };
}

export function formatAccountForDisplay(identifier: string | null | undefined) {
  const trimmed = identifier?.trim() ?? "";
  const normalized = trimmed.toLocaleLowerCase();
  if (!trimmed) return "";
  const legacyAlias = LEGACY_ACCOUNT_DISPLAY_ALIASES[normalized];
  if (legacyAlias) return legacyAlias;

  const suffix = `@${INTERNAL_ACCOUNT_DOMAIN}`;
  if (normalized.endsWith(suffix)) return normalized.slice(0, -suffix.length);
  return trimmed;
}

export function formatManagedAccountName(
  displayName: string | null | undefined,
  identifier: string | null | undefined
) {
  const name = displayName?.trim() ?? "";
  const account = identifier?.trim() ?? "";
  if (!name || (account && name.toLocaleLowerCase() === account.toLocaleLowerCase())) {
    return formatAccountForDisplay(account);
  }
  return name;
}
