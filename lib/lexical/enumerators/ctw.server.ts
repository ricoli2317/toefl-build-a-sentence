import type { CanonicalLexicalBlock } from "../types.ts";

export type CtwLexicalInput = {
  sourceItemId: string;
  paragraphs: Array<{ paragraphId: string; paragraphOrder: number }>;
  segments: Array<{
    paragraphId: string;
    segmentOrder: number;
    segmentType: "text" | "blank";
    textContent: string | null;
    slotId: string | null;
  }>;
  slots: Array<{ slotId: string; paragraphId: string; answer: string }>;
};

export function enumerateCtwBlocks(input: CtwLexicalInput): CanonicalLexicalBlock[] {
  const slotById = new Map(input.slots.map((slot) => [slot.slotId, slot]));
  return [...input.paragraphs]
    .sort((left, right) => left.paragraphOrder - right.paragraphOrder)
    .map((paragraph) => {
      let text = "";
      const anchors: NonNullable<CanonicalLexicalBlock["anchors"]> = [];
      const segments = input.segments
        .filter((segment) => segment.paragraphId === paragraph.paragraphId)
        .sort((left, right) => left.segmentOrder - right.segmentOrder);
      if (!segments.length) throw new Error(`CTW paragraph ${paragraph.paragraphId} has no segments.`);
      for (const segment of segments) {
        if (segment.segmentType === "text") {
          if (segment.textContent === null) throw new Error(`CTW text segment in ${paragraph.paragraphId} is missing text.`);
          text += segment.textContent;
          continue;
        }
        const slot = segment.slotId ? slotById.get(segment.slotId) : null;
        if (!slot || slot.paragraphId !== paragraph.paragraphId) {
          throw new Error(`CTW blank segment in ${paragraph.paragraphId} has no matching slot.`);
        }
        const startOffset = text.length;
        text += slot.answer;
        anchors.push({
          anchorId: slot.slotId,
          anchorKind: "ctw_slot",
          startOffset,
          endOffset: text.length,
          expectedText: slot.answer
        });
      }
      return {
        sourceType: "ctw",
        sourceItemId: input.sourceItemId,
        contentBlockId: `paragraph:${paragraph.paragraphId}`,
        blockKind: "ctw_paragraph",
        text,
        anchors
      };
    });
}
