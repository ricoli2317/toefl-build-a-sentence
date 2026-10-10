/** Page lifecycle, not text selectability or an editor's readonly attribute. */
export type LexicalPageMode = "practice" | "readonly";

/** Fail closed when a caller has not explicitly identified a readonly page. */
export function lexicalLookupEnabled(mode: LexicalPageMode, enabled = true) {
  return mode === "readonly" && enabled;
}
