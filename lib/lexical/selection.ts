import type { RdlSelectionMap } from "../reading/rdlSelection.ts";
import { reconstructRdlCanonicalMaterial, rdlInclusiveSelectionToLexicalRange } from "./enumerators/rdl.server.ts";

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
/** Range offsets stay JS UTF-16 and never include UI chrome or another canonical block. */
export function domLexicalSelection(block: HTMLElement, range: Range) {
  if (!block.contains(range.startContainer) || !block.contains(range.endContainer)) return null;
  const offset = (node: Node, end: number) => {
    const prefix = document.createRange(); prefix.selectNodeContents(block); prefix.setEnd(node, end);
    return prefix.toString().length;
  };
  const blockText = block.textContent ?? "";
  let startOffset = offset(range.startContainer, range.startOffset);
  let endOffset = offset(range.endContainer, range.endOffset);
  while (startOffset < endOffset && /\s/.test(blockText[startOffset])) startOffset++;
  while (endOffset > startOffset && /\s/.test(blockText[endOffset - 1])) endOffset--;
  return startOffset < endOffset ? { blockText, startOffset, endOffset, selectedText: blockText.slice(startOffset, endOffset) } : null;
}
