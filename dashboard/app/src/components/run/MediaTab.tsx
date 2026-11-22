import { useQuery } from '@tanstack/react-query';
import { api, isLive, keys, type Run } from '../../lib/api';
import { formatNumber } from '../../lib/utils';
import { Card, CardHeader, Empty, Spinner } from '../ui';

export function useRunMedia(run: Run) {
  return useQuery({
    queryKey: keys.media(run.id),
    queryFn: () => api.media(run.id),
    refetchInterval: isLive(run) ? 60_000 : false,
  });
}

export function MediaTab({ run }: { run: Run }) {
  const { data, isLoading } = useRunMedia(run);
  if (isLoading) return <div className="grid place-items-center py-16"><Spinner /></div>;
  if (!data || (!data.progress_video && !data.clips.length)) {
    return (
      <Empty title="No videos yet">
        Training runs record a clip at each saved checkpoint, and a progression video when they finish.
      </Empty>
    );
  }
  const clips = [...data.clips].reverse();
  return (
    <div className="flex flex-col gap-6">
      {data.progress_video && (
        <Card className="overflow-hidden">
          <CardHeader title="Progression" description="Clips of evenly spaced checkpoints, stitched when training finished." />
          <div className="p-4">
            <video src={data.progress_video} controls muted loop playsInline className="max-h-[60vh] w-full rounded-lg bg-black" />
          </div>
        </Card>
      )}
      {clips.length > 0 && (
        <div>
          <h3 className="mb-3 text-sm font-semibold">Checkpoint clips <span className="font-normal text-muted-foreground">· newest first</span></h3>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {clips.map((c) => (
              <Card key={c.url} className="overflow-hidden">
                <video src={c.url} controls muted playsInline preload="metadata" className="aspect-video w-full bg-black" />
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  Iteration <span className="font-medium tabular-nums text-foreground">{formatNumber(c.iteration, 0)}</span>
                </p>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Newest clip, for the overview. */
export function LatestClip({ run }: { run: Run }) {
  const { data } = useRunMedia(run);
  const clip = data?.clips[data.clips.length - 1];
  const src = data?.progress_video ?? clip?.url;
  if (!src) return <div className="grid aspect-video place-items-center rounded-lg bg-muted text-xs text-muted-foreground">No clip yet</div>;
  return (
    <div className="flex flex-col gap-1.5">
      <video key={src} src={src} controls muted loop autoPlay playsInline className="aspect-video w-full rounded-lg bg-black" />
      <p className="text-xs text-muted-foreground">
        {data?.progress_video ? 'Progression video' : `Iteration ${formatNumber(clip?.iteration, 0)}`}
      </p>
    </div>
  );
}
