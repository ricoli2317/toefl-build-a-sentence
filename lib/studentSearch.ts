import { pinyin } from "pinyin-pro";

export type StudentSearchMetadata = {
  compactPinyin: string;
  directText: string;
  fullPinyin: string;
  group: string;
  initials: string;
  surnamePinyin: string;
};

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function createStudentSearchMetadata(displayName: string): StudentSearchMetadata {
  const normalizedName = displayName.trim();
  const syllables = pinyin(normalizedName, {
    mode: "surname",
    surname: "head",
    toneType: "none",
    type: "array"
  }).map((part) => part.toLocaleLowerCase());
  const fullPinyin = syllables.join(" ");
  const compactPinyin = normalizeStudentSearchText(fullPinyin);
  const directText = normalizeStudentSearchText(normalizedName);
  const surnamePinyin = normalizeStudentSearchText(syllables[0] ?? "");
  const initials = syllables
    .map((part) => part.match(/[a-z]/)?.[0] ?? "")
    .join("");
  const firstLetter = (surnamePinyin || directText)
    .match(/[a-z]/i)?.[0]?.toUpperCase() ?? "#";
  return {
    compactPinyin,
    directText,
    fullPinyin,
    group: ALPHABET.includes(firstLetter) ? firstLetter : "#",
    initials,
    surnamePinyin
  };
}

export function studentSearchRank(
  metadata: StudentSearchMetadata,
  displayName: string,
  query: string
) {
  const rawQuery = query.trim().toLocaleLowerCase();
  const normalizedQuery = normalizeStudentSearchText(rawQuery);
  if (!normalizedQuery) return 0;
  const normalizedName = displayName.trim().toLocaleLowerCase();
  if (normalizedName === rawQuery) return 0;
  if (metadata.directText === normalizedQuery) return 1;
  if (metadata.directText.includes(normalizedQuery)) return 2;
  if (metadata.compactPinyin.startsWith(normalizedQuery)) return 3;
  if (metadata.compactPinyin.includes(normalizedQuery)) return 4;
  if (metadata.initials.includes(normalizedQuery)) return 5;
  return Number.POSITIVE_INFINITY;
}

export function compareStudentSearchMetadata(
  left: StudentSearchMetadata & { displayName: string; id: string },
  right: StudentSearchMetadata & { displayName: string; id: string }
) {
  return (
    compareStudentSearchGroups(left.group, right.group) ||
    left.surnamePinyin.localeCompare(right.surnamePinyin, "en") ||
    left.compactPinyin.localeCompare(right.compactPinyin, "en") ||
    left.displayName.localeCompare(right.displayName, "zh-CN") ||
    left.id.localeCompare(right.id)
  );
}

export function compareStudentSearchGroups(left: string, right: string) {
  if (left === right) return 0;
  if (left === "#") return 1;
  if (right === "#") return -1;
  return left.localeCompare(right, "en");
}

export function normalizeStudentSearchText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, "");
}
