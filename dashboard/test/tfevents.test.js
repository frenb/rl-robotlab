// node --test, against the compiled build/ (npm test builds first).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventFileTail } = require('../build/api/tfevents');
const { downsample } = require('../build/api/metrics');

function varint(n) {
  const out = [];
  while (n >= 128) {
    out.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}
const key = (field, wire) => varint(field * 8 + wire);
const bytesField = (field, buf) => Buffer.concat([key(field, 2), varint(buf.length), buf]);
function floatField(field, v) {
  const b = Buffer.alloc(4);
  b.writeFloatLE(v);
  return Buffer.concat([key(field, 5), b]);
}
function doubleField(field, v) {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(v);
  return Buffer.concat([key(field, 1), b]);
}

/** torch SummaryWriter style: Value.simple_value. */
function simpleValue(tag, v) {
  return Buffer.concat([bytesField(1, Buffer.from(tag)), floatField(2, v)]);
}

/** TF2 tf.summary.scalar style: Value.tensor, a rank-0 DT_FLOAT in tensor_content. */
function tensorValue(tag, v) {
  const content = Buffer.alloc(4);
  content.writeFloatLE(v);
  const tensor = Buffer.concat([key(1, 0), varint(1), bytesField(2, Buffer.alloc(0)), bytesField(4, content)]);
  return Buffer.concat([bytesField(1, Buffer.from(tag)), bytesField(8, tensor)]);
}

/** A histogram-like tensor: many values, must be skipped. */
function vectorValue(tag) {
  const content = Buffer.alloc(12);
  const tensor = Buffer.concat([key(1, 0), varint(1), bytesField(4, content)]);
  return Buffer.concat([bytesField(1, Buffer.from(tag)), bytesField(8, tensor)]);
}

function event(step, wall, values) {
  const summary = Buffer.concat(values.map((v) => bytesField(1, v)));
  return Buffer.concat([doubleField(1, wall), key(2, 0), varint(step), bytesField(5, summary)]);
}

function record(data) {
  const head = Buffer.alloc(12);
  head.writeUInt32LE(data.length, 0);
  head.writeUInt32LE(0, 4);
  return Buffer.concat([head, data, Buffer.alloc(4)]);
}

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfevents-'));
  return path.join(dir, 'events.out.tfevents.1');
}

test('reads simple_value and rank-0 tensor scalars, skips non-scalars', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, Buffer.concat([
    record(Buffer.concat([doubleField(1, 1), bytesField(3, Buffer.from('brain.Event:2'))])),
    record(event(1, 10, [simpleValue('Train/mean_reward', 1.5), vectorValue('hist')])),
    record(event(300000, 11, [tensorValue('Metrics/AverageReturn', -2.25)])),
  ]));
  const { points } = await new EventFileTail(file).readNew();
  assert.deepStrictEqual(points, [
    { tag: 'Train/mean_reward', step: 1, wall: 10, value: 1.5 },
    { tag: 'Metrics/AverageReturn', step: 300000, wall: 11, value: -2.25 },
  ]);
});

test('follows a growing file and waits out a half-written record', async () => {
  const file = tmpFile();
  const first = record(event(1, 1, [simpleValue('a', 1)]));
  const second = record(event(2, 2, [simpleValue('a', 2)]));
  fs.writeFileSync(file, Buffer.concat([first, second.subarray(0, 10)]));
  const tail = new EventFileTail(file);
  assert.deepStrictEqual((await tail.readNew()).points.map((p) => p.step), [1]);
  fs.appendFileSync(file, second.subarray(10));
  assert.deepStrictEqual((await tail.readNew()).points.map((p) => p.step), [2]);
  assert.deepStrictEqual((await tail.readNew()).points, []);
});

test('a replaced, shorter file resets the tail', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, Buffer.concat([1, 2, 3].map((s) => record(event(s, s, [simpleValue('a', s)])))));
  const tail = new EventFileTail(file);
  await tail.readNew();
  fs.writeFileSync(file, record(event(9, 9, [simpleValue('a', 9)])));
  const { points, reset } = await tail.readNew();
  assert.strictEqual(reset, true);
  assert.deepStrictEqual(points.map((p) => p.step), [9]);
});

test('downsample keeps the bucket range and the last step', () => {
  const steps = [1, 2, 3, 4, 5, 6];
  const out = downsample(steps, [1, 5, 2, 2, 0, 4], 3);
  assert.deepStrictEqual(out.steps, [2, 4, 6]);
  assert.deepStrictEqual(out.values, [3, 2, 2]);
  assert.deepStrictEqual(out.min, [1, 2, 0]);
  assert.deepStrictEqual(out.max, [5, 2, 4]);
  assert.deepStrictEqual(downsample([1], [7], 3), { steps: [1], values: [7] });
});
