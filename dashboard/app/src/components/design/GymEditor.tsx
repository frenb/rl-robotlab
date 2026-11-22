import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Archive, ArchiveRestore, Save } from 'lucide-react';
import { useState } from 'react';
import { api, keys, type DesignUsage, type GymRow } from '../../lib/api';
import { confirmDialog, toast } from '../feedback';
import { RobotBadge } from '../RunBits';
import { Badge, Button, Card, CardHeader, Field, Input, Select, Spinner } from '../ui';
import { Banner, EditorHeader, UsagePanel, useUnsavedGuard } from './DesignBits';

export const CAR = 'roboracer';

interface Draft {
  name: string;
  file_path: string;
  description: string;
  default_course_type: string;
  default_reward_design_id: string;
  default_experiment_design_id: string;
  default_init_checkpoint: string;
}
const DEFAULT_KEYS = ['default_course_type', 'default_reward_design_id', 'default_experiment_design_id', 'default_init_checkpoint'] as const;

function draftOf(g: GymRow | undefined): Draft {
  return {
    name: g?.name ?? '',
    file_path: g?.file_path ?? '',
    description: g?.description ?? '',
    default_course_type: g?.default_course_type ?? '',
    default_reward_design_id: g?.default_reward_design_id ?? '',
    default_experiment_design_id: g?.default_experiment_design_id ?? '',
    default_init_checkpoint: g?.default_init_checkpoint ?? '',
  };
}

export function GymEditor({ id, robot }: { id: string | null; robot: string }) {
  const { data, isLoading, error } = useQuery({ queryKey: keys.design('gyms', id ?? ''), queryFn: () => api.design('gyms', id!), enabled: !!id });
  if (id && isLoading) return <div className="grid place-items-center py-24"><Spinner /></div>;
  if (id && error) return <Banner tone="amber">{(error as Error).message}</Banner>;
  if (!id && robot !== CAR) {
    return <Banner>Only car gyms are added by hand (a Unity build on this host). Other robots&apos; gyms are their worker&apos;s registered tasks.</Banner>;
  }
  const item = data?.item;
  return <Editor key={`${id ?? 'new'}:${item?.updated_at ?? ''}`} id={id} robot={item?.robot ?? CAR} item={item} usage={data?.usage} />;
}

function Editor({ id, robot, item, usage }: { id: string | null; robot: string; item: GymRow | undefined; usage: DesignUsage | undefined }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [baseline, setBaseline] = useState<Draft>(() => draftOf(item));
  const [draft, setDraft] = useState<Draft>(() => draftOf(item));
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const { leave } = useUnsavedGuard(dirty);
  const managed = !!item?.managed_by || !!item?.task_id;
  const { data: options } = useQuery({ queryKey: keys.launchOptions(robot), queryFn: () => api.launchOptions(robot) });
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const save = async () => {
    if (!managed && !draft.name.trim()) { toast('error', 'Give the gym a name.'); return; }
    if (!managed && !draft.file_path.trim()) { toast('error', 'The binary path is required.'); return; }
    setSaving(true);
    try {
      if (id) {
        const patch: Record<string, unknown> = { description: draft.description.trim() };
        if (!managed) Object.assign(patch, { name: draft.name.trim(), file_path: draft.file_path.trim() });
        for (const k of DEFAULT_KEYS) if (draft[k] !== baseline[k]) patch[k] = draft[k];
        await api.updateGym(id, patch);
        setBaseline(draft);
        toast('success', 'Gym saved.');
      } else {
        const newId = await api.addGym({ name: draft.name.trim(), file_path: draft.file_path.trim(), description: draft.description.trim() });
        const defaults = Object.fromEntries(DEFAULT_KEYS.filter((k) => draft[k]).map((k) => [k, draft[k]]));
        if (Object.keys(defaults).length) await api.updateGym(newId, defaults);
        setBaseline(draft);
        toast('success', 'Gym added.');
        leave();
        navigate({ to: '/design/$tab/$itemId', params: { tab: 'gyms', itemId: newId }, search: {}, replace: true });
      }
      qc.invalidateQueries({ queryKey: keys.designKind('gyms') });
      qc.invalidateQueries({ queryKey: keys.launchOptions(robot) });
    } catch (e) {
      toast('error', `Not saved: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const setArchived = async (next: boolean) => {
    if (!id) return;
    if (next && !(await confirmDialog({ title: 'Archive this gym?', message: 'It\u2019s hidden from the launch form and curricula pickers. Its runs are kept.', confirmLabel: 'Archive' }))) return;
    try {
      await (next ? api.archiveGym(id) : api.updateGym(id, { archived: false }));
      toast('success', next ? 'Archived.' : 'Restored.');
      qc.invalidateQueries({ queryKey: keys.designKind('gyms') });
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  const facts: [string, string | number | null | undefined][] = item ? [
    ['Task', item.task_id], ['Engine', item.engine], ['Skill', item.skill], ['Terrain', item.terrain],
    ['Episode', item.episode_s != null ? `${item.episode_s} s` : null], ['Registered by', item.managed_by],
  ] : [];

  return (
    <div className="flex flex-col gap-4">
      <EditorHeader
        title={draft.name || item?.task_id || (id ? '(unnamed)' : 'New gym')}
        meta={<>
          <RobotBadge robot={robot} />
          {managed && <Badge tone="violet">registered task</Badge>}
          {item?.archived && <Badge>archived</Badge>}
          {dirty && <Badge tone="amber">unsaved</Badge>}
        </>}
        actions={<>
          {id && (item?.archived
            ? <Button size="sm" variant="ghost" onClick={() => setArchived(false)}><ArchiveRestore className="h-3.5 w-3.5" /> Restore</Button>
            : <Button size="sm" variant="ghost" onClick={() => setArchived(true)}><Archive className="h-3.5 w-3.5" /> Archive</Button>)}
          <Button size="sm" variant="primary" disabled={saving || (!dirty && !!id)} onClick={save}>
            {saving ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} {id ? 'Save' : 'Add gym'}
          </Button>
        </>}
      />

      {managed && <Banner>Its name and task come from the robot&apos;s worker, which re-registers it at startup. The description and launch defaults are yours to edit.</Banner>}

      <Card className="grid gap-4 p-4 sm:grid-cols-2">
        <Field label="Name" hint={managed ? undefined : 'Shown in the launch form and curricula.'}>
          <Input value={draft.name} disabled={managed} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Donut 0.429 chicane" />
        </Field>
        {!managed && (
          <Field label="Binary path" hint="The Unity .exe on the Windows host; the supervisor switches to it when a run starts.">
            <Input value={draft.file_path} onChange={(e) => set({ file_path: e.target.value })} placeholder="C:\path\to\Game.exe" className="font-mono text-xs" />
          </Field>
        )}
        <Field label="Description" className="sm:col-span-2">
          <Input value={draft.description} onChange={(e) => set({ description: e.target.value })} placeholder="(optional)" />
        </Field>
      </Card>

      {facts.some(([, v]) => v != null && v !== '') && (
        <Card className="grid grid-cols-2 gap-x-6 gap-y-2 p-4 text-sm sm:grid-cols-3">
          {facts.filter(([, v]) => v != null && v !== '').map(([k, v]) => (
            <div key={k} className="min-w-0"><p className="text-xs text-muted-foreground">{k}</p><p className="truncate font-mono text-xs">{v}</p></div>
          ))}
        </Card>
      )}

      <Card>
        <CardHeader title="Launch defaults" description="Prefilled in the launch form, curricula and the MCP console when this gym is picked. Leave one empty for the robot's default." />
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <Field label="Reward design">
            <Select value={draft.default_reward_design_id} onChange={(e) => set({ default_reward_design_id: e.target.value })}>
              <option value="">Robot default</option>
              {withCurrent(options?.reward_designs, draft.default_reward_design_id).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          </Field>
          <Field label="Experiment design">
            <Select value={draft.default_experiment_design_id} onChange={(e) => set({ default_experiment_design_id: e.target.value })}>
              <option value="">Robot default</option>
              {withCurrent(options?.experiment_designs, draft.default_experiment_design_id).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          </Field>
          {robot === CAR && (
            <Field label="Course">
              <Select value={draft.default_course_type} onChange={(e) => set({ default_course_type: e.target.value })}>
                <option value="">Robot default</option>
                {(options?.courses ?? []).concat(
                  draft.default_course_type && !options?.courses.some((c) => c.value === draft.default_course_type)
                    ? [{ value: draft.default_course_type, label: draft.default_course_type }] : [],
                ).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </Select>
            </Field>
          )}
          <Field label="Start from checkpoint" hint="A model id or checkpoint path new runs on this gym start from.">
            <Input value={draft.default_init_checkpoint} onChange={(e) => set({ default_init_checkpoint: e.target.value })} placeholder="none" className="font-mono text-xs" />
          </Field>
        </div>
      </Card>

      {!!item?.reward_defaults?.length && (
        <Card>
          <CardHeader title="Default reward terms" description="What the task rewards before a reward design edits it." />
          <table className="m-4 mt-3 w-[calc(100%-2rem)] text-sm">
            <tbody>
              {item.reward_defaults.map((t) => (
                <tr key={t.name} className="border-t" title={t.params ? JSON.stringify(t.params) : undefined}>
                  <td className="py-1.5 font-mono text-xs">{t.name}</td>
                  <td className="py-1.5 font-mono text-xs text-muted-foreground">{t.func}</td>
                  <td className={`py-1.5 text-right font-mono text-xs tabular-nums ${t.weight < 0 ? 'text-rose-600 dark:text-rose-400' : ''}`}>{t.weight}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {id && usage && <UsagePanel kind="gyms" id={id} usage={usage} />}
    </div>
  );
}

/** Keeps a saved default selectable even when it's archived or another robot's. */
function withCurrent<T extends { id: string; name: string }>(list: T[] | undefined, current: string): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = list ?? [];
  return current && !out.some((o) => o.id === current) ? [...out, { id: current, name: `${current} (not listed)` }] : out;
}
