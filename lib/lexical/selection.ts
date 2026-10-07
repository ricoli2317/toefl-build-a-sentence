import { rdlSelectedCharacters, type RdlSelectionMap } from "../reading/rdlSelection.ts";
import { reconstructRdlCanonicalMaterial, rdlInclusiveSelectionToLexicalRange } from "./enumerators/rdl.server.ts";
import type { LexicalLookupRequest } from "./lookup.ts";
import type { LexicalRect } from "./position.ts";

/** Same legacy break policy used by the frozen source loader, never OCR or new hitboxes. */
export function canonicalRdlSelectionMap(map: RdlSelectionMap): RdlSelectionMap {
  return { ...map, lines: map.lines.map((line, i) => ({ ...line,
    breakAfter: line.breakAfter === "unknown" ? i === map.lines.length - 1 ? "end" : "space" : line.breakAfter })) };
}
export function rdlLexicalSelection(map: RdlSelectionMap, range: { startIndex: number; endIndex: number }) {
  const material = reconstructRdlCanonicalMaterial(canonicalRdlSelectionMap(map));
  const span = rdlInclusiveSelectionToLexicalRange(material, range.startIndex, range.endIndex);
  return { ...span, blockText: material.text, selectedText: material.text.slice(span.startOffset, span.endOffset) };
}
/** RDL has no DOM text Range; its verified hitboxes provide equivalent live viewport geometry. */
export function rdlLexicalSelectionRect(map: RdlSelectionMap, range: { startIndex: number; endIndex: number }, bounds: LexicalRect): LexicalRect | null {
  const chars = rdlSelectedCharacters(map, range);
  if (!chars.length || !bounds.width || !bounds.height) return null;
  const left = bounds.left + Math.min(...chars.map(c => c.bbox.x)) * bounds.width;
  const top = bounds.top + Math.min(...chars.map(c => c.bbox.y)) * bounds.height;
  const right = bounds.left + Math.max(...chars.map(c => c.bbox.x + c.bbox.width)) * bounds.width;
  const bottom = bounds.top + Math.max(...chars.map(c => c.bbox.y + c.bbox.height)) * bounds.height;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}
/** Range offsets stay JS UTF-16 and never include UI chrome or another canonical block. */
export function domLexicalSelection(block: HTMLElement, range: Range) {
  if (!block.contains(range.startContainer) || !block.contains(range.endContainer)) return null;
  const offset = (node: Node, end: number) => {
    const prefix = document.createRange(); prefix.selectNodeContents(block); prefix.setEnd(node, end);
    return prefix.toString().length;
  };
  const blockText = block.textContent ?? "";
  const startOffset = offset(range.startContainer, range.startOffset);
  const endOffset = offset(range.endContainer, range.endOffset);
  return startOffset < endOffset ? { blockText, startOffset, endOffset, selectedText: blockText.slice(startOffset, endOffset) } : null;
}

/** The Range, not the pointer-up target, determines the authorized canonical block. */
export function domCanonicalLexicalSelection(region: HTMLElement, range: Range) {
  const block = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-lexical-block]");
  const start = block(range.startContainer); const end = block(range.endContainer);
  if (!start || !end || !region.contains(start) || !region.contains(end)
    || start.dataset.lexicalBlock !== end.dataset.lexicalBlock
    || start.closest("[data-lexical-exclude]") || end.closest("[data-lexical-exclude]")
    || Array.from(region.querySelectorAll("[data-lexical-exclude]")).some(node => range.intersectsNode(node))) return null;
  // Matching paragraph endpoints do not authorize crossing an inserted sentence from another block.
  if (Array.from(region.querySelectorAll<HTMLElement>("[data-lexical-block]")).some(node =>
    node.dataset.lexicalBlock !== start.dataset.lexicalBlock && range.intersectsNode(node))) return null;
  const blockText = start.dataset.lexicalText ?? start.textContent ?? "";
  const contentBlockId = start.dataset.lexicalBlock!;
  if (start === end) {
    const span = domLexicalSelection(start, range);
    if (!span) return null;
    const base = Number(start.dataset.lexicalOffset ?? 0);
    const ctwAnchor = start.dataset.lexicalCtwAnchor ? JSON.parse(start.dataset.lexicalCtwAnchor) as LexicalLookupRequest["ctwAnchor"] : undefined;
    return { contentBlockId, ...span, blockText, ctwAnchor, startOffset: span.startOffset + base, endOffset: span.endOffset + base };
  }
  // RAP sentence runs are separated by UI markers but share canonical paragraph text/offsets.
  // CTW projections must never bridge a submitted slot or another projected segment.
  if (start.dataset.lexicalCtwAnchor || end.dataset.lexicalCtwAnchor || end.dataset.lexicalText !== blockText) return null;
  const a = range.cloneRange(); a.setEnd(start, start.childNodes.length);
  const b = range.cloneRange(); b.setStart(end, 0);
  const left = domLexicalSelection(start, a); const right = domLexicalSelection(end, b);
  if (!left || !right) return null;
  const startOffset = Number(start.dataset.lexicalOffset ?? 0) + left.startOffset;
  const endOffset = Number(end.dataset.lexicalOffset ?? 0) + right.endOffset;
  return { contentBlockId, blockText, startOffset, endOffset, selectedText: blockText.slice(startOffset, endOffset) };
}
