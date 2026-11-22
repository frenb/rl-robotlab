import { lazy, Suspense } from 'react';
import { cn } from '../lib/utils';
import { Spinner } from './ui';

export interface EditorApi {
  /** Inserts text on a new line after the cursor's line, or after `anchor`'s match if the cursor never moved. */
  insertLine: (text: string, anchor?: RegExp) => void;
}

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language?: 'python' | 'markdown' | 'text';
  readOnly?: boolean;
  placeholder?: string;
  editorRef?: { current: EditorApi | null };
  className?: string;
}

// CodeMirror is a few hundred kB; only pages with an editor load it.
const Impl = lazy(() => import('./CodeEditorImpl'));

export function CodeEditor(props: CodeEditorProps) {
  const className = cn('overflow-hidden rounded-lg border [&_.cm-editor]:max-h-[inherit] [&_.cm-scroller]:max-h-[inherit]', props.className);
  return (
    <Suspense fallback={<div className={cn(className, 'grid min-h-40 place-items-center')}><Spinner /></div>}>
      <Impl {...props} className={className} />
    </Suspense>
  );
}
