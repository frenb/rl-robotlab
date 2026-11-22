const API_URL = 'https://api.anthropic.com/v1/messages';
const RETRYABLE = new Set([408, 429, 500, 502, 503, 529]);

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(t);
    reject(signal.reason ?? new Error('aborted'));
  }, { once: true });
});

/** Server-sent events from a fetch body, as `{ event, data }`. */
async function* sse(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let event = 'message';
      const data = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) yield { event, data: JSON.parse(data.join('\n')) };
    }
  }
}

/**
 * One streamed Anthropic Messages call. Text deltas go to `onText` as they
 * arrive; resolves with the finished assistant `content`, `stop_reason` and `usage`.
 */
export async function streamMessage({ apiKey, model, maxTokens, system, tools, messages, signal, onText }) {
  const body = JSON.stringify({ model, max_tokens: maxTokens, system, tools, messages, stream: true });
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body,
      signal,
    });
    if (res.ok || !RETRYABLE.has(res.status) || attempt >= 3) break;
    await res.body?.cancel();
    const wait = Number(res.headers.get('retry-after')) * 1000 || 2000 * 2 ** attempt;
    await sleep(Math.min(wait, 30_000), signal);
  }
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      message = JSON.parse(text).error?.message || text;
    } catch { /* not JSON */ }
    throw new Error(`Anthropic API ${res.status}: ${message}`);
  }

  const blocks = [];
  const json = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let stopReason = null;
  for await (const { event, data } of sse(res.body)) {
    if (event === 'message_start') {
      Object.assign(usage, Object.fromEntries(Object.entries(data.message.usage || {}).filter(([k]) => k in usage)));
    } else if (event === 'content_block_start') {
      blocks[data.index] = { ...data.content_block };
      if (data.content_block.type === 'tool_use') json[data.index] = '';
    } else if (event === 'content_block_delta') {
      const b = blocks[data.index];
      const d = data.delta;
      if (d.type === 'text_delta') {
        b.text = (b.text || '') + d.text;
        onText?.(d.text);
      } else if (d.type === 'input_json_delta') {
        json[data.index] += d.partial_json;
      } else if (d.type === 'thinking_delta') {
        b.thinking = (b.thinking || '') + d.thinking;
      } else if (d.type === 'signature_delta') {
        b.signature = d.signature;
      }
    } else if (event === 'content_block_stop') {
      const b = blocks[data.index];
      if (b?.type === 'tool_use') b.input = json[data.index] ? JSON.parse(json[data.index]) : {};
    } else if (event === 'message_delta') {
      stopReason = data.delta?.stop_reason ?? stopReason;
      if (data.usage?.output_tokens != null) usage.output_tokens = data.usage.output_tokens;
    } else if (event === 'error') {
      throw new Error(`Anthropic stream error: ${data.error?.message || JSON.stringify(data)}`);
    }
  }
  return { content: blocks.filter(Boolean), stop_reason: stopReason, usage };
}
