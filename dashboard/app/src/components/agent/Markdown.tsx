import { useRouter } from '@tanstack/react-router';
import { createContext, useContext, type MouseEvent, type ReactNode } from 'react';

const Navigate = createContext<(href: string) => void>(() => {});

/** In-app links navigate without reloading the page (and the chat with it). */
function Link({ href, children }: { href: string; children: ReactNode }) {
  const navigate = useContext(Navigate);
  const external = !href.startsWith('/');
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!href.startsWith('/app') || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(href);
  };
  return (
    <a
      href={href}
      onClick={onClick}
      {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
      className="font-medium text-primary underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*\*)/g;

function inline(text: string, key = ''): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const k = `${key}${i++}`;
    const [tok] = m;
    if (m[1]) {
      out.push(<code key={k} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{tok.slice(1, -1)}</code>);
    } else if (m[2]) {
      out.push(<strong key={k} className="font-semibold">{inline(tok.slice(2, -2), k)}</strong>);
    } else if (m[4]) {
      out.push(<em key={k}>{inline(tok.slice(1, -1), k)}</em>);
    } else {
      const [, label, href] = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      out.push(<Link key={k} href={href}>{inline(label, k)}</Link>);
    }
    last = m.index! + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/** The subset of Markdown the assistant writes: paragraphs, headings, lists, code, tables, links. */
export function Markdown({ text }: { text: string }) {
  const router = useRouter();
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const k = `b${i}`;
    if (line.startsWith('```')) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
      i++;
      blocks.push(
        <pre key={k} className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs leading-relaxed">{body.join('\n')}</pre>,
      );
    } else if (/^#{1,4}\s/.test(line)) {
      blocks.push(<p key={k} className="pt-1 font-semibold">{inline(line.replace(/^#+\s/, ''), k)}</p>);
      i++;
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*]|\d+\.)\s/, '');
        for (i++; i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s/.test(lines[i]); i++) item += ` ${lines[i].trim()}`;
        items.push(item);
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={k} className={ordered ? 'list-decimal space-y-1 pl-5' : 'list-disc space-y-1 pl-5'}>
          {items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}-`)}</li>)}
        </List>,
      );
    } else if (line.trim().startsWith('|') && /^\s*\|?\s*:?-+/.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i++) rows.push(cells(lines[i]));
      blocks.push(
        <div key={k} className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                {head.map((h, j) => <th key={j} className="px-2 py-1 font-medium">{inline(h, `${k}h${j}`)}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, j) => (
                <tr key={j} className="border-b last:border-0">
                  {r.map((c, n) => <td key={n} className="px-2 py-1 tabular-nums">{inline(c, `${k}${j}-${n}`)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (!line.trim()) {
      i++;
    } else {
      const para: string[] = [];
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s|\s*\|)/.test(lines[i])) para.push(lines[i++]);
      if (!para.length) para.push(lines[i++]);
      blocks.push(<p key={k}>{inline(para.join(' '), k)}</p>);
    }
  }
  return (
    <Navigate.Provider value={(href) => router.history.push(href)}>
      <div className="space-y-2 break-words text-sm leading-relaxed">{blocks}</div>
    </Navigate.Provider>
  );
}
