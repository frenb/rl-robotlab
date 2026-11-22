import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendUserContent, needsApproval, toModelContent, toModelTools } from '../src/agent.js';

const text = (t) => ({ type: 'text', text: t });

test('a new turn after a finished one is a new user message', () => {
  const messages = [{ role: 'user', content: [text('hi')] }, { role: 'assistant', content: [text('hello')] }];
  appendUserContent(messages, [text('again')]);
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[2], { role: 'user', content: [text('again')] });
});

test('tool calls cut off by a stop get cancelled results before the next message', () => {
  const messages = [
    { role: 'user', content: [text('pause the queue')] },
    { role: 'assistant', content: [text('ok'), { type: 'tool_use', id: 't1', name: 'set_queue_paused', input: {} }] },
  ];
  appendUserContent(messages, [text('never mind')]);
  assert.equal(messages.length, 3);
  assert.equal(messages[2].role, 'user');
  assert.deepEqual(messages[2].content.map((b) => b.type), ['tool_result', 'text']);
  assert.equal(messages[2].content[0].tool_use_id, 't1');
  assert.equal(messages[2].content[0].is_error, true);
});

test('a turn stopped before any reply joins the trailing user message', () => {
  const messages = [{ role: 'user', content: [text('first')] }];
  appendUserContent(messages, [text('second')]);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].content, [text('first'), text('second')]);
});

test('MCP tools become model tools, with the last one cached', () => {
  const tools = toModelTools([
    { name: 'a', title: 'A', description: 'does a', inputSchema: { $schema: 'x', type: 'object', properties: { n: { type: 'number' } } } },
    { name: 'b', description: 'does b' },
  ]);
  assert.deepEqual(tools[0], { name: 'a', description: 'A: does a', input_schema: { type: 'object', properties: { n: { type: 'number' } } } });
  assert.deepEqual(tools[1].input_schema, { type: 'object', properties: {} });
  assert.deepEqual(tools[1].cache_control, { type: 'ephemeral' });
  assert.equal(tools[0].cache_control, undefined);
});

test('only read-only tools skip approval', () => {
  assert.equal(needsApproval({ annotations: { readOnlyHint: true } }), false);
  assert.equal(needsApproval({ annotations: { readOnlyHint: false } }), true);
  assert.equal(needsApproval({}), true);
  assert.equal(needsApproval(undefined), true);
});

test('tool images reach the model as base64 image blocks, in order with their captions', () => {
  const out = toModelContent([text('summary'), text('frame 1'), { type: 'image', mimeType: 'image/jpeg', data: 'AAAA' }]);
  assert.deepEqual(out, [
    text('summary'),
    text('frame 1'),
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
  ]);
});
