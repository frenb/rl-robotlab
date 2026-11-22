import { useQueryClient } from '@tanstack/react-query';
import { Check, Clock, Pencil, X } from 'lucide-react';
import { useState } from 'react';
import { labApi, keys, type Proposal, type ProposalAction, type ProposalDoc } from '../../lib/api';
import { confirmDialog, toast } from '../feedback';
import { Button, Field, Input, Select, Textarea } from '../ui';

const DONE_TEXT: Record<ProposalAction, string> = {
  approve: 'Approved; the orchestrator queues its runs shortly.',
  approve_with_revisions: 'Approved with revisions; the orchestrator queues its runs shortly.',
  reject: 'Rejected.',
  defer: 'Deferred; it stays here until you decide.',
};

/** Approve, defer or reject a proposal that's awaiting the user, with an optional note for the record. */
export function DecisionPanel({ proposal, compact, onEdit }: { proposal: Proposal; compact?: boolean; onEdit?: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<ProposalAction | null>(null);

  const act = async (action: ProposalAction) => {
    if (action === 'reject' && !(await confirmDialog({
      title: 'Reject this proposal?',
      message: 'Rejected proposals are final; the researcher won\u2019t revisit it. Defer instead to keep it open.',
      confirmLabel: 'Reject', danger: true,
    }))) return;
    setBusy(action);
    try {
      await labApi.decide(proposal.id, action, note.trim());
      toast('success', DONE_TEXT[action]);
      setNote('');
      await qc.invalidateQueries({ queryKey: keys.lab });
    } catch (e) {
      toast('error', (e as Error).message);
      await qc.invalidateQueries({ queryKey: keys.lab });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note for the record (optional): why, or what to watch for"
        rows={compact ? 1 : 2}
        maxLength={4000}
        className="min-h-9 text-xs"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" disabled={!!busy} onClick={() => act('approve')}>
          <Check className="h-3.5 w-3.5" /> {busy === 'approve' ? 'Approving…' : 'Approve'}
        </Button>
        {proposal.status !== 'deferred' && (
          <Button size="sm" disabled={!!busy} onClick={() => act('defer')}>
            <Clock className="h-3.5 w-3.5" /> Defer
          </Button>
        )}
        <Button size="sm" disabled={!!busy} onClick={() => act('reject')} className="text-rose-700 dark:text-rose-300">
          <X className="h-3.5 w-3.5" /> Reject
        </Button>
        {onEdit && (
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" /> Edit before approving
          </Button>
        )}
      </div>
    </div>
  );
}

type Draft = Record<string, string>;

const TEXT_FIELDS: { key: string; label: string; rows: number }[] = [
  { key: 'title', label: 'Title', rows: 1 },
  { key: 'hypothesis', label: 'Hypothesis', rows: 3 },
  { key: 'motivation', label: 'Motivation', rows: 3 },
  { key: 'code_changes_summary', label: 'Code changes', rows: 2 },
  { key: 'success_criteria.primary', label: 'Success criterion (prose)', rows: 2 },
];
const P = 'success_criteria.primary_parsed.';

function draftOf(p: Proposal, doc: ProposalDoc): Draft {
  const parsed = doc.success_criteria?.primary_parsed ?? {};
  const s = (v: unknown) => (v == null ? '' : String(v));
  return {
    title: s(p.title), hypothesis: s(p.hypothesis), motivation: s(doc.motivation), code_changes_summary: s(doc.code_changes_summary),
    'success_criteria.primary': s(doc.success_criteria?.primary),
    [`${P}metric`]: s(parsed.metric), [`${P}arm_a`]: s(parsed.arm_a), [`${P}arm_b`]: s(parsed.arm_b),
    [`${P}comparator`]: s(parsed.comparator || '>='), [`${P}threshold`]: s(parsed.threshold), [`${P}threshold_kind`]: s(parsed.threshold_kind || 'relative'),
    n_seeds_per_arm: s(p.n_seeds_per_arm), num_iterations_per_seed: s(p.num_iterations_per_seed), expected_wall_time_hours: s(p.expected_wall_time_hours),
  };
}

/**
 * The fields the server lets you nudge before approving. Arms aren't
 * editable; reject and let the researcher redraft for that.
 */
export function ProposalEditForm({ proposal, doc, onClose }: { proposal: Proposal; doc: ProposalDoc; onClose: () => void }) {
  const qc = useQueryClient();
  const [initial] = useState(() => draftOf(proposal, doc));
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const changed = Object.keys(draft).filter((k) => draft[k] !== initial[k]);

  const save = async () => {
    const patch: Record<string, unknown> = {};
    for (const k of changed) {
      const v = draft[k];
      if (k === 'expected_wall_time_hours') patch[k] = v.trim() === '' ? null : Number(v);
      else if (k === 'n_seeds_per_arm' || k === 'num_iterations_per_seed' || k === `${P}threshold`) patch[k] = v.trim() === '' ? v : Number(v);
      else patch[k] = v;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await labApi.edit(proposal.id, patch);
      toast('success', r.updated_fields.length ? `Saved ${r.updated_fields.length} change${r.updated_fields.length === 1 ? '' : 's'}.` : 'Nothing changed.');
      await qc.invalidateQueries({ queryKey: keys.lab });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const arms = (doc.experiment_arms ?? []).map((a) => a.name);
  const armInput = (k: string, label: string) => (
    <Field label={label}>
      <Select value={draft[k]} onChange={(e) => set(k, e.target.value)} className="h-8 text-xs">
        {!arms.includes(draft[k]) && <option value={draft[k]}>{draft[k] || '—'}</option>}
        {arms.map((a) => <option key={a} value={a}>{a}</option>)}
      </Select>
    </Field>
  );

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4">
      {TEXT_FIELDS.map((f) => (
        <Field key={f.key} label={f.label}>
          {f.rows === 1
            ? <Input value={draft[f.key]} onChange={(e) => set(f.key, e.target.value)} className="h-8 text-sm" />
            : <Textarea value={draft[f.key]} onChange={(e) => set(f.key, e.target.value)} rows={f.rows} className="text-sm" />}
        </Field>
      ))}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
        <Field label="Metric" className="col-span-2"><Input value={draft[`${P}metric`]} onChange={(e) => set(`${P}metric`, e.target.value)} className="h-8 text-xs" /></Field>
        {armInput(`${P}arm_a`, 'Arm')}
        <Field label="Comparator">
          <Select value={draft[`${P}comparator`]} onChange={(e) => set(`${P}comparator`, e.target.value)} className="h-8 text-xs">
            {['>=', '<=', '>', '<'].map((c) => <option key={c}>{c}</option>)}
          </Select>
        </Field>
        <Field label="Threshold" hint={draft[`${P}threshold_kind`] === 'relative' ? '0.1 = 10%' : undefined}>
          <Input type="number" step="any" value={draft[`${P}threshold`]} onChange={(e) => set(`${P}threshold`, e.target.value)} className="h-8 text-xs" />
        </Field>
        <Field label="Kind">
          <Select value={draft[`${P}threshold_kind`]} onChange={(e) => set(`${P}threshold_kind`, e.target.value)} className="h-8 text-xs">
            <option value="relative">relative</option>
            <option value="absolute">absolute</option>
          </Select>
        </Field>
        {armInput(`${P}arm_b`, 'Against arm')}
        <Field label="Seeds per arm"><Input type="number" min={1} max={100} value={draft.n_seeds_per_arm} onChange={(e) => set('n_seeds_per_arm', e.target.value)} className="h-8 text-xs" /></Field>
        <Field label="Iterations per seed" className="col-span-2"><Input type="number" min={1} value={draft.num_iterations_per_seed} onChange={(e) => set('num_iterations_per_seed', e.target.value)} className="h-8 text-xs" /></Field>
        <Field label="Wall time (h)" hint="Blank = unknown"><Input type="number" min={0} step="any" value={draft.expected_wall_time_hours} onChange={(e) => set('expected_wall_time_hours', e.target.value)} className="h-8 text-xs" /></Field>
      </div>
      {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" disabled={saving || !changed.length} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</Button>
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <span className="text-xs text-muted-foreground">{changed.length ? `${changed.length} field${changed.length === 1 ? '' : 's'} changed` : 'Arms can\u2019t be edited; reject and let the researcher redraft for that.'}</span>
      </div>
    </div>
  );
}
