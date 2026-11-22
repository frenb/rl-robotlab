// Reads scalar summaries out of TensorBoard event files without TensorBoard.
//
// An event file is a sequence of TFRecords:
//   uint64 length | uint32 masked crc(length) | data[length] | uint32 masked crc(data)
// where data is an `Event` protobuf. We decode only what scalars need:
//   Event   { double wall_time = 1; int64 step = 2; Summary summary = 5; }
//   Summary { repeated Value value = 1; }
//   Value   { string tag = 1; float simple_value = 2; TensorProto tensor = 8; }
// torch's SummaryWriter (rsl_rl) writes simple_value; TF2's tf.summary.scalar
// (the car trainer) writes a rank-0 tensor.
import * as fs from 'fs';

export interface ScalarPoint {
  tag: string;
  step: number;
  wall: number;
  value: number;
}

const TWO_32 = 4294967296;

class Reader {
  pos: number;
  constructor(public buf: Buffer, start: number, public end: number) {
    this.pos = start;
  }

  varint(): number {
    let result = 0;
    let mul = 1;
    let b: number;
    do {
      if (this.pos >= this.end) throw new Error('truncated varint');
      b = this.buf[this.pos++];
      result += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return result;
  }

  span(): [number, number] {
    const len = this.varint();
    const start = this.pos;
    this.pos += len;
    if (this.pos > this.end) throw new Error('truncated field');
    return [start, this.pos];
  }

  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.span();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
}

// TensorProto dtypes we turn into numbers.
const DT_FLOAT = 1;
const DT_DOUBLE = 2;
const DT_INT32 = 3;
const DT_INT64 = 9;

function tensorScalar(buf: Buffer, start: number, end: number): number | null {
  const r = new Reader(buf, start, end);
  let dtype = 0;
  const values: number[] = [];
  let content: [number, number] | null = null;
  while (r.pos < r.end) {
    const key = r.varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (field === 1 && wire === 0) dtype = r.varint();
    else if (field === 4 && wire === 2) content = r.span();
    else if (field === 5 && wire === 2) {
      const [s, e] = r.span();
      for (let p = s; p + 4 <= e; p += 4) values.push(buf.readFloatLE(p));
    } else if (field === 5 && wire === 5) {
      values.push(buf.readFloatLE(r.pos));
      r.pos += 4;
    } else if (field === 6 && wire === 2) {
      const [s, e] = r.span();
      for (let p = s; p + 8 <= e; p += 8) values.push(buf.readDoubleLE(p));
    } else if (field === 6 && wire === 1) {
      values.push(buf.readDoubleLE(r.pos));
      r.pos += 8;
    } else if ((field === 7 || field === 10) && wire === 2) {
      const [s, e] = r.span();
      const inner = new Reader(buf, s, e);
      while (inner.pos < inner.end) values.push(inner.varint());
    } else if ((field === 7 || field === 10) && wire === 0) {
      values.push(r.varint());
    } else r.skip(wire);
  }
  if (content) {
    const [s, e] = content;
    const n = e - s;
    if (dtype === DT_FLOAT && n === 4) return buf.readFloatLE(s);
    if (dtype === DT_DOUBLE && n === 8) return buf.readDoubleLE(s);
    if (dtype === DT_INT32 && n === 4) return buf.readInt32LE(s);
    if (dtype === DT_INT64 && n === 8) return buf.readUInt32LE(s) + buf.readInt32LE(s + 4) * TWO_32;
    return null;
  }
  if (values.length !== 1) return null;
  if (dtype !== DT_FLOAT && dtype !== DT_DOUBLE && dtype !== DT_INT32 && dtype !== DT_INT64) return null;
  return values[0];
}

function summaryValue(buf: Buffer, start: number, end: number): { tag: string; value: number } | null {
  const r = new Reader(buf, start, end);
  let tag = '';
  let value: number | null = null;
  while (r.pos < r.end) {
    const key = r.varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (field === 1 && wire === 2) {
      const [s, e] = r.span();
      tag = buf.toString('utf8', s, e);
    } else if (field === 2 && wire === 5) {
      value = buf.readFloatLE(r.pos);
      r.pos += 4;
    } else if (field === 8 && wire === 2) {
      const [s, e] = r.span();
      const v = tensorScalar(buf, s, e);
      if (v !== null) value = v;
    } else r.skip(wire);
  }
  return tag && value !== null ? { tag, value } : null;
}

export function decodeEvent(buf: Buffer, start: number, end: number, out: ScalarPoint[]): void {
  const r = new Reader(buf, start, end);
  let wall = 0;
  let step = 0;
  const summaries: Array<[number, number]> = [];
  while (r.pos < r.end) {
    const key = r.varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (field === 1 && wire === 1) {
      wall = buf.readDoubleLE(r.pos);
      r.pos += 8;
    } else if (field === 2 && wire === 0) step = r.varint();
    else if (field === 5 && wire === 2) summaries.push(r.span());
    else r.skip(wire);
  }
  for (const [s, e] of summaries) {
    const sr = new Reader(buf, s, e);
    while (sr.pos < sr.end) {
      const key = sr.varint();
      if (Math.floor(key / 8) === 1 && (key & 7) === 2) {
        const [vs, ve] = sr.span();
        const v = summaryValue(buf, vs, ve);
        if (v && isFinite(v.value)) out.push({ tag: v.tag, step, wall, value: v.value });
      } else sr.skip(key & 7);
    }
  }
}

/** Decodes every complete record in buf; returns how many bytes that consumed. */
export function decodeRecords(buf: Buffer, out: ScalarPoint[]): number {
  let pos = 0;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32LE(pos) + buf.readUInt32LE(pos + 4) * TWO_32;
    const total = 12 + len + 4;
    if (pos + total > buf.length) break;
    try {
      decodeEvent(buf, pos + 12, pos + 12 + len, out);
    } catch (e) {
      // A corrupt record loses its own points only.
    }
    pos += total;
  }
  return pos;
}

const CHUNK = 8 * 1024 * 1024;

/** Follows one event file as it grows, returning only points not seen before. */
export class EventFileTail {
  offset = 0;

  constructor(public path: string) {}

  /** New points since the last call; `reset` means the file was replaced and earlier points are void. */
  async readNew(): Promise<{ points: ScalarPoint[]; reset: boolean }> {
    const points: ScalarPoint[] = [];
    let reset = false;
    const size = (await fs.promises.stat(this.path)).size;
    if (size < this.offset) {
      this.offset = 0;
      reset = true;
    }
    if (size === this.offset) return { points, reset };
    const fh = await fs.promises.open(this.path, 'r');
    try {
      let chunk = CHUNK;
      while (this.offset < size) {
        const want = Math.min(chunk, size - this.offset);
        const buf = Buffer.alloc(want);
        const { bytesRead } = await fh.read(buf, 0, want, this.offset);
        const consumed = decodeRecords(buf.subarray(0, bytesRead), points);
        if (consumed === 0) {
          // A record larger than the chunk, or a half-written last record.
          if (want < size - this.offset) {
            chunk *= 2;
            continue;
          }
          break;
        }
        this.offset += consumed;
      }
    } finally {
      await fh.close();
    }
    return { points, reset };
  }
}
