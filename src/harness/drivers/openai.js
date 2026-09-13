// OpenAI-compatible Chat Completions driver. createDriver({model, apiKey, systemPrompt, baseUrl?,
// extraHeaders?}) -> {step}. Also the `openrouter` driver per Addendum C: same wire protocol, a
// different baseUrl (https://openrouter.ai/api/v1) and two extra headers. Never logs apiKey.

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

// Addendum K: default output budget for every message-loop driver (was 4096) -- a reasoning
// model can burn its whole completion budget on invisible reasoning tokens before it ever emits
// visible text or a tool call (deepseek-flash, seed 506, rung 44: empty content, stop: 'length',
// 4096 output tokens). `quaere run --max-output-tokens N` overrides it.
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

// A provider's 400 for "max_tokens is larger than the model/account allows" -- distinct from any
// other 400 (bad request shape, unknown model): the fix is to send a smaller number, not to
// retry the identical request. Matches OpenAI's own wording ("max_tokens is too large"), Azure's
// ("Max tokens ... is greater than the model's context length"), and the generic shapes several
// OpenAI-compatible providers use.
const MAX_TOKENS_TOO_LARGE = /max[_ ]tokens|max.?output.?tokens/i;
const TOO_LARGE_WORDING = /too large|exceed|greater than|must be (less|<)|invalid.*max/i;

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

// Addendum D: OpenRouter passes an OpenAI-shaped `cache_control` on a content PART through to
// Anthropic models as a real cache breakpoint. Plain OpenAI ignores/rejects string content here,
// so this only runs when the caller opts in with `cacheControl: true` (openrouter driver only --
// see run.js's resolveDriver).  Marks the system message and the single most recent tool result.
function applyCacheControl(openAiMessages) {
  const [system, ...rest] = openAiMessages;
  const withCachedSystem = {
    ...system,
    content: [{ type: 'text', text: system.content, cache_control: { type: 'ephemeral' } }],
  };
  let lastToolIndex = -1;
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    if (rest[i].role === 'tool') {
      lastToolIndex = i;
      break;
    }
  }
  const out = [withCachedSystem, ...rest];
  if (lastToolIndex >= 0) {
    const idx = lastToolIndex + 1; // +1 for the system message re-inserted at index 0
    out[idx] = {
      ...out[idx],
      content: [{ type: 'text', text: out[idx].content, cache_control: { type: 'ephemeral' } }],
    };
  }
  return out;
}

export function createDriver({
  model,
  apiKey,
  systemPrompt,
  baseUrl = DEFAULT_BASE_URL,
  extraHeaders = {},
  maxTokens = DEFAULT_MAX_OUTPUT_TOKENS,
  // Addendum D: set by run.js's resolveDriver only for --driver openrouter.
  cacheControl = false,
}) {
  if (!apiKey) throw new Error('openai driver: missing apiKey (set OPENAI_API_KEY or OPENROUTER_API_KEY)');

  // Addendum K: the output budget actually in use, mutable so a "too large" rejection can halve
  // it once and every later call in this climb keeps using the accepted value instead of
  // re-tripping the same rejection turn after turn. Exposed as driver.maxOutputTokens below so
  // run.js can log what a run actually settled on.
  let currentMaxTokens = maxTokens;

  async function callOnce(openAiMessages, tools, tokens) {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...extraHeaders,
      },
      body: JSON.stringify({
        model,
        max_tokens: tokens,
        messages: openAiMessages,
        tools: toOpenAiTools(tools),
        tool_choice: 'auto',
      }),
    });
    // Read as text first, then parse: a gateway/proxy failure (Cloudflare challenge, a 502/504
    // from the provider's edge, a plain outage page) serves HTML with a 200 or a non-JSON body
    // on a 5xx, and `res.json()` on that throws a bare SyntaxError with no `.status` -- which
    // run.js's TRANSIENT regex cannot see, so a clean climb died as a hard 'error' on one flaky
    // response (caught live: grok-4.6 via OpenRouter, clean through rung 36, killed by
    // `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`). Give every such failure a
    // real `.status` (the HTTP status if it was a non-2xx, else a synthetic 502 for a 2xx that
    // still isn't JSON) so it retries like any other transient provider failure instead of
    // stopping the run.
    const bodyText = await res.text();
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      const err = new Error(
        `openai-compatible ${res.status}: non-JSON response body (${bodyText.slice(0, 200).replace(/\s+/g, ' ')})`,
      );
      err.status = res.ok ? 502 : res.status;
      err.providerMessage = 'non-JSON response body';
      throw err;
    }
    if (!res.ok) {
      const message = data && data.error ? data.error.message : res.statusText;
      const err = new Error(`openai-compatible ${res.status}: ${message}`);
      err.status = res.status;
      err.providerMessage = String(message || '');
      throw err;
    }
    return data;
  }

  async function step(messages, tools) {
    let openAiMessages = toOpenAiMessages(systemPrompt, messages);
    if (cacheControl) openAiMessages = applyCacheControl(openAiMessages);

    let data;
    try {
      data = await callOnce(openAiMessages, tools, currentMaxTokens);
    } catch (err) {
      // Addendum K: "if a provider rejects it as too large, halve and retry once." Only this one
      // specific shape of 400 gets the halve-and-retry; anything else (bad model id, malformed
      // tools, auth) still throws straight out to run.js's existing retry/error handling.
      if (err.status === 400 && MAX_TOKENS_TOO_LARGE.test(err.providerMessage) && TOO_LARGE_WORDING.test(err.providerMessage)) {
        currentMaxTokens = Math.max(1, Math.floor(currentMaxTokens / 2));
        data = await callOnce(openAiMessages, tools, currentMaxTokens);
      } else {
        throw err;
      }
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
        // Addendum D: reported only, never charged. OpenRouter's Anthropic pass-through echoes
        // Anthropic's field name; plain OpenAI's automatic caching reports it nested instead.
        cache_read_input_tokens:
          (data.usage && (data.usage.cache_read_input_tokens || (data.usage.prompt_tokens_details || {}).cached_tokens)) || 0,
      },
      stop: choice.finish_reason,
    };
  }

  return {
    step,
    get maxOutputTokens() {
      return currentMaxTokens;
    },
  };
}
