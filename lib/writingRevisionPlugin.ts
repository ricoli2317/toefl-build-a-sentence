import { Extension } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { closeHistory, isHistoryTransaction } from '@tiptap/pm/history';
import { createLedger, ledgerParts, offsetAt, RevisionLedgerStep, trackTransaction, transactionDiagnostics, type Ledger, type TrackedPart } from './writingRevisionLedger.ts';
import { exportDocument, textPosition } from './writingRevisionDocument.ts';
import { WRITING_CORRECTION_CHANGE_STYLE, WRITING_CORRECTION_DELETION_STYLE } from './writingCorrectionDisplay.ts';

const revisionStyles = { added: WRITING_CORRECTION_CHANGE_STYLE, deleted: WRITING_CORRECTION_DELETION_STYLE };
export type Timing = { kind: string; ms: number; detail?: Record<string, unknown> };

type State = { ledger: Ledger; visible: boolean; parts: TrackedPart[]; decorations: DecorationSet };
export const transactionRevisionKey = new PluginKey<State>('transactionRevisionLedger');

/** Looks up the LIVE ID and mapped position at command time; repeated calls are no-ops. */
export function restoreDeletion(view: EditorView, id: string) {
  if (view.editable === false) return false;
  const state = transactionRevisionKey.getState(view.state)!;
  const record = state.ledger.deletions.find(d => d.id === id);
  if (!record) return false;
  const position = textPosition(state.ledger.text, offsetAt(state.ledger.text, record.position));
  const nodes = record.text.split('\n').map(line => view.state.schema.nodes.paragraph.create(null, line ? view.state.schema.text(line) : null));
  const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, position))
    .replaceSelection(new Slice(Fragment.fromArray(nodes), 1, 1)).setMeta('pocRestoreDeletion', id).scrollIntoView();
  view.dispatch(closeHistory(tr));
  view.dispatch(closeHistory(view.state.tr));
  view.focus(); return true;
}

export function transactionRevisionExtension(original: string, timings: Timing[], initialLedger?: Ledger, options: { popoverClassName?: string } = {}) {
  let menu: HTMLDivElement | null = null;
  let closeMenu = () => {};
  let composingStart: Ledger | null = null;
  let composing = false;
  function openMenu(view: EditorView, id: string, anchor: HTMLElement) {
    closeMenu();
    if (!view.editable) return;
    if (!transactionRevisionKey.getState(view.state)?.ledger.deletions.some(d => d.id === id)) return;
    const element = document.createElement('div'); menu = element;
    element.className = `revision-restore-popover ${options.popoverClassName ?? ''}`; element.setAttribute('role', 'dialog');
    element.setAttribute('aria-label', '删除内容操作'); element.dataset.deletionId = id;
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '恢复此处删除内容';
    button.onmousedown = event => event.preventDefault();
    button.onclick = () => { restoreDeletion(view, id); closeMenu(); };
    element.append(button); document.body.append(element);
    const box = anchor.getBoundingClientRect(), width = element.getBoundingClientRect().width;
    element.style.left = `${Math.max(8, Math.min(box.left, innerWidth - width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(box.bottom + 6, innerHeight - element.offsetHeight - 8))}px`;
    const outside = (event: Event) => {
      if (!element.contains(event.target as Node) && !anchor.contains(event.target as Node)) closeMenu();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') closeMenu(); };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape);
    closeMenu = () => { element.remove(); menu = null; document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape); closeMenu = () => {}; };
  }
  function render(ledger: Ledger, visible: boolean, doc: EditorView['state']['doc']): State {
    const parts = ledgerParts(ledger), decorations: Decoration[] = [];
    if (visible) for (const part of parts) {
      if (part.kind === 'deleted') decorations.push(Decoration.widget(textPosition(ledger.text, part.currentFrom), view => {
        const span = document.createElement('span'); span.textContent = part.text; span.className = 'revision-deleted';
        span.contentEditable = 'false'; span.dataset.deleted = 'true'; span.dataset.deletionId = part.id!;
        span.setAttribute('aria-label', `Deleted: ${part.text}`); Object.assign(span.style, revisionStyles.deleted);
        const open = (event: Event) => { event.preventDefault(); event.stopPropagation(); openMenu(view, part.id!, span); };
        span.addEventListener('pointerdown', open);
        span.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
        span.addEventListener('click', open);
        return span;
      }, { key: part.id, side: -1, ignoreSelection: true, stopEvent: () => true }));
      else if (part.kind === 'added') {
        let at = part.currentFrom;
        for (const line of part.text.split('\n')) {
          if (line) decorations.push(Decoration.inline(textPosition(ledger.text, at), textPosition(ledger.text, at + line.length), {
            class: 'revision-added', style: `background-color:${revisionStyles.added.backgroundColor};color:${revisionStyles.added.color}`,
          }));
          at += line.length + 1;
        }
      }
    }
    return { ledger, visible, parts, decorations: DecorationSet.create(doc, decorations) };
  }
  return Extension.create({
    name: 'transactionRevisionLedger',
    dispatchTransaction({ transaction, next }) {
      const start = performance.now(); next(transaction);
      if (transaction.steps.some(step => !(step instanceof RevisionLedgerStep))) timings.push({ kind: 'document-dispatch+DOM', ms: performance.now() - start });
    },
    addProseMirrorPlugins() {
      return [new Plugin<State>({
        key: transactionRevisionKey,
        state: {
          init: (_, state) => render(initialLedger ?? createLedger(original, exportDocument(state.doc)), true, state.doc),
          apply(tr, previous) {
            const visibility = tr.getMeta(transactionRevisionKey) as { visible?: boolean; refresh?: boolean } | undefined;
            const visible = visibility?.visible ?? previous.visible;
            const snapshot = tr.steps.filter((step): step is RevisionLedgerStep => step instanceof RevisionLedgerStep).at(-1);
            const started = performance.now();
            const callsBefore = transactionDiagnostics.exactDiffCalls;
            const ledger = snapshot ? snapshot.after : tr.docChanged ? trackTransaction(previous.ledger, tr) : previous.ledger;
            if (ledger === previous.ledger && visible === previous.visible && !visibility?.refresh) return previous;
            const mappedMs = performance.now() - started, decorationStart = performance.now();
            // Keep provenance/history current, but let the native composition
            // DOM finish before introducing new decorations into its text node.
            const result = composing && tr.docChanged ? {
              ledger, visible, parts: ledgerParts(ledger), decorations: previous.decorations.map(tr.mapping, tr.doc),
            } : render(ledger, visible, tr.doc);
            if (!snapshot) timings.push({ kind: 'transaction-revision', ms: performance.now() - started,
              detail: { reason: tr.docChanged ? 'document' : visibility?.refresh ? 'composition-refresh' : 'toggle', currentLength: ledger.text.length, coreCalls: transactionDiagnostics.exactDiffCalls - callsBefore, mappedMs,
                decorationsMs: performance.now() - decorationStart, deletions: ledger.deletions.length, steps: tr.steps.length } });
            return result;
          },
        },
        appendTransaction(transactions, oldState, state) {
          if (transactions.some(tr => isHistoryTransaction(tr) || tr.steps.some(step => step instanceof RevisionLedgerStep))) return null;
          const before = transactionRevisionKey.getState(oldState)!.ledger, after = transactionRevisionKey.getState(state)!.ledger;
          if (before === after) return null;
          return state.tr.step(new RevisionLedgerStep(before, after));
        },
        props: {
          decorations: state => transactionRevisionKey.getState(state)?.decorations,
          handleKeyDown(view, event) {
            if (!view.editable) return false;
            if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || event.metaKey || event.ctrlKey || event.altKey || view.composing) return false;
            const state = transactionRevisionKey.getState(view.state)!;
            const selection = view.state.selection;
            if (!selection.empty && !event.shiftKey) return false;
            const at = offsetAt(state.ledger.text, selection.head);
            const text = state.ledger.text;
            const left = event.key === 'ArrowLeft';
            const width = left ? (at > 1 && /[\uDC00-\uDFFF]/.test(text[at - 1]) && /[\uD800-\uDBFF]/.test(text[at - 2]) ? 2 : 1)
              : ((text.codePointAt(at) ?? 0) > 0xffff ? 2 : 1);
            const next = Math.max(0, Math.min(text.length, at + (left ? -width : width)));
            const position = textPosition(text, next);
            if (!state.ledger.deletions.some(d => d.position === selection.head || d.position === position)) return false;
            event.preventDefault(); closeMenu();
            // Visit effective characters once; never visit the two DOM sides of
            // one zero-width historical widget as if they were extra text.
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, event.shiftKey ? selection.anchor : position, position)).setMeta('addToHistory', false).scrollIntoView());
            return true;
          },
          handleDOMEvents: {
            compositionstart(view) { composing = true; composingStart = transactionRevisionKey.getState(view.state)!.ledger; return false; },
            compositionend(view, event) {
              const before = composingStart; composingStart = null;
              composing = false;
              const cancelled = (event as CompositionEvent).data === '';
              requestAnimationFrame(() => {
                if (view.isDestroyed || !before) return;
                const after = transactionRevisionKey.getState(view.state)!.ledger;
                if (cancelled && after.text === before.text && JSON.stringify(after.sources) !== JSON.stringify(before.sources)) {
                  view.dispatch(view.state.tr.step(new RevisionLedgerStep(after, before)));
                } else {
                  view.dispatch(view.state.tr.setMeta(transactionRevisionKey, { refresh: true }).setMeta('addToHistory', false));
                }
              });
              return false; // Native composition is never blocked or English-filtered.
            },
          },
        },
        view() { return { update(view, previous) { if (menu && (!view.editable || previous.doc !== view.state.doc || !transactionRevisionKey.getState(view.state)?.visible || !transactionRevisionKey.getState(view.state)?.ledger.deletions.some(d => d.id === menu!.dataset.deletionId))) closeMenu(); }, destroy() { closeMenu(); } }; },
      })];
    },
  });
}
