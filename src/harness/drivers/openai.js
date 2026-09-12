// OpenAI-compatible Chat Completions driver. createDriver({model, apiKey, systemPrompt, baseUrl?,
// extraHeaders?}) -> {step}. Also the `openrouter` driver per Addendum C: same wire protocol, a
// different baseUrl (https://openrouter.ai/api/v1) and two extra headers. Never logs apiKey.

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function toOpenAiTools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

// Same generic message shape as drivers/anthropic.js. OpenAI keeps tool calls attached to the
// assistant message and tool results as their own `role: 'tool'` messages (one per call, not
// merged), addressed by tool_call_id.
function toOpenAiMessages(systemPrompt, messages) {
  const out = [{ role: 'system', content: systemPrompt }];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const toolCalls = (m.toolCalls || []).map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      }));
      out.push({
        role: 'assistant',
        content: m.content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return out;
}

export function createDriver({
  model,
  apiKey,
  systemPrompt,
  baseUrl = DEFAULT_BASE_URL,
  extraHeaders = {},
  maxTokens = 4096,
}) {
  if (!apiKey) throw new Error('openai driver: missing apiKey (set OPENAI_API_KEY or OPENROUTER_API_KEY)');

  async function step(messages, tools) {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...extraHeaders,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: toOpenAiMessages(systemPrompt, messages),
        tools: toOpenAiTools(tools),
        tool_choice: 'auto',
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`openai-compatible ${res.status}: ${data && data.error ? data.error.message : res.statusText}`);
    }
    const choice = (data.choices || [])[0] || {};
    const message = choice.message || {};
    const toolCalls = (message.tool_calls || []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: tc.function.arguments ? JSON.parse(tc.function.arguments) : {},
    }));
    return {
      assistant: message.content || '',
      toolCalls,
      usage: {
        input_tokens: data.usage ? data.usage.prompt_tokens : 0,
        output_tokens: data.usage ? data.usage.completion_tokens : 0,
      },
      stop: choice.finish_reason,
    };
  }

  return { step };
}
