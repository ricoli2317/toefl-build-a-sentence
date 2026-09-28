import {
  assignmentItemTypesForSubject,
  type AssignmentCatalogEntry,
  type AssignmentItemType,
  type AssignmentSubject,
  type ReadingLength
} from "./assignmentCatalog.ts";
import type { WritingAssignmentQuestionSource } from "./writingAssignments.ts";

/**
 * Minimal Assignment picker-state preservation (client only).
 *
 * The subject, the active item-type tab, the month / topic / length filters,
 * the title search and the cross-type selection are kept in sessionStorage so
 * 查看题目 and browser back never make the teacher restart the filtering. It is
 * deliberately NOT a global state system: the draft holds only picker state,
 * never students, titles or deadlines, and it is cleared after a successful
 * 布置.
 */

export type AssignmentPickerFilters = {
  itemType: AssignmentItemType;
  length: ReadingLength | "all";
  month: string;
  query: string;
  topic: string;
};

export function defaultAssignmentPickerFilters(subject: AssignmentSubject): AssignmentPickerFilters {
  return {
    itemType: assignmentItemTypesForSubject(subject)[0] ?? "email",
    length: "all",
    month: "",
    query: "",
    topic: ""
  };
}

export const ASSIGNMENT_DRAFT_STORAGE_KEY = "tps:teacher:assignment-draft:v1";

export type AssignmentFormDraft = {
  filters: AssignmentPickerFilters;
  selection: AssignmentCatalogEntry[];
  source: WritingAssignmentQuestionSource | null;
  subject: AssignmentSubject;
  version: 1;
};

export function readAssignmentDraft(): AssignmentFormDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(ASSIGNMENT_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AssignmentFormDraft;
    if (parsed?.version !== 1) return null;
    if (parsed.subject !== "writing" && parsed.subject !== "reading") return null;
    if (!Array.isArray(parsed.selection) || !parsed.filters?.itemType) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeAssignmentDraft(draft: AssignmentFormDraft | null) {
  if (typeof window === "undefined") return;
  try {
    if (!draft) {
      window.sessionStorage.removeItem(ASSIGNMENT_DRAFT_STORAGE_KEY);
      return;
    }
    window.sessionStorage.setItem(ASSIGNMENT_DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // A full / blocked sessionStorage must never break the wizard.
  }
}
