import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Archive, ArchiveRestore, Save } from 'lucide-react';
import { useState } from 'react';
import { api, keys, type DemoRow, type DesignUsage } from '../../lib/api';
import { shortId, timeAgo } from '../../lib/utils';
import { confirmDialog, toast } from '../feedback';
import { Badge, Button, Card, Field, Input, Spinner, Textarea } from '../ui';
import { Banner, EditorHeader, UsagePanel, useUnsavedGuard } from './DesignBits';
import { CAR } from './GymEditor';

interface Draft { num_demos: string; course: string; description: string; tfrecords_path: string }

const draftOf = (d: DemoRow | undefined): Draft => ({
  num_demos: d?.num_demos != null ? String(d.num_demos) : '',
  course: d?.course ?? '',
  description: d?.description ?? '',
  tfrecords_path: d?.tfrecords_path ?? '',
});

export function DemoEditor({ id }: { id: string | null }) {
  const { data, isLoading, error } = useQuery({ queryKey: keys.design('demos', id ?? ''), queryFn: () => api.design('demos', id!), enabled: !!id });
  if (id && isLoading) return <div className="grid place-items-center py-24"><Spinner /></div>;
  if (id && error) return <Banner tone="amber">{(error as Error).message}</Banner>;
  return <Editor key={`${id ?? 'new'}:${data?.item.updated_at ?? ''}`} id={id} item={data?.item} usage={data?.usage} />;
}

function Editor({ id, item, usage }: { id: string | null; item: DemoRow | undefined; usage: DesignUsage | undefined }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [baseline, setBaseline] = useState<Draft>(() => draftOf(item));
  const [draft, setDraft] = useState<Draft>(() => draftOf(item));
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const { leave } = useUnsavedGuard(dirty);
  const { data: options } = useQuery({ queryKey: keys.launchOptions(CAR), queryFn: () => api.launchOptions(CAR) });
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const save = async () => {
    const n = Number(draft.num_demos);
    if (draft.num_demos.trim() === '' || !Number.isInteger(n) || n < 0) { toast('error', 'The number of demos must be a whole number, 0 or more.'); return; }
    if (!draft.tfrecords_path.trim()) { toast('error', 'The TFRecords path is required.'); return; }
    const doc = { num_demos: n, course: draft.course.trim(), description: draft.description.trim(), tfrecords_path: draft.tfrecords_path.trim() };
    setSaving(true);
    try {
      if (id) {
        await api.updateDemo(id, doc);
        setBaseline(draft);
        toast('success', 'Demos saved.');
      } else {
        const newId = await api.addDemo(doc);
        setBaseline(draft);
        toast('success', 'Demos registered.');
        leave();
        navigate({ to: '/design/$tab/$itemId', params: { tab: 'demos', itemId: newId }, search: {}, replace: true });
      }
      qc.invalidateQueries({ queryKey: keys.designKind('demos') });
      qc.invalidateQueries({ queryKey: keys.launchOptions(CAR) });
    } catch (e) {
      toast('error', `Not saved: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const setArchived = async (next: boolean) => {
    if (!id) return;
    if (next && !(await confirmDialog({ title: 'Archive these demos?', message: 'They\u2019re hidden from the launch form. The files on disk are kept.', confirmLabel: 'Archive' }))) return;
    try {
      await api.setDemoArchived(id, next);
      toast('success', next ? 'Archived.' : 'Restored.');
      qc.invalidateQueries({ queryKey: keys.designKind('demos') });
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <EditorHeader
        title={item?.label ?? 'Register demos'}
        meta={<>
          {item?.source_job_id
            ? <span>collected by run <Link to="/runs/$runId" params={{ runId: item.source_job_id }} className="font-mono hover:underline">{shortId(item.source_job_id)}</Link></span>
            : item ? <span>registered by hand</span> : null}
          {item?.collected_at && <span>{timeAgo(item.collected_at)}</span>}
          {item?.archived && <Badge>archived</Badge>}
          {dirty && <Badge tone="amber">unsaved</Badge>}
        </>}
        actions={<>
          {id && (item?.archived
            ? <Button size="sm" variant="ghost" onClick={() => setArchived(false)}><ArchiveRestore className="h-3.5 w-3.5" /> Restore</Button>
            : <Button size="sm" variant="ghost" onClick={() => setArchived(true)}><Archive className="h-3.5 w-3.5" /> Archive</Button>)}
          <Button size="sm" variant="primary" disabled={saving || (!dirty && !!id)} onClick={save}>
            {saving ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} {id ? 'Save' : 'Register'}
          </Button>
        </>}
      />

      {!id && <Banner>For a TFRecords directory that didn&apos;t come from a DEMO run; DEMO runs register their demos when collection finishes.</Banner>}

      <Card className="grid gap-4 p-4 sm:grid-cols-2">
        <Field label="Number of demos" hint={item?.num_steps != null ? `${item.num_steps.toLocaleString()} steps counted on disk when registered.` : 'Episodes in the directory.'}>
          <Input type="number" min={0} step={1} value={draft.num_demos} onChange={(e) => set({ num_demos: e.target.value })} />
        </Field>
        <Field label="Course">
          <Input value={draft.course} onChange={(e) => set({ course: e.target.value })} list="demo-courses" placeholder="e.g. donut" />
          <datalist id="demo-courses">{(options?.courses ?? []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</datalist>
        </Field>
        <Field label="TFRecords path" className="sm:col-span-2">
          <Input value={draft.tfrecords_path} onChange={(e) => set({ tfrecords_path: e.target.value })} placeholder="/tfrecords/job_<id>" className="font-mono text-xs" />
        </Field>
        <Field label="Description" className="sm:col-span-2">
          <Textarea value={draft.description} onChange={(e) => set({ description: e.target.value })} rows={3} />
        </Field>
        {item?.gym_name && <p className="text-xs text-muted-foreground sm:col-span-2">Collected on gym <b>{item.gym_name}</b>.</p>}
      </Card>

      {id && usage && <UsagePanel kind="demos" id={id} usage={usage} />}
    </div>
  );
}
