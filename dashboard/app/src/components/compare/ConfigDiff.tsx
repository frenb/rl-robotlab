import { useMemo, useState } from 'react';
import type { CompareRun, ConfigValue } from '../../lib/api';
import { changedLines, DiffView } from '../DiffView';
import { cn } from '../../lib/utils';
import { Button, Card, CardHeader, Empty, Select } from '../ui';
import type { Entry } from './CompareCurves';

interface Row {
  section: string;
  key: string;
  values: (ConfigValue | undefined)[];
  differs: boolean;
}

function show(v: ConfigValue | undefined): string {
  if (v === undefined || v === null || v === '') return '—';
  return String(v);
}

function rows(runs: CompareRun[]): Row[] {
  const order: { section: string; key: string }[] = [];
  const seen = new Set<string>();
  for (const r of runs) {
    for (const s of r.config) {
      for (const key of Object.keys(s.values)) {
        const id = `${s.title}\u0000${key}`;
        if (!seen.has(id)) {
          seen.add(id);
          order.push({ section: s.title, key });
        }
      }
    }
  }
  return order.map(({ section, key }) => {
    const values = runs.map((r) => r.config.find((s) => s.title === section)?.values[key]);
    const shown = new Set(values.map(show));
    return { section, key, values, differs: shown.size > 1 };
  });
}

function CodeDiff({ runs, entries }: { runs: CompareRun[]; entries: Entry[] }) {
  const withCode = runs.map((r, i) => ({ r, e: entries[i] })).filter((x) => x.r.reward_code);
  const [a, setA] = useState(withCode[0]?.r.run.id ?? '');
  const [b, setB] = useState(withCode.find((x) => x.r.reward_code !== withCode[0]?.r.reward_code)?.r.run.id ?? withCode[1]?.r.run.id ?? '');
  const codeA = runs.find((r) => r.run.id === a)?.reward_code ?? '';
  const codeB = runs.find((r) => r.run.id === b)?.reward_code ?? '';
  const changed = useMemo(() => changedLines(codeA, codeB), [codeA, codeB]);
  if (withCode.length < 2) return null;
  const pick = (value: string, onChange: (v: string) => void) => (
    <Select value={value} onChange={(ev) => onChange(ev.target.value)} className="h-8 max-w-60 text-xs">
      {withCode.map(({ r, e }) => <option key={r.run.id} value={r.run.id}>{e.label}</option>)}
    </Select>
  );
  return (
    <Card>
      <CardHeader
        title="Reward code"
        description={changed ? `${changed} changed lines` : 'Identical'}
        actions={<>{pick(a, setA)}<span className="text-xs text-muted-foreground">→</span>{pick(b, setB)}</>}
      />
      <DiffView a={codeA} b={codeB} className="m-4 max-h-[60vh]" />
    </Card>
  );
}

export function ConfigDiff({ runs, entries }: { runs: CompareRun[]; entries: Entry[] }) {
  const [onlyDiff, setOnlyDiff] = useState(true);
  const all = useMemo(() => rows(runs), [runs]);
  const differing = all.filter((r) => r.differs).length;
  const shown = onlyDiff && runs.length > 1 ? all.filter((r) => r.differs) : all;
  const sections = [...new Set(shown.map((r) => r.section))];

  if (!all.length) return <Empty title="No settings recorded for these runs" />;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {runs.length > 1 ? `${differing} of ${all.length} settings differ` : `${all.length} settings`}
        </p>
        {runs.length > 1 && (
          <Button size="sm" onClick={() => setOnlyDiff(!onlyDiff)}>
            {onlyDiff ? 'Show all settings' : 'Only differences'}
          </Button>
        )}
      </div>
      {shown.length === 0 ? (
        <Empty title="Every setting is the same">Switch to all settings to see them.</Empty>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="sticky left-0 w-48 bg-card px-4 py-2.5 font-medium">Setting</th>
                {entries.map((e) => (
                  <th key={e.run.id} className="px-4 py-2.5 font-medium">
                    <span className="flex items-center gap-1.5">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: e.color }} />
                      <span className="truncate">{e.label}</span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sections.map((section) => (
                <SectionRows key={section} section={section} rows={shown.filter((r) => r.section === section)} />
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <CodeDiff runs={runs} entries={entries} />
    </div>
  );
}

function SectionRows({ section, rows: items }: { section: string; rows: Row[] }) {
  return (
    <>
      <tr className="bg-muted/40">
        <td colSpan={items[0].values.length + 1} className="px-4 py-1.5 text-xs font-semibold text-muted-foreground">{section}</td>
      </tr>
      {items.map((r) => (
        <tr key={r.key} className="border-b last:border-0 align-top">
          <td className="sticky left-0 bg-card px-4 py-2 font-mono text-xs">{r.key}</td>
          {r.values.map((v, i) => (
            <td
              key={i}
              className={cn('max-w-72 break-words px-4 py-2 text-xs', r.differs && 'bg-amber-500/10 font-medium')}
              title={show(v)}
            >
              <span className="line-clamp-3">{show(v)}</span>
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
