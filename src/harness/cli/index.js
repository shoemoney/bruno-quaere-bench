// Dispatches by name to the CLI adapter modules in this directory (Addendum F: "native CLI
// drivers, direct provider keys"). Each adapter exports:
//
//   name
//   build({sandbox, prompt, model, home}) -> {cmd, args, env, cwd}
//   parseUsage(stdout, home?) -> {tokensIn, tokensCached, tokensOut, modelVersion, usageEstimated}
//   resume(sessionId, {sandbox, prompt, model, home}) -> {cmd, args, env, cwd}
//
// Adapters are separate workstreams (ARCHITECTURE.md's ownership tags); only ai.js and codex.js
// are guaranteed to exist in this tree today. qwen/gemini/kimi are somebody else's files -- a
// missing one fails with a clear, actionable error instead of a bare "Cannot find module".

const REGISTRY = {
  ai: () => import('./ai.js'),
  codex: () => import('./codex.js'),
  qwen: () => import('./qwen.js'),
  gemini: () => import('./gemini.js'),
  kimi: () => import('./kimi.js'),
  grok: () => import('./grok.js'),
  muse: () => import('./muse.js'),
};

export const CLI_NAMES = Object.keys(REGISTRY);

// loadAdapter(name) -> {name, build, parseUsage, resume}
export async function loadAdapter(name) {
  const loader = REGISTRY[name];
  if (!loader) {
    throw new Error(`unknown cli adapter: "${name}" (known: ${CLI_NAMES.join(', ')})`);
  }
  let mod;
  try {
    mod = await loader();
  } catch (err) {
    if (err && (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND')) {
      throw new Error(`cli adapter "${name}" is not implemented yet (src/harness/cli/${name}.js is missing)`);
    }
    throw err;
  }
  for (const fn of ['build', 'parseUsage', 'resume']) {
    if (typeof mod[fn] !== 'function') {
      throw new Error(`cli adapter "${name}" is missing required export: ${fn}()`);
    }
  }
  // copyAuth is optional (only adapters that need a credential COPIED into the fresh per-run home
  // export one), but it has to survive this projection or the caller can never seed that home.
  return {
    name: mod.name || name,
    build: mod.build,
    parseUsage: mod.parseUsage,
    resume: mod.resume,
    ...(typeof mod.copyAuth === 'function' ? { copyAuth: mod.copyAuth } : {}),
  };
}
