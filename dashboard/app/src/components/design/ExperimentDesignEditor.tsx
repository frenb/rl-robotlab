import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Archive, ArchiveRestore, ChevronRight, Copy, RotateCcw, Save, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, ApiError, keys, type DesignUsage, type ExperimentDesignRow, type ExperimentField } from '../../lib/api';
import { cn } from '../../lib/utils';
import { confirmDialog, toast } from '../feedback';
import { RobotBadge } from '../RunBits';
import { Badge, Button, Card, Field, Input, Select, Spinner, Textarea } from '../ui';
import { Banner, EditorHeader, UsagePanel, useUnsavedGuard } from './DesignBits';

/** Raw form text per field; a missing key means "use the default". */
type Raw = Record<string, string>;
interface Draft { name: string; description: string; raw: Raw }

function toRaw(fields: Record<string, unknown> | undefined, schema: ExperimentField[]): Raw {
  const out: Raw = {};
  for (const f of schema) {
    if (f.kind !== 'field') continue;
    const v = fields?.[f.name];
    if (v === undefined || v === null) continue;
    out[f.name] = f.type === 'json' ? JSON.stringify(v, null, 2) : String(v);
  }
  return out;
}

function coerce(f: ExperimentField, raw: string): unknown {
  if (f.type === 'int') { const n = Math.trunc(Number(raw)); if (!Number.isFinite(n)) throw new Error('not a number'); return n; }
  if (f.type === 'float') { const n = Number(raw); if (!Number.isFinite(n)) throw new Error('not a number'); return n; }
  if (f.type === 'bool') return raw === 'true';
  if (f.type === 'json') return JSON.parse(raw);
  return raw;
}

function stableJson(v: unknown): string {
  const sort = (x: unknown): unknown => (Array.isArray(x) ? x.map(sort)
    : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])])) : x);
  return JSON.stringify(sort(v ?? {}), null, 2);
}

const sameDraft = (a: Draft, b: Draft) => a.name === b.name && a.description === b.description && stableJson(a.raw) === stableJson(b.raw);

export function ExperimentDesignEditor({ id, robot, from }: { id: string | null; robot: string; from?: string }) {
  const sourceId = id ?? from;
  const source = useQuery({
    queryKey: keys.design('experiment_designs', sourceId ?? ''),
    queryFn: () => api.design('experiment_designs', sourceId!),
    enabled: !!sourceId,
  });
  const theRobot = source.data?.item.robot ?? robot;
  const schema = useQuery({ queryKey: keys.experimentSchema(theRobot), queryFn: () => api.experimentSchema(theRobot), staleTime: 5 * 60_000 });
  if ((sourceId && source.isLoading) || schema.isLoading) return <div className="grid place-items-center py-24"><Spinner /></div>;
  if (sourceId && source.error) return <Banner tone="amber">{(source.error as Error).message}</Banner>;
  if (schema.error) return <Banner tone="amber">Couldn&apos;t load the experiment-design schema: {(schema.error as Error).message}</Banner>;
  const fields = schema.data?.fields ?? [];
  const item = source.data?.item;
  return (
    <Editor
      key={`${id ?? 'new'}:${from ?? ''}:${item?.version ?? 0}:${theRobot}`}
      id={id}
      robot={theRobot}
      schema={fields}
      schemaSource={schema.data?.source ?? 'missing'}
      item={id ? item : undefined}
      usage={id ? source.data?.usage : undefined}
      initial={item
        ? { name: id ? item.name ?? '' : `${item.name ?? 'design'} (copy)`, description: item.description, raw: toRaw(item.fields, fields) }
        : { name: '', description: '', raw: {} }}
    />
  );
}

function Editor({ id, robot, schema, schemaSource, item, usage, initial }: {
  id: string | null;
  robot: string;
  schema: ExperimentField[];
  schemaSource: string;
  item: ExperimentDesignRow | undefined;
  usage: DesignUsage | undefined;
  initial: Draft;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [baseline, setBaseline] = useState<Draft>(initial);
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState('');
  const [onlySet, setOnlySet] = useState(false);
  const dirty = !sameDraft(draft, baseline);
  const { leave } = useUnsavedGuard(dirty);
  const readOnly = !!item?.canonical;
  const byName = useMemo(() => new Map(schema.filter((f) => f.kind === 'field').map((f) => [f.name, f])), [schema]);

  const sections = useMemo(() => {
    const out: { label: string; fields: ExperimentField[] }[] = [];
    for (const f of schema) {
      if (f.kind === 'section' || !out.length) out.push({ label: f.kind === 'section' ? f.label ?? f.name : 'Settings', fields: [] });
      if (f.kind === 'field') out[out.length - 1].fields.push(f);
    }
    return out.filter((s) => s.fields.length);
  }, [schema]);

  const jsonErrors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(draft.raw)) {
      if (byName.get(k)?.type !== 'json') continue;
      try { JSON.parse(v); } catch (e) { out[k] = `Invalid JSON: ${(e as Error).message}`; }
    }
    return out;
  }, [draft.raw, byName]);

  const setField = (name: string, value: string | undefined) => setDraft((d) => {
    const raw = { ...d.raw };
    if (value === undefined || value === '') delete raw[name];
    else raw[name] = value;
    return { ...d, raw };
  });

  const values = (raw: Raw): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      const f = byName.get(k);
      if (!f) continue;
      try { out[k] = coerce(f, v); } catch { out[k] = v; }
    }
    return out;
  };

  const save = async () => {
    const name = draft.name.trim();
    if (!name) { toast('error', 'Give the design a name first.'); return; }
    const bad = Object.keys(jsonErrors);
    if (bad.length) { toast('error', `Not saved: ${bad.join(', ')} ${bad.length === 1 ? 'isn\u2019t' : 'aren\u2019t'} valid JSON.`); return; }
    const payload: Record<string, unknown> = { name, description: draft.description };
    for (const [k, v] of Object.entries(draft.raw)) {
      const f = byName.get(k);
      if (!f) continue;
      try { payload[k] = coerce(f, v); } catch { toast('error', `Not saved: ${k} isn\u2019t a number.`); return; }
    }
    // An omitted key would keep its stored value; null clears it.
    if (id) for (const k of Object.keys(baseline.raw)) if (!(k in draft.raw)) payload[k] = null;
    setSaving(true);
    try {
      if (id) {
        await api.updateExperimentDesign(id, payload);
        setBaseline({ ...draft, name });
        toast('success', `Saved as v${(item?.version ?? 0) + 1}.`);
      } else {
        const newId = await api.addExperimentDesign({ ...payload, robot });
        setBaseline(draft);
        toast('success', 'Experiment design created.');
        leave();
        navigate({ to: '/design/$tab/$itemId', params: { tab: 'experiments', itemId: newId }, search: {}, replace: true });
      }
      qc.invalidateQueries({ queryKey: keys.designKind('experiment_designs') });
      qc.invalidateQueries({ queryKey: keys.launchOptions(robot) });
    } catch (e) {
      const hint = e instanceof ApiError && e.body?.hint ? ` (${e.body.hint})` : '';
      toast('error', `Not saved: ${(e as Error).message}${hint}`);
    } finally {
      setSaving(false);
    }
  };

  const setArchived = async (next: boolean) => {
    if (!id) return;
    if (next && !(await confirmDialog({ title: 'Archive this experiment design?', message: 'It\u2019s hidden from the launch form and curricula pickers. Runs and models that used it keep their copy.', confirmLabel: 'Archive' }))) return;
    try {
      await (next ? api.archiveExperimentDesign(id) : api.updateExperimentDesign(id, { archived: false }));
      toast('success', next ? 'Archived.' : 'Restored.');
      qc.invalidateQueries({ queryKey: keys.designKind('experiment_designs') });
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  const overrides = Object.keys(draft.raw).filter((k) => byName.has(k)).length;
  const needle = q.trim().toLowerCase();
  const visible = (f: ExperimentField) => (!onlySet || f.name in draft.raw)
    && (!needle || `${f.name} ${f.doc ?? ''}`.toLowerCase().includes(needle));
  const derivedFrom = item?.base_design_id;

  return (
    <div className="flex flex-col gap-4">
      <EditorHeader
        title={draft.name || (id ? '(unnamed)' : 'New experiment design')}
        meta={<>
          <RobotBadge robot={robot} />
          {item && <span>v{item.version}</span>}
          {item?.canonical && <Badge tone="blue">default</Badge>}
          {item?.archived && <Badge>archived</Badge>}
          {dirty && <Badge tone="amber">unsaved</Badge>}
          <span>{overrides ? `${overrides} override${overrides === 1 ? '' : 's'}` : 'all defaults'}</span>
          {item?.author && <span className="text-xs">by {item.author}</span>}
        </>}
        actions={<>
          {id && (
            <Link to="/design/$tab/$itemId" params={{ tab: 'experiments', itemId: 'new' }} search={{ from: id, robot }}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border bg-card px-2.5 text-xs font-medium hover:bg-muted">
              <Copy className="h-3.5 w-3.5" /> Duplicate
            </Link>
          )}
          {!readOnly && (
            <Button size="sm" variant="ghost" disabled={!overrides} onClick={() => setDraft((d) => ({ ...d, raw: {} }))} title="Clear every override (not saved until you Save)">
              <RotateCcw className="h-3.5 w-3.5" /> Reset to defaults
            </Button>
          )}
          {id && !readOnly && (item?.archived
            ? <Button size="sm" variant="ghost" onClick={() => setArchived(false)}><ArchiveRestore className="h-3.5 w-3.5" /> Restore</Button>
            : <Button size="sm" variant="ghost" onClick={() => setArchived(true)}><Archive className="h-3.5 w-3.5" /> Archive</Button>)}
          {!readOnly && (
            <Button size="sm" variant="primary" disabled={saving || (!dirty && !!id)} onClick={save}>
              {saving ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} {id ? 'Save' : 'Create'}
            </Button>
          )}
        </>}
      />

      {readOnly && <Banner>The robot&apos;s default design is read-only so runs that rely on it stay comparable. Duplicate it to change it.</Banner>}
      {schemaSource === 'missing' && <Banner tone="amber">No experiment-design schema for this robot yet: its worker publishes one when it starts.</Banner>}
      {(derivedFrom || item?.proposal_id) && (
        <Banner>
          {derivedFrom && <>Derived from <Link to="/design/$tab/$itemId" params={{ tab: 'experiments', itemId: derivedFrom }} search={{}} className="font-medium underline">its base design</Link>. </>}
          {item?.proposal_id && <>Written by the MadScientist for proposal <span className="font-mono">{item.proposal_id.slice(-8)}</span>.</>}
        </Banner>
      )}

      <Card className="grid gap-4 p-4 sm:grid-cols-[1fr_2fr]">
        <Field label="Name">
          <Input value={draft.name} disabled={readOnly} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. longer-warmup" />
        </Field>
        <Field label="Description">
          <Input value={draft.description} disabled={readOnly} maxLength={280} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="What it changes, and why" />
        </Field>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter settings…" className="w-64" />
        <label className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground">
          <input type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={onlySet} onChange={(e) => setOnlySet(e.target.checked)} />
          Only overridden
        </label>
        <span className="text-xs text-muted-foreground">Empty means the trainer&apos;s default; only overrides are stored.</span>
      </div>

      <div className="flex flex-col gap-3">
        {sections.map((s) => {
          const shown = s.fields.filter(visible);
          if (!shown.length) return null;
          const set = s.fields.filter((f) => f.name in draft.raw).length;
          const stages = s.fields.some((f) => f.name === 'curriculum_stages');
          return (
            <details key={s.label} open={!!needle || onlySet || set > 0 || sections.length <= 3} className="group rounded-xl border bg-card shadow-sm">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold">
                <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" />
                {s.label}
                {set > 0 && <Badge tone="blue">{set} set</Badge>}
              </summary>
              <div className="flex flex-col divide-y border-t">
                {stages && <p className="bg-amber-500/8 px-4 py-2 text-xs text-amber-800 dark:text-amber-200">Needs a TrackGen gym. For staged training prefer a curriculum.</p>}
                {shown.map((f) => (
                  <FieldRow
                    key={f.name}
                    field={f}
                    raw={draft.raw[f.name]}
                    error={jsonErrors[f.name]}
                    readOnly={readOnly}
                    onChange={(v) => setField(f.name, v)}
                  />
                ))}
              </div>
            </details>
          );
        })}
      </div>

      {id && usage && (
        <UsagePanel
          kind="experiment_designs"
          id={id}
          usage={usage}
          current={stableJson(values(draft.raw))}
          render={(s) => stableJson(s)}
        />
      )}
    </div>
  );
}

function FieldRow({ field: f, raw, error, readOnly, onChange }: {
  field: ExperimentField; raw: string | undefined; error?: string; readOnly: boolean; onChange: (v: string | undefined) => void;
}) {
  const set = raw !== undefined;
  const range = f.min != null && f.max != null ? `[${f.min}, ${f.max}]` : f.min != null ? `≥ ${f.min}` : f.max != null ? `≤ ${f.max}` : null;
  const defaultText = f.default === null || f.default === undefined ? 'task default' : `default: ${typeof f.default === 'object' ? JSON.stringify(f.default) : String(f.default)}`;
  let input;
  if (f.type === 'enum' || (f.type === 'bool' && f.default === null)) {
    const choices = f.type === 'enum' ? f.choices ?? [] : ['true', 'false'];
    input = (
      <Select value={raw ?? ''} disabled={readOnly} onChange={(e) => onChange(e.target.value || undefined)} className="w-48">
        <option value="">{defaultText}</option>
        {choices.map((c) => <option key={c} value={c}>{f.type === 'bool' ? (c === 'true' ? 'on' : 'off') : c}</option>)}
      </Select>
    );
  } else if (f.type === 'bool') {
    const checked = set ? raw === 'true' : !!f.default;
    input = (
      <label className="flex h-9 cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-primary" disabled={readOnly} checked={checked} onChange={(e) => onChange(String(e.target.checked))} />
        <span className="text-xs text-muted-foreground">{set ? (checked ? 'on' : 'off') : `${checked ? 'on' : 'off'} (default)`}</span>
      </label>
    );
  } else if (f.type === 'json') {
    input = (
      <Textarea
        value={raw ?? ''}
        disabled={readOnly}
        rows={set ? 6 : 2}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`JSON; leave empty for the ${defaultText}`}
        className={cn('w-full font-mono text-xs', error && 'border-rose-500')}
      />
    );
  } else {
    input = (
      <Input
        type="number"
        value={raw ?? ''}
        disabled={readOnly}
        step={f.type === 'int' ? 1 : 'any'}
        min={f.min ?? undefined}
        max={f.max ?? undefined}
        onChange={(e) => onChange(e.target.value)}
        placeholder={defaultText}
        className="w-48"
      />
    );
  }
  return (
    <div className={cn('grid gap-2 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start', set && 'bg-sky-500/5')}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <code className={cn('font-mono text-xs', set && 'font-semibold')}>{f.name}</code>
          <span className="text-[11px] text-muted-foreground">{f.type}{range ? ` ${range}` : ''}</span>
          {f.paper_ref && <a href={`https://arxiv.org/abs/${f.paper_ref}`} target="_blank" rel="noreferrer" className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground hover:underline">arxiv:{f.paper_ref}</a>}
        </div>
        {f.doc && <p className="mt-0.5 text-xs text-muted-foreground">{f.doc}</p>}
        {error && <p className="mt-0.5 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      </div>
      <div className={cn('flex items-start gap-1', f.type === 'json' && 'sm:w-[28rem]')}>
        {input}
        {!readOnly && (set ? (
          <button onClick={() => onChange(undefined)} title="Back to the default" className="grid h-9 w-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        ) : <span className="w-7 shrink-0" />)}
      </div>
    </div>
  );
}
