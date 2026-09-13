// Caught live, 2026-09-13: grok-4.6 via OpenRouter climbed clean through rung 36 and died with
// `stoppedBecause: 'error'`, `driverError: "Unexpected token '<', \"<!DOCTYPE \"... is not valid
// JSON"`. All three message-loop drivers called `res.json()` before checking `res.ok`, so a
// gateway failure that serves an HTML error page (a Cloudflare challenge, a 502/504 from the
// provider's own edge, an outage page) threw a bare SyntaxError with no `.status` field --
// invisible to run.js's TRANSIENT classifier, which only inspects `.status` and message text for
// codes like 429/500-504. A clean climb died on one flaky response instead of retrying.
//
// Fix: each driver now reads the body as text first, and on a JSON.parse failure throws an Error
// carrying a real `.status` (the HTTP status if non-2xx, else a synthetic 502) and a
// `.providerMessage` naming it a non-JSON body -- exactly the shape run.js's transient-retry path
// already knows how to handle for every other provider hiccup.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDriver as createOpenAiDriver } from '../src/harness/drivers/openai.js';
import { createDriver as createAnthropicDriver } from '../src/harness/drivers/anthropic.js';
import { createDriver as createGoogleDriver } from '../src/harness/drivers/google.js';

const HTML_ERROR_PAGE = '<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>';

function fakeFetchReturning(status, ok, bodyText) {
  return async () => ({
    ok,
    status,
    statusText: 'Bad Gateway',
    async text() {
      return bodyText;
    },
    async json() {
      // A real fetch() Response.json() would throw the same bare SyntaxError the drivers used to
      // hit; asserting the drivers no longer call this path is part of what these tests prove.
      throw new Error("Unexpected token '<', \"" + bodyText.slice(0, 9) + '"... is not valid JSON');
    },
  });
}

const CASES = [
  {
    name: 'openai',
    make: () =>
      createOpenAiDriver({ model: 'x', apiKey: 'k', systemPrompt: 'p', baseUrl: 'https://example.invalid' }),
    label: 'openai-compatible',
  },
  {
    name: 'anthropic',
    make: () => createAnthropicDriver({ model: 'x', apiKey: 'k', systemPrompt: 'p' }),
    label: 'anthropic',
  },
  {
    name: 'google',
    make: () => createGoogleDriver({ model: 'x', apiKey: 'k', systemPrompt: 'p' }),
    label: 'google',
  },
];

for (const { name, make, label } of CASES) {
  test(`${name} driver: a non-2xx HTML gateway error page throws a retryable error with a real status, not a bare SyntaxError`, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeFetchReturning(502, false, HTML_ERROR_PAGE);
    try {
      const driver = make();
      await assert.rejects(
        () => driver.step([{ role: 'user', content: 'hi' }], []),
        (err) => {
          assert.equal(err.status, 502, 'must carry the real HTTP status, not be undefined');
          assert.match(err.message, new RegExp(`^${label} 502:`));
          assert.doesNotMatch(err.message, /^Unexpected token/, 'must not be the bare JSON.parse SyntaxError');
          return true;
        },
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test(`${name} driver: a 200 response with a non-JSON body (a proxy/CDN misconfiguration) is treated as a synthetic 502, not silently accepted`, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeFetchReturning(200, true, HTML_ERROR_PAGE);
    try {
      const driver = make();
      await assert.rejects(
        () => driver.step([{ role: 'user', content: 'hi' }], []),
        (err) => {
          assert.equal(err.status, 502, 'a 2xx with an unparseable body is not success');
          return true;
        },
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}
