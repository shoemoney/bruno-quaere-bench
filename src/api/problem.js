// RFC 9457 application/problem+json helpers. Every error response in the API goes
// through here so the body shape is never a bare string.

const DEFAULT_TITLES = {
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  409: 'Conflict',
  412: 'Precondition Failed',
  422: 'Unprocessable Entity',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
};

// problemBody({status, title?, detail?, type?, errors?, extra?}) -> plain object body.
export function problemBody({ status, title, detail, type = 'about:blank', errors, extra }) {
  const body = { type, title: title ?? DEFAULT_TITLES[status] ?? 'Error', status };
  if (detail !== undefined) body.detail = detail;
  if (errors !== undefined) body.errors = errors;
  if (extra) Object.assign(body, extra);
  return body;
}

// sendProblem(res, status, opts): writes application/problem+json and ends the response.
// opts.headers merges extra response headers (e.g. Retry-After, WWW-Authenticate).
export function sendProblem(res, status, opts = {}) {
  const { headers, ...rest } = opts;
  const body = problemBody({ status, ...rest });
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/problem+json',
    'content-length': String(buf.length),
    ...(headers || {}),
  });
  res.end(buf);
}
