import { pinyin } from "pinyin-pro";

/**
 * Student account suggestions for the class creation flow.
 *
 * The account base is derived from the student name (pinyin, letters/digits
 * only) and stays fully editable by the teacher; when the auto-suggested base
 * is already taken the server appends a numeric suffix (base2, base3, ...).
 * These pure helpers are shared by the form (live suggestion) and the server
 * (unique-suffix resolution).
 */

const MAX_ACCOUNT_BASE_LENGTH = 30;
const DEFAULT_SUFFIX_LIMIT = 50;

export function accountBaseFromStudentName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return "";
  const segments = pinyin(trimmed, {
    mode: "surname",
    surname: "head",
    toneType: "none",
    type: "array"
  });
  return segments
    .join("")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, MAX_ACCOUNT_BASE_LENGTH);
}

/** `base`, `base2`, `base3`, ... in deterministic order. */
export function studentAccountCandidates(base: string, limit = DEFAULT_SUFFIX_LIMIT) {
  const normalized = base
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, MAX_ACCOUNT_BASE_LENGTH);
  if (!normalized) return [] as string[];
  const candidates = [normalized];
  for (let suffix = 2; suffix < 2 + limit; suffix += 1) {
    candidates.push(`${normalized}${suffix}`);
  }
  return candidates;
}

/**
 * First free candidate. `isTaken` is supplied by the caller (it checks the real
 * account namespace) so this stays a pure helper.
 */
export function firstAvailableStudentAccount(
  base: string,
  isTaken: (account: string) => boolean,
  limit = DEFAULT_SUFFIX_LIMIT
) {
  for (const candidate of studentAccountCandidates(base, limit)) {
    if (!isTaken(candidate)) return candidate;
  }
  return null;
}

/**
 * The auto-suffix rule applies only while the account is still the untouched
 * pinyin suggestion; a teacher-edited account reports the conflict normally.
 */
export function accountAutoSuffixAllowed(accountEdited: boolean) {
  return !accountEdited;
}
