import { useQueries } from '@tanstack/react-query';
import { Pause, Play, RotateCcw } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { api, isLive, keys, type RunMedia } from '../../lib/api';
import { formatNumber } from '../../lib/utils';
import { Button, Card, Empty, Select, Spinner } from '../ui';
import type { Entry } from './CompareCurves';

type Mode = 'clip' | 'progress';

/** The run's last clip at or before `iteration`, else its first. */
function clipAt(media: RunMedia | undefined, iteration: number) {
  const clips = media?.clips.filter((c) => c.iteration != null) ?? [];
  if (!clips.length) return null;
  let best = clips[0];
  for (const c of clips) if ((c.iteration ?? 0) <= iteration) best = c;
  return best;
}

export function CompareClips({ entries }: { entries: Entry[] }) {
  const media = useQueries({
    queries: entries.map((e) => ({
      queryKey: keys.media(e.run.id),
      queryFn: () => api.media(e.run.id),
      refetchInterval: isLive(e.run) ? 60_000 : (false as const),
    })),
  });
  const iterations = useMemo(
    () => [...new Set(media.flatMap((q) => q.data?.clips.map((c) => c.iteration ?? 0) ?? []))].sort((a, b) => a - b),
    [media],
  );
  const hasProgress = media.some((q) => q.data?.progress_video);
  const [mode, setMode] = useState<Mode>('clip');
  const [index, setIndex] = useState<number | null>(null);
  const videos = useRef<Map<string, HTMLVideoElement>>(new Map());

  if (media.some((q) => q.isLoading)) return <div className="grid place-items-center py-16"><Spinner /></div>;
  if (!iterations.length && !hasProgress) {
    return <Empty title="None of these runs has recorded video">Training runs record a clip at each saved checkpoint when video is on.</Empty>;
  }

  const i = Math.min(index ?? iterations.length - 1, iterations.length - 1);
  const iteration = iterations[i] ?? 0;
  const all = () => [...videos.current.values()];
  const restart = () => all().forEach((v) => { v.currentTime = 0; void v.play(); });

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-wrap items-center gap-x-5 gap-y-3 p-3">
        <Select value={mode} onChange={(e) => setMode(e.target.value as Mode)} className="h-8 text-xs">
          <option value="clip">Checkpoint clips</option>
          <option value="progress" disabled={!hasProgress}>Progression videos</option>
        </Select>
        {mode === 'clip' && iterations.length > 1 && (
          <label className="flex min-w-60 flex-1 items-center gap-3 text-xs text-muted-foreground">
            Iteration
            <input
              type="range" min={0} max={iterations.length - 1} step={1} value={i}
              onChange={(e) => setIndex(Number(e.target.value))}
              className="flex-1 accent-[var(--primary)]"
            />
            <span className="w-16 tabular-nums text-foreground">{formatNumber(iteration, 0)}</span>
          </label>
        )}
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={restart}><RotateCcw className="h-3.5 w-3.5" /> Restart all</Button>
          <Button size="sm" onClick={() => all().forEach((v) => void v.play())}><Play className="h-3.5 w-3.5" /> Play</Button>
          <Button size="sm" onClick={() => all().forEach((v) => v.pause())}><Pause className="h-3.5 w-3.5" /> Pause</Button>
        </div>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {entries.map((e, k) => {
          const m = media[k].data;
          const clip = mode === 'clip' ? clipAt(m, iteration) : null;
          const src = mode === 'clip' ? clip?.url : m?.progress_video ?? undefined;
          return (
            <Card key={e.run.id} className="overflow-hidden">
              {src ? (
                <video
                  key={src}
                  ref={(el) => { if (el) videos.current.set(e.run.id, el); else videos.current.delete(e.run.id); }}
                  src={src} muted loop playsInline autoPlay controls
                  className="aspect-video w-full bg-black"
                />
              ) : (
                <div className="grid aspect-video place-items-center bg-muted text-xs text-muted-foreground">No video</div>
              )}
              <div className="flex items-center gap-1.5 px-3 py-2 text-xs">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: e.color }} />
                <span className="truncate font-medium">{e.label}</span>
                {clip && clip.iteration !== iteration && (
                  <span className="ml-auto shrink-0 text-muted-foreground">iteration {formatNumber(clip.iteration, 0)}</span>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
