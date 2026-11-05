"use client";

import { useEffect, useRef, useState } from "react";
import { Editor, Extension, Node } from "@tiptap/core";
import { baseKeymap, splitBlock } from "@tiptap/pm/commands";
import { keymap } from "@tiptap/pm/keymap";
import { history, undo, redo, undoDepth, redoDepth } from "@tiptap/pm/history";
import { Fragment, Slice } from "@tiptap/pm/model";
import { ClipboardPaste, Scissors, Undo2, Redo2 } from "lucide-react";
import { transactionRevisionExtension, transactionRevisionKey } from "@/lib/writingRevisionPlugin";
import { exportDocument, textDocument } from "@/lib/writingRevisionDocument";
import { countEnglishWords } from "@/lib/writing";
import { parseWritingRevisionState, type WritingRevisionState } from "@/lib/writingRevisionState";
import styles from "./WritingRevisionEditor.module.css";
import { RevisionVisibilitySwitch } from "./RevisionVisibilitySwitch";
import { correctionHighlightExtension, correctionHighlightKey } from "@/lib/writingCorrectionHighlight";
import type { CorrectionLocation } from "@/lib/writingCorrectionLocation";
import { scrollTargetWithinContainer } from "@/lib/writingReviewScroll";

export type RevisionEditorHandle = { snapshot: () => WritingRevisionState };

/** Both student and teacher mount this view and the SAME ledger plugin. Host
 * typography is supplied by className; only the student gets editing controls.
 * Remounts are reserved for explicit confirmed draft reloads, never visibility. */
export function WritingRevisionEditor({ initialState, onChange, onReady, readOnly = false, disabled = false,
  className = "px-4 py-3 text-[15px] leading-[1.45]", teacher = false, heading, location, workspace = false, legend }: {
  initialState: WritingRevisionState;
  onChange?: (state: WritingRevisionState) => void;
  onReady?: (handle: RevisionEditorHandle | null) => void;
  readOnly?: boolean; disabled?: boolean; className?: string; teacher?: boolean; heading?: React.ReactNode;
  location?: CorrectionLocation | null;
  workspace?: boolean; legend?: React.ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const callbacks = useRef({ onChange, onReady }); callbacks.current = { onChange, onReady };
  const initial = useRef(initialState);
  const locked = useRef(readOnly || disabled); locked.current = readOnly || disabled;
  const [visible, setVisible] = useState(true);
  const [current, setCurrent] = useState(initialState);
  const [depth, setDepth] = useState({ undo: 0, redo: 0 });
  const [clipboard, setClipboard] = useState("");
  const refocus = useRef(false);

  useEffect(() => {
    const seed = parseWritingRevisionState(initial.current, initial.current.ledger.original, initial.current.ledger.text);
    let lastLedger = seed.ledger;
    const insert = (view: Editor["view"], text: string) => {
      const nodes = text.split('\n').map(line => view.state.schema.nodes.paragraph.create(null, line ? view.state.schema.text(line) : null));
      view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.fromArray(nodes), 1, 1)).scrollIntoView());
    };
    // Exact paragraph schema, history, Slice paste and multiline guard from PoC.
    const editor = new Editor({
      element: host.current!, editable: !locked.current,
      extensions: [
        Node.create({ name: 'doc', topNode: true, content: 'paragraph+' }),
        Node.create({ name: 'paragraph', group: 'block', content: 'text*', whitespace: 'pre', parseHTML: () => [{ tag: 'p' }], renderHTML: () => ['p', 0] }),
        Node.create({ name: 'text', group: 'inline' }),
        Extension.create({ name: 'correctionPlainTextHistory', addProseMirrorPlugins: () => [history(), keymap({ 'Mod-z': undo, 'Mod-Shift-z': redo, 'Mod-y': redo, Enter: splitBlock }), keymap(baseKeymap)] }),
        transactionRevisionExtension(seed.ledger.original, [], seed.ledger, { popoverClassName: styles.popover }),
        correctionHighlightExtension,
      ],
      content: textDocument(seed.ledger.text), enableInputRules: false, enablePasteRules: false,
      editorProps: {
        attributes: { role: 'textbox', 'aria-label': teacher ? '订正修订正文（只读）' : 'Writing response', 'aria-multiline': 'true', spellcheck: 'false', lang: 'en', inputmode: 'text', autocapitalize: 'sentences' },
        handleDOMEvents: {
          beforeinput(view, event) {
            const input = event as InputEvent;
            // Existing TPS correction policy: external paste/drop is forbidden.
            if (locked.current || input.inputType === 'insertFromPaste' || input.inputType === 'insertFromDrop') { event.preventDefault(); return true; }
            if (!input.cancelable || input.inputType !== 'insertText' || !input.data?.includes('\n') || input.isComposing || view.composing) return false;
            event.preventDefault(); insert(view, input.data); return true;
          },
          paste(_view, event) { event.preventDefault(); return true; },
          drop(_view, event) { event.preventDefault(); return true; },
          cut(view, event) {
            event.preventDefault(); if (locked.current) return true;
            const text = exportDocument(view.state.selection.content().content);
            if (text) { setClipboard(text); (event as ClipboardEvent).clipboardData?.setData('text/plain', text); view.dispatch(view.state.tr.deleteSelection().scrollIntoView()); }
            return true;
          },
        },
        clipboardTextSerializer: slice => exportDocument(slice.content),
      },
      onTransaction: ({ editor: active }) => {
        const ledger = transactionRevisionKey.getState(active.state)!.ledger;
        const state = { schema_version: 1 as const, ledger };
        if (ledger !== lastLedger) { lastLedger = ledger; setCurrent(state); callbacks.current.onChange?.(state); }
        const nextDepth = { undo: undoDepth(active.state), redo: redoDepth(active.state) };
        setDepth(previous => previous.undo === nextDepth.undo && previous.redo === nextDepth.redo ? previous : nextDepth);
      },
    });
    editorRef.current = editor;
    callbacks.current.onReady?.({ snapshot: () => ({ schema_version: 1, ledger: transactionRevisionKey.getState(editor.state)!.ledger }) });
    return () => { callbacks.current.onReady?.(null); editorRef.current = null; editor.destroy(); };
  }, [teacher]);

  useEffect(() => {
    editorRef.current?.setEditable(!(readOnly || disabled));
    editorRef.current?.view.dom.setAttribute('aria-readonly', String(readOnly || disabled));
  }, [readOnly, disabled]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !teacher) return;
    editor.view.dispatch(editor.state.tr.setMeta(correctionHighlightKey, { location: location ?? null, text: initial.current.ledger.text, visible }).setMeta('addToHistory', false));
    host.current?.querySelectorAll('.revision-deleted').forEach(element => {
      const id = (element as HTMLElement).dataset.deletionId;
      const record = initial.current.ledger.deletions.find(item => item.id === id);
      if (!record) return;
      const ranges = location?.deletions.find(item => item.id === id)?.ranges ?? [];
      const fragment = document.createDocumentFragment();
      let at = 0;
      for (const range of ranges) {
        fragment.append(document.createTextNode(record.text.slice(at, range.from)));
        const mark = document.createElement('span');
        mark.className = 'correction-location-highlight'; mark.dataset.correctionHighlight = 'true';
        mark.textContent = record.text.slice(range.from, range.to); fragment.append(mark); at = range.to;
      }
      fragment.append(document.createTextNode(record.text.slice(at)));
      element.replaceChildren(fragment);
    });
    const target = host.current?.querySelector<HTMLElement>('[data-correction-highlight]') ?? null;
    const container = host.current?.closest<HTMLElement>('.overflow-y-auto') ?? null;
    scrollTargetWithinContainer(container, target, Math.round((container?.clientHeight ?? 0) * 0.25));
  }, [location, visible, teacher]);

  function toggle(value: boolean) {
    const editor = editorRef.current; if (!editor) return;
    const top = scroll.current?.scrollTop ?? 0;
    editor.view.dispatch(editor.state.tr.setMeta(transactionRevisionKey, { visible: value }).setMeta('addToHistory', false));
    if (scroll.current) scroll.current.scrollTop = Math.min(top, scroll.current.scrollHeight - scroll.current.clientHeight);
    setVisible(value); if (refocus.current) editor.view.focus(); refocus.current = false;
  }
  function command(action: 'cut' | 'paste' | 'undo' | 'redo') {
    const editor = editorRef.current; if (!editor || locked.current) return;
    if (action === 'undo' || action === 'redo') (action === 'undo' ? undo : redo)(editor.state, editor.view.dispatch);
    if (action === 'cut') {
      const text = exportDocument(editor.state.selection.content().content);
      if (text) { setClipboard(text); editor.view.dispatch(editor.state.tr.deleteSelection().scrollIntoView()); }
    }
    if (action === 'paste' && clipboard) {
      const nodes = clipboard.split('\n').map(line => editor.schema.nodes.paragraph.create(null, line ? editor.schema.text(line) : null));
      editor.view.dispatch(editor.state.tr.replaceSelection(new Slice(Fragment.fromArray(nodes), 1, 1)).scrollIntoView());
    }
    editor.view.focus();
  }
  const visibilitySwitch = <RevisionVisibilitySwitch compact checked={visible} className={!teacher ? styles.toolbarSwitch : undefined} onPointerDown={() => { refocus.current = editorRef.current?.view.hasFocus() ?? false; }} onChange={toggle} />;
  return <div className={`${styles.root} ${teacher ? workspace ? 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden' : 'min-w-0' : 'flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-student-primary-border bg-white focus-within:border-student-primary focus-within:shadow-[0_0_0_3px_rgba(107,92,246,0.1)]'}`} data-revision-view={teacher ? 'teacher' : 'student'}>
    {!teacher ? <div data-revision-toolbar className="flex h-10 min-h-10 shrink-0 flex-nowrap items-center border-b border-student-primary-border bg-student-primary-soft/45 px-2 text-student-primary">
      {!readOnly ? <>
      {([{ name: 'Cut', action: 'cut', icon: Scissors, disabled: !current.ledger.text }, { name: 'Paste', action: 'paste', icon: ClipboardPaste, disabled: !clipboard }, { name: 'Undo', action: 'undo', icon: Undo2, disabled: !depth.undo }, { name: 'Redo', action: 'redo', icon: Redo2, disabled: !depth.redo }] as const).map(({ name, action, icon: Icon, disabled: unavailable }) => <button aria-label={name} className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-semibold hover:bg-white disabled:pointer-events-none disabled:opacity-35" disabled={disabled || unavailable} key={action} onMouseDown={event => event.preventDefault()} onClick={() => command(action)} type="button"><Icon size={16} /><span className="hidden sm:inline">{name}</span></button>)}
      </> : null}
      <span className="ml-auto inline-flex items-center">{visibilitySwitch}</span>
      {!readOnly ? <span className="whitespace-nowrap px-2 text-[13px] font-semibold">Word Count <span className="tabular-nums text-student-text">{countEnglishWords(current.ledger.text)}</span></span> : null}
    </div> : null}
    {teacher ? <div data-revision-header className={`flex shrink-0 items-center justify-between gap-2 border-b border-student-border ${workspace ? "px-3 py-2.5" : "px-4 py-2"}`}>
      {heading}
      <div className="flex items-center gap-3">{visible ? legend : null}{visibilitySwitch}</div>
    </div> : null}
    <div data-revision-scroll className={workspace ? 'min-h-0 flex-1 overflow-y-auto p-5' : `${teacher ? '' : 'min-h-0 flex-1 overflow-y-auto'} ${className}`} ref={scroll}>
      {workspace ? <div className={`mx-auto max-w-[860px] ${className}`}><div className={styles.host} ref={host} /></div> : <div className={styles.host} ref={host} />}
    </div>
  </div>;
}
