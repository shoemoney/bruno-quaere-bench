// Tiny method+path router with named `{param}` segments. No framework, no regex library.

function compile(path) {
  const paramNames = [];
  const pattern = path
    .split('/')
    .map((segment) => {
      const m = /^\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/.exec(segment);
      if (m) {
        paramNames.push(m[1]);
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${pattern}$`), paramNames };
}

// createRouter(entries): entries = [{ method, path, ...anything }], path segments wrapped in
// {name} become params. Returns match(method, pathname) -> { entry, params } | null. First
// matching entry wins, in the order given.
export function createRouter(entries) {
  const compiled = entries.map((entry) => ({ entry, ...compile(entry.path) }));
  return function match(method, pathname) {
    for (const { entry, regex, paramNames } of compiled) {
      if (entry.method !== method) continue;
      const m = regex.exec(pathname);
      if (!m) continue;
      const params = {};
      paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(m[i + 1]);
      });
      return { entry, params };
    }
    return null;
  };
}
