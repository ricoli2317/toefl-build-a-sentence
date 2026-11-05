import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { textPosition } from "./writingRevisionDocument.ts";
import type { CorrectionLocation } from "./writingCorrectionLocation.ts";

export const correctionHighlightKey = new PluginKey<DecorationSet>("correctionIssueHighlight");
export const correctionHighlightExtension = Extension.create({
  name: "correctionIssueHighlight",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: correctionHighlightKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, previous) {
          const meta = tr.getMeta(correctionHighlightKey) as { location: CorrectionLocation | null; text: string; visible?: boolean } | undefined;
          if (!meta) return previous.map(tr.mapping, tr.doc);
          const decorations = (meta.location?.ranges ?? []).map(range => Decoration.inline(
            textPosition(meta.text, range.from), textPosition(meta.text, range.to),
            { class: "correction-location-highlight", "data-correction-highlight": "true" }
          ));
          // Hidden/all-deleted text gets a zero-width marker at its real ledger anchor,
          // not a selection of neighbouring unrelated words.
          if (!meta.visible && !meta.location?.ranges.length) for (const deletion of meta.location?.deletions ?? []) decorations.push(Decoration.widget(textPosition(meta.text, deletion.position), () => {
            const marker = document.createElement("span");
            marker.dataset.correctionHighlight = "true";
            marker.className = "correction-location-highlight inline-block h-5 w-1 align-middle";
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
