// Google Gemini OpenAI-compatible Chat Completions driver. createDriver({model, apiKey,
// systemPrompt}) -> {step}. Addendum H: the vaulted Google key reaches gemini-3.8-flash through
// https://generativelanguage.googleapis.com/v1beta/openai, and that endpoint speaks the same
// Chat Completions wire shape drivers/openai.js does -- with two differences verified against
// the live endpoint 2026-09-12, both handled here rather than in openai.js, since no other
// preset needs them:
//
// 1. Gemini 3 models attach a `thought_signature` to every function-call part (see
//    https://ai.google.dev/gemini-api/docs/thinking#signatures) and 400 with INVALID_ARGUMENT
//    ("Function call is missing a thought_signature...") the moment a follow-up turn replays
//    that tool call without echoing it back verbatim -- which is every turn after the first tool
//    call in a real climb. It rides on the OpenAI-compat wire format as `extra_content.google.
//    thought_signature` on the tool_call object, both in the response and, to be accepted again,
//    in the request. This driver carries it opaquely as `providerMeta` on each returned
//    toolCall; run.js's turn loop already threads a toolCall's shape through `messages`
//    unmodified (`{role:'assistant', ..., toolCalls: stepResult.toolCalls}`), so no change to
//    run.js's loop is needed for the round trip to work.
// 2. Google's OpenAI-compat endpoint reports an error as a one-element ARRAY
//    (`[{error: {...}}]`), not a bare `{error: {...}}` object -- openai.js's `data.error` lookup
//    silently comes back undefined against that shape, which is why an unhandled 400/401/403
//    here previously stringified to an empty "openai-compatible 400: " with no message or status
//    text an operator (or run.js's PROVIDER_AUTH_ERROR/isContextLengthError classifiers) could
//    use.

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

// Addendum K: default output budget for every message-loop driver (was 4096) -- see
// drivers/openai.js's header comment for the deepseek-flash failure this is fixing.
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;
const MAX_TOKENS_TOO_LARGE = /max[_ ]tokens|max.?output.?tokens/i;
const TOO_LARGE_WORDING = /too large|exceed|greater than|must be (less|<)|invalid.*max/i;

function toGoogleTools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

// Same generic message shape as drivers/openai.js and drivers/anthropic.js.
function toGoogleMessages(systemPrompt, messages) {
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
        // Echo back whatever this call's own response carried (see providerMeta below) so a
        // Gemini function-call part keeps its thought_signature across the round trip. Omitted
        // entirely when absent -- true for the very first tool call ever made in a climb, since
        // nothing has been returned yet to echo, and Gemini accepts that fine.
        ...(tc.providerMeta ? { extra_content: tc.providerMeta } : {}),
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

export function createDriver({ model, apiKey, systemPrompt, maxTokens = DEFAULT_MAX_OUTPUT_TOKENS }) {
  if (!apiKey) throw new Error('google driver: missing apiKey (set GEMINI_API_KEY)');

  // Addendum K: mutable so a "too large" rejection halves it once and every later call in this
  // climb keeps using the accepted value; exposed as driver.maxOutputTokens for run.js to log.
  let currentMaxTokens = maxTokens;

  async function callOnce(tools, messages, tokens) {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: tokens,
        messages: toGoogleMessages(systemPrompt, messages),
        tools: toGoogleTools(tools),
        tool_choice: 'auto',
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      // See file header point 2: unwrap the array-shaped error body before falling back to
      // res.statusText, so run.js's PROVIDER_AUTH_ERROR (401/403) and isContextLengthError
      // (400/413) classifiers actually see the status code in the thrown message.
      const errBody = Array.isArray(data) ? data[0] : data;
      const message = errBody && errBody.error ? errBody.error.message : res.statusText;
      const err = new Error(`google ${res.status}: ${message}`);
      err.status = res.status;
      err.providerMessage = String(message || '');
      throw err;
    }
    return data;
  }

  async function step(messages, tools) {
    let data;
    try {
      data = await callOnce(tools, messages, currentMaxTokens);
    } catch (err) {
      // Addendum K: "if a provider rejects it as too large, halve and retry once."
      if (err.status === 400 && MAX_TOKENS_TOO_LARGE.test(err.providerMessage) && TOO_LARGE_WORDING.test(err.providerMessage)) {
        currentMaxTokens = Math.max(1, Math.floor(currentMaxTokens / 2));
        data = await callOnce(tools, messages, currentMaxTokens);
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
      // See file header point 1: opaque round-trip cargo, re-attached on the next request by
      // toGoogleMessages above. undefined for a tool call that carried none.
      providerMeta: tc.extra_content,
    }));
    return {
      assistant: message.content || '',
      toolCalls,
      usage: {
        input_tokens: data.usage ? data.usage.prompt_tokens : 0,
        output_tokens: data.usage ? data.usage.completion_tokens : 0,
        cache_read_input_tokens: 0,
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
