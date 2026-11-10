// GitHub contents API.  The token is sent only to API (a constant, never taken
// from settings or the address bar) and is never logged.

const API = 'https://api.github.com';
const TIMEOUT_MS = 20000;

export class GitHubError extends Error {
  /** kind: offline | auth | forbidden | notfound | conflict | http | format */
  constructor(kind, status, message) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

// ---- UTF-8 safe base64 ----
export function b64encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function b64decode(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

const seg = p => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');

function repoUrl(cfg, rest = '') {
  return `${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}${rest}`;
}

async function call(cfg, method, url, body) {
  if (!cfg || !cfg.token) throw new GitHubError('auth', 0, 'No token saved');
  if (!cfg.owner || !cfg.repo) throw new GitHubError('notfound', 0, 'Data repository not set');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${cfg.token}`,
        'Accept': 'application/vnd.github+json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new GitHubError('offline', 0, 'No connection');
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (res.ok) return { status: res.status, data };
  const msg = (data && data.message) || `HTTP ${res.status}`;
  if (res.status === 401) throw new GitHubError('auth', 401, msg);
  if (res.status === 403) throw new GitHubError('forbidden', 403, msg);
  if (res.status === 404) throw new GitHubError('notfound', 404, msg);
  if (res.status === 409) throw new GitHubError('conflict', 409, msg);
  // GitHub answers 422 when a sha is missing or wrong for an existing file.
  if (res.status === 422 && /sha/i.test(msg)) throw new GitHubError('conflict', 422, msg);
  throw new GitHubError('http', res.status, msg);
}

/** Repository details, used by the connection test. */
export async function getRepo(cfg) {
  const r = await call(cfg, 'GET', repoUrl(cfg));
  return r.data;
}

/** A file's text and sha, or null if absent. */
export async function getFile(cfg, path) {
  try {
    const r = await call(cfg, 'GET', repoUrl(cfg, `/contents/${seg(path)}`));
    const d = r.data;
    if (!d || Array.isArray(d) || d.type !== 'file') throw new GitHubError('http', 200, `${path} is not a file`);
    let text;
    if (d.encoding === 'base64' && typeof d.content === 'string') text = b64decode(d.content);
    else throw new GitHubError('http', 200, `${path} is too large to read through the contents API`);
    return { sha: d.sha, text };
  } catch (e) {
    if (e.kind === 'notfound') return null;
    throw e;
  }
}

/** Create (sha null) or update a file.  Returns the new sha. */
export async function putFile(cfg, path, text, sha, message) {
  const body = { message, content: b64encode(text) };
  if (sha) body.sha = sha;
  const r = await call(cfg, 'PUT', repoUrl(cfg, `/contents/${seg(path)}`), body);
  return r.data && r.data.content && r.data.content.sha;
}

/** Directory listing, or null if the directory does not exist. */
export async function listDir(cfg, path) {
  try {
    const r = await call(cfg, 'GET', repoUrl(cfg, `/contents/${seg(path)}`));
    return Array.isArray(r.data) ? r.data : [];
  } catch (e) {
    if (e.kind === 'notfound') return null;
    throw e;
  }
}
