import {
  assignmentItemTypesForSubject,
  isAssignmentItemType,
  type AssignmentCatalogEntry,
  type AssignmentItemType,
  type AssignmentSubject,
  type ReadingLength
} from "./assignmentCatalog.ts";
import type { WritingAssignmentQuestionSource } from "./writingAssignments.ts";

/**
 * Minimal Assignment picker-state preservation (client only).
 *
 * The subject, the active item-type tab, one independent filter set per item
 * type (month / topic / RDL length / title search / page) and the cross-type
 * selection are kept in sessionStorage so 查看题目 and browser back never make
 * the teacher restart the filtering. It is deliberately NOT a global state
 * system: the draft holds only picker state, never students, titles or
 * deadlines, and it is cleared after a successful 布置.
 */

export type AssignmentPickerFilters = {
  itemType: AssignmentItemType;
  length: ReadingLength | "all";
  month: string;
  /** 1-based page inside this item type's own filtered result. */
  page: number;
  query: string;
  topic: string;
};

/**
 * Every item type keeps its own filter set, so switching tabs neither inherits
 * nor resets another tab's month / topic / length / search / page. The active
 * tab is only a view selector.
 */
export type AssignmentPickerState = {
  activeItemType: AssignmentItemType;
  tabs: Partial<Record<AssignmentItemType, AssignmentPickerFilters>>;
};

const PICKER_FILTER_KEYS = ["length", "month", "query", "topic"] as const;

export function defaultAssignmentPickerFilters(
  itemType: AssignmentItemType
): AssignmentPickerFilters {
  return {
    itemType,
    length: "all",
    month: "",
    page: 1,
    query: "",
    topic: ""
  };
}

export function defaultAssignmentPickerState(subject: AssignmentSubject): AssignmentPickerState {
  const activeItemType = assignmentItemTypesForSubject(subject)[0] ?? "email";
  return {
    activeItemType,
    tabs: { [activeItemType]: defaultAssignmentPickerFilters(activeItemType) }
  };
}

/** The one view model the picker renders for the active tab. */
export function assignmentPickerFiltersFor(
  state: AssignmentPickerState,
  itemType: AssignmentItemType
): AssignmentPickerFilters {
  const stored = state.tabs[itemType];
  if (!stored || stored.itemType !== itemType) return defaultAssignmentPickerFilters(itemType);
  return stored;
}

/** Switching tabs only changes the view; every tab keeps its own last filter set. */
export function selectAssignmentPickerItemType(
  state: AssignmentPickerState,
  itemType: AssignmentItemType
): AssignmentPickerState {
  if (state.activeItemType === itemType && state.tabs[itemType]) return state;
  return {
    activeItemType: itemType,
    tabs: {
      ...state.tabs,
      [itemType]: assignmentPickerFiltersFor(state, itemType)
    }
  };
}

/**
 * Changing any filter of one item type resets only that item type's page to 1;
 * other tabs keep both their filters and their page.
 */
export function updateAssignmentPickerFilters(
  state: AssignmentPickerState,
  itemType: AssignmentItemType,
  patch: Partial<Pick<AssignmentPickerFilters, (typeof PICKER_FILTER_KEYS)[number]>>
): AssignmentPickerState {
  const current = assignmentPickerFiltersFor(state, itemType);
  const changed = PICKER_FILTER_KEYS.some(
    (key) => key in patch && patch[key] !== current[key]
  );
  const next: AssignmentPickerFilters = {
    ...current,
    ...patch,
    itemType,
    page: changed ? 1 : current.page
  };
  return {
    activeItemType: state.activeItemType,
    tabs: { ...state.tabs, [itemType]: next }
  };
}

/** Paging never changes filters and never touches another tab. */
export function setAssignmentPickerPage(
  state: AssignmentPickerState,
  itemType: AssignmentItemType,
  page: number
): AssignmentPickerState {
  const current = assignmentPickerFiltersFor(state, itemType);
  const nextPage = Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1;
  return {
    activeItemType: state.activeItemType,
    tabs: {
      ...state.tabs,
      [itemType]: { ...current, itemType, page: nextPage }
    }
  };
}

export const ASSIGNMENT_DRAFT_STORAGE_KEY = "tps:teacher:assignment-draft:v2";
export const ASSIGNMENT_DRAFT_VERSION = 2;

export type AssignmentFormDraft = {
  picker: AssignmentPickerState;
  selection: AssignmentCatalogEntry[];
  source: WritingAssignmentQuestionSource | null;
  subject: AssignmentSubject;
  version: typeof ASSIGNMENT_DRAFT_VERSION;
};

export function readAssignmentDraft(): AssignmentFormDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(ASSIGNMENT_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AssignmentFormDraft;
    if (parsed?.version !== ASSIGNMENT_DRAFT_VERSION) return null;
    if (parsed.subject !== "writing" && parsed.subject !== "reading") return null;
    if (!Array.isArray(parsed.selection)) return null;
    if (!isAssignmentItemType(parsed.picker?.activeItemType)) return null;
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
