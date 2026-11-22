// Lets the model look at training clips: frames pulled from a run's MP4s and
// GIFs (or any media URL / local file) with ffmpeg, returned as images.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { BASE_URL, get, list } from '../api.js';
import { contentResult, defineTool, resolveRow, robotOf } from '../util.js';

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const MAX_IMAGES = 24;
const MAX_BYTES = 200 * 1024 * 1024;

/** `count` items spread evenly over `items`, always including the first and last. */
export function spreadPick(items, count) {
  if (count >= items.length) return items.slice();
  if (count <= 1) return [items[items.length - 1]];
  const out = [];
  for (let i = 0; i < count; i++) out.push(items[Math.round((i * (items.length - 1)) / (count - 1))]);
  return [...new Set(out)];
}

/** Timestamps at the middle of `n` equal slices of a clip `duration` seconds long. */
export function frameTimes(duration, n) {
  if (!(duration > 0)) return [0];
  return Array.from({ length: n }, (_, i) => Number((((i + 0.5) * duration) / n).toFixed(3)));
}

async function fetchToFile(src, dir) {
  if (!/^https?:|^\//.test(src)) {
    await fs.access(src);
    return src;
  }
  const url = src.startsWith('/') ? BASE_URL + src : src;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`couldn't download ${src} (HTTP ${res.status})`);
  const size = Number(res.headers.get('content-length') || 0);
  if (size > MAX_BYTES) throw new Error(`${src} is ${Math.round(size / 1e6)} MB; the limit is ${MAX_BYTES / 1e6} MB`);
  const ext = (decodeURIComponent(src).match(/\.(mp4|gif|webm|mov|mkv|avi)\b/i)?.[1] || 'bin').toLowerCase();
  const file = path.join(dir, `media-${Math.random().toString(36).slice(2)}.${ext}`);
  await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

async function probe(file) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'format=duration:stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,duration',
    '-of', 'json', file,
  ], { windowsHide: true });
  const j = JSON.parse(stdout);
  const s = j.streams?.[0] || {};
  const rate = (r) => {
    const [a, b] = String(r || '').split('/').map(Number);
    return a && b ? a / b : null;
  };
  const fps = rate(s.avg_frame_rate) || rate(s.r_frame_rate);
  const duration = Number(j.format?.duration || s.duration) || (s.nb_frames && fps ? Number(s.nb_frames) / fps : 0);
  return { width: s.width ?? null, height: s.height ?? null, fps: fps ? Number(fps.toFixed(2)) : null, duration: Number(duration.toFixed(3)) };
}

async function frameAt(file, t, { width, zoom }, out) {
  const crop = zoom > 1 ? `crop=iw/${zoom}:ih/${zoom},` : '';
  // Seeking after -i decodes from the start, which also works for GIFs; the clips are short.
  await run(FFMPEG, [
    '-v', 'error', '-y', '-i', file, '-ss', String(t), '-frames:v', '1',
    '-vf', `${crop}scale=${width}:-2:flags=lanczos`, '-q:v', '4', out,
  ], { windowsHide: true });
  return (await fs.readFile(out)).toString('base64');
}

/** Frames of one clip as MCP content: a caption per frame, then the image. */
async function reviewOne({ src, label }, frames, look, dir) {
  const file = await fetchToFile(src, dir);
  const info = await probe(file);
  const times = frameTimes(info.duration, frames);
  const blocks = [];
  for (const [i, t] of times.entries()) {
    try {
      const data = await frameAt(file, t, look, path.join(dir, `f-${Math.random().toString(36).slice(2)}.jpg`));
      blocks.push({ type: 'text', text: `${label} · frame ${i + 1}/${times.length} at ${t.toFixed(2)}s` });
      blocks.push({ type: 'image', data, mimeType: 'image/jpeg' });
    } catch (e) {
      blocks.push({ type: 'text', text: `${label} · frame at ${t.toFixed(2)}s failed: ${e.message.split('\n')[0]}` });
    }
  }
  return { info: { clip: label, ...info, frames: times.length }, blocks };
}

export function register(server) {
  defineTool(server, 'review_media', {
    title: 'Review training videos and GIFs',
    description: 'Look at what a policy actually does: pulls evenly spaced frames from a run\'s progress clips (MP4 or GIF, '
      + 'recorded every few hundred iterations) or from any media URL or local video/GIF file, and returns them as images '
      + 'with timestamps, plus each clip\'s duration, frame rate and size. With job: the latest clip by default; '
      + '`iterations` picks specific clips, `spread` picks that many clips across training to see how behaviour changed. '
      + 'Describe what you see (posture, falls, contact, whether the task is attempted) and say which frame shows it.',
    readOnly: true,
    input: {
      job: z.string().optional().describe('Job id or suffix whose clips to review.'),
      iterations: z.array(z.number().int()).max(4).optional().describe('Clip iterations to review (nearest clip is used). Default: the latest.'),
      spread: z.number().int().min(2).max(4).optional().describe('Review this many clips spread from the first to the latest.'),
      format: z.enum(['mp4', 'gif']).optional().describe('Which copy of each clip to read. Default mp4 (smaller); gif when there is no mp4.'),
      url: z.string().optional().describe('Instead of job: a dashboard media URL (/media?path=...), an http(s) URL, or a local file path.'),
      frames: z.number().int().min(1).max(12).optional().describe('Frames per clip. Default 6.'),
      width: z.number().int().min(160).max(1024).optional().describe('Frame width in pixels. Default 480.'),
      zoom: z.number().min(1).max(4).optional().describe('Crop to the centre 1/zoom of the frame before scaling, '
        + 'for a small robot in a wide shot. Default 1 (whole frame).'),
    },
  }, async ({ job, iterations, spread, format = 'mp4', url, frames = 6, width = 480, zoom = 1 }) => {
    if (!job && !url) throw new Error('give a job or a url');
    let targets;
    let header;
    if (url) {
      targets = [{ src: url, label: path.basename(decodeURIComponent(url).split('?path=').pop()) }];
      header = { source: url };
    } else {
      const row = resolveRow(await list('/get_jobs'), job, 'job');
      const media = await get(`/api/v1/runs/${row._id}/media`);
      const clips = (media.clips || [])
        .map((c) => ({ iteration: c.iteration, src: (format === 'gif' ? c.gif_url : c.url) || c.url || c.gif_url }))
        .filter((c) => c.src)
        .sort((a, b) => (a.iteration ?? 0) - (b.iteration ?? 0));
      if (!clips.length) {
        const progress = format === 'gif' ? (media.progress_gif || media.progress_video) : (media.progress_video || media.progress_gif);
        if (!progress) throw new Error(`job ${row._id} has no clips or progress video yet`);
        clips.push({ iteration: null, src: progress });
      }
      let picked;
      if (iterations?.length) {
        picked = [...new Set(iterations.map((it) => clips.reduce((best, c) => (
          Math.abs((c.iteration ?? 0) - it) < Math.abs((best.iteration ?? 0) - it) ? c : best))))];
      } else if (spread) {
        picked = spreadPick(clips, spread);
      } else {
        picked = [clips[clips.length - 1]];
      }
      targets = picked.map((c) => ({ src: c.src, label: c.iteration != null ? `iteration ${c.iteration}` : 'progress video' }));
      const its = clips.map((c) => c.iteration).filter((x) => x != null);
      header = {
        job: String(row._id), robot: robotOf(row), name: row.name || null, status: row.status,
        clips_available: clips.length,
        clip_iterations: its.length > 8 ? `${its[0]}..${its[its.length - 1]} (${its.length} clips)` : its,
      };
    }

    const perClip = Math.max(1, Math.min(frames, Math.floor(MAX_IMAGES / targets.length)));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-media-'));
    try {
      const results = [];
      for (const t of targets) results.push(await reviewOne(t, perClip, { width, zoom }, dir));
      const summary = { ...header, reviewed: results.map((r) => r.info) };
      return contentResult([{ type: 'text', text: JSON.stringify(summary, null, 2) }, ...results.flatMap((r) => r.blocks)]);
    } catch (e) {
      if (e.code === 'ENOENT' && /ff(mpeg|probe)/.test(String(e.path || e.message))) {
        throw new Error('ffmpeg/ffprobe not found on PATH; install ffmpeg or set FFMPEG_PATH and FFPROBE_PATH');
      }
      throw e;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}
