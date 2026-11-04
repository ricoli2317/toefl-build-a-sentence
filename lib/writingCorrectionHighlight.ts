import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { textPosition } from "./writingRevisionDocument.ts";
import type { CorrectionLocation } from "./writingCorrectionLocation.ts";
import { WRITING_REVIEW_SELECTED_TEXT_CLASS } from "./writingReviewWorkspaceUi.ts";

export const correctionHighlightKey = new PluginKey<DecorationSet>("correctionIssueHighlight");
export const correctionHighlightExtension = Extension.create({
  name: "correctionIssueHighlight",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: correctionHighlightKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, previous) {
          const meta = tr.getMeta(correctionHighlightKey) as { location: CorrectionLocation | null; text: string } | undefined;
          if (!meta) return previous.map(tr.mapping, tr.doc);
          const decorations = (meta.location?.ranges ?? []).map(range => Decoration.inline(
            textPosition(meta.text, range.from), textPosition(meta.text, range.to),
            { class: `${WRITING_REVIEW_SELECTED_TEXT_CLASS} ring-2 ring-violet-300 rounded-sm`, "data-correction-highlight": "true" }
          ));
          // Hidden/all-deleted text gets a zero-width marker at its real ledger anchor,
          // not a selection of neighbouring unrelated words.
          for (const deletion of meta.location?.deletions ?? []) decorations.push(Decoration.widget(textPosition(meta.text, deletion.position), () => {
            const marker = document.createElement("span");
            marker.dataset.correctionHighlight = "true";
            marker.className = "inline-block h-5 border-l-2 border-violet-500 align-middle";
            marker.setAttribute("aria-label", "对应删除位置");
            return marker;
          }, { side: -1 }));
          return DecorationSet.create(tr.doc, decorations);
        }
      },
      props: { decorations: state => correctionHighlightKey.getState(state) }
    })];
  }
});
