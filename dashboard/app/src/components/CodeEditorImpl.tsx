import { indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';
import type { CodeEditorProps } from './CodeEditor';

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--card)', color: 'var(--foreground)', fontSize: '12.5px', height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-gutters': { backgroundColor: 'var(--muted)', color: 'var(--muted-foreground)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--cm-active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--cm-active-line)' },
  '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--cm-selection) !important' },
  '.cm-matchingBracket': { backgroundColor: 'var(--cm-selection)', outline: 'none' },
  '.cm-placeholder': { color: 'var(--muted-foreground)' },
});

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword], color: 'var(--cm-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--cm-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--cm-number)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--muted-foreground)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.definition(tags.variableName))], color: 'var(--cm-function)' },
  { tag: [tags.className, tags.typeName], color: 'var(--cm-type)' },
  { tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3], color: 'var(--cm-keyword)', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--cm-function)', textDecoration: 'underline' },
  { tag: tags.list, color: 'var(--cm-number)' },
  { tag: tags.monospace, color: 'var(--cm-string)' },
]);

function language(lang: CodeEditorProps['language']): Extension {
  if (lang === 'python') return [python(), indentUnit.of('    ')];
  if (lang === 'markdown') return [markdown(), EditorView.lineWrapping];
  return [];
}

export default function CodeEditorImpl({
  value, onChange, language: lang = 'text', readOnly = false, placeholder, editorRef, className,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          theme,
          syntaxHighlighting(highlight),
          language(lang),
          placeholder ? placeholderExt(placeholder) : [],
          editable.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    if (editorRef) {
      editorRef.current = {
        insertLine: (text, anchor) => {
          const head = v.state.selection.main.head;
          const doc = v.state.doc.toString();
          const m = head === 0 && anchor ? anchor.exec(doc) : null;
          const line = v.state.doc.lineAt(m ? m.index + m[0].length : head);
          const at = line.to;
          v.dispatch({ changes: { from: at, insert: '\n' + text }, selection: { anchor: at + 1 + text.length } });
          v.focus();
        },
      };
    }
    return () => {
      v.destroy();
      view.current = null;
      if (editorRef) editorRef.current = null;
    };
    // Recreated only when the language changes; value and readOnly sync below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    });
  }, [readOnly]);

  return <div ref={host} className={className} />;
}
