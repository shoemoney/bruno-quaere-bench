// Anthropic Messages API driver. createDriver({model, apiKey, systemPrompt, baseUrl?}) -> {step}.
// step(messages, tools) sends the whole running conversation (the driver is stateless between
// calls -- run.js owns history) and returns {assistant, toolCalls, usage, stop}. Never logs
// apiKey.

const DEFAULT_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

function toAnthropicTools(tools) {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

// Our generic message shape (see run.js):
//   { role: 'user', content: string }
//   { role: 'assistant', content: string, toolCalls: [{id, name, input}] }
//   { role: 'tool', toolCallId, name, content: string, isError }
// Anthropic wants tool results as content blocks inside a user turn, so consecutive `tool`
// messages collapse into one user message with multiple tool_result blocks.
function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
      continue;
    }
    if (m.role === 'assistant') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls || []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      out.push({ role: 'assistant', content });
      continue;
    }
    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: [{ type: 'text', text: m.content }],
        is_error: Boolean(m.isError),
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && last.content.every((b) => b.type === 'tool_result')) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    }
  }
  return out;
}

// Addendum D: mark the single most recent tool_result as an ephemeral cache breakpoint. Anthropic
// caches everything up to and including a marked block, so this is "cache the conversation as of
// its last tool result" -- the part that's identical on the next turn's resend.
function markLastToolResultCacheable(anthropicMessages) {
  for (let i = anthropicMessages.length - 1; i >= 0; i -= 1) {
    const msg = anthropicMessages[i];
    if (msg.role !== 'user') continue;
    for (let j = msg.content.length - 1; j >= 0; j -= 1) {
      if (msg.content[j].type === 'tool_result') {
        msg.content[j] = { ...msg.content[j], cache_control: { type: 'ephemeral' } };
        return;
      }
    }
  }
}

export function createDriver({ model, apiKey, systemPrompt, baseUrl = DEFAULT_URL, maxTokens = 4096 }) {
  if (!apiKey) throw new Error('anthropic driver: missing apiKey (set ANTHROPIC_API_KEY)');

  async function step(messages, tools) {
    const anthropicMessages = toAnthropicMessages(messages);
    markLastToolResultCacheable(anthropicMessages);
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        // Addendum D: the system prompt is identical every turn -- the other cache breakpoint.
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: anthropicMessages,
        tools: toAnthropicTools(tools),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`anthropic ${res.status}: ${data && data.error ? data.error.message : res.statusText}`);
    }
    const blocks = data.content || [];
    const assistant = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const toolCalls = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));
    return {
      assistant,
      toolCalls,
      usage: {
        input_tokens: data.usage ? data.usage.input_tokens : 0,
        output_tokens: data.usage ? data.usage.output_tokens : 0,
        // Addendum D: reported for the board, never charged to the novel-token budget --
        // run.js's accounting is keyed off input_tokens/output_tokens alone.
        cache_read_input_tokens: data.usage ? data.usage.cache_read_input_tokens || 0 : 0,
      },
      stop: data.stop_reason,
    };
  }

  return { step };
}
