export type ReadingLookupModule = "ctw" | "rdl" | "rap";
export type ReadingPracticeMode = "active" | "submitted_review";

export const READING_LOOKUP_CAPABILITIES: Readonly<
  Record<ReadingPracticeMode, Readonly<Record<ReadingLookupModule, boolean>>>
> = Object.freeze({
  active: Object.freeze({ ctw: false, rdl: false, rap: false }),
  submitted_review: Object.freeze({ ctw: true, rdl: true, rap: true })
});

export const ACTIVE_READING_LOOKUP_CAPABILITIES = READING_LOOKUP_CAPABILITIES.active;

export function readingLookupEnabled(mode: ReadingPracticeMode, module: ReadingLookupModule) {
  return READING_LOOKUP_CAPABILITIES[mode][module];
}

export function activeReadingLookupEnabled(module: ReadingLookupModule) {
  return readingLookupEnabled("active", module);
}
