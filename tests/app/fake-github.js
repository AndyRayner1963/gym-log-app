// In-memory stand-in for GitHub's contents API, attached with context.route().
// Behaves like the real thing where the app depends on it:
//   404 when absent, sha required and checked on update (409 on mismatch, 422 when missing),
//   401 for a bad token, git blob shas, base64 content with line breaks, directory listings.
// Modes: online | offline (connection refused).  cutAfterCommit: commit a PUT, then drop the reply.
const crypto = require('crypto');

class FakeGitHub {
  constructor({ owner = 'andy-test', repo = 'gym-log-data', token = 'good-token' } = {}) {
    this.owner = owner; this.repo = repo; this.token = token;
    this.files = new Map();
    this.mode = 'online';
    this.cutAfterCommit = 0;
    this.log = [];
    this.puts = [];
  }
  static sha(text) {
    const buf = Buffer.from(text, 'utf8');
    return crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');
  }
  put(path, text) { this.files.set(path, { text, sha: FakeGitHub.sha(text) }); }
  get(path) { return this.files.get(path); }
  json(path) { const f = this.files.get(path); return f ? JSON.parse(f.text) : null; }
  sessionPaths() { return [...this.files.keys()].filter(p => p.startsWith('sessions/')).sort(); }

  async attach(ctx) { await ctx.route('https://api.github.com/**', route => this.handle(route)); }

  async handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    this.log.push({ method, path: url.pathname, auth: req.headers().authorization || '' });
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'Authorization, Content-Type, Accept',
      'access-control-allow-methods': 'GET, PUT, OPTIONS',
      'access-control-expose-headers': 'ETag',
    };
    if (this.mode === 'offline') return route.abort('internetdisconnected');
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const reply = (status, body) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
    if ((req.headers().authorization || '') !== `Bearer ${this.token}`) return reply(401, { message: 'Bad credentials', status: '401' });
    const m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(?:\/contents(?:\/(.*))?)?$/);
    if (!m) return reply(404, { message: 'Not Found' });
    const [, o, r, rawPath] = m;
    if (decodeURIComponent(o) !== this.owner || decodeURIComponent(r) !== this.repo) return reply(404, { message: 'Not Found' });
    const isContents = url.pathname.includes('/contents');
    if (!isContents) {
      if (method === 'GET') return reply(200, { full_name: `${this.owner}/${this.repo}`, private: true });
      return reply(404, { message: 'Not Found' });
    }
    const path = (rawPath || '').split('/').filter(Boolean).map(decodeURIComponent).join('/');
    if (method === 'GET') {
      const f = this.files.get(path);
      if (f) {
        const b64 = Buffer.from(f.text, 'utf8').toString('base64').replace(/.{60}/g, '$&\n');
        return reply(200, { type: 'file', name: path.split('/').pop(), path, sha: f.sha, size: Buffer.byteLength(f.text), encoding: 'base64', content: b64 });
      }
      const prefix = path ? `${path}/` : '';
      const children = new Map();
      for (const [p, f2] of this.files) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const name = rest.split('/')[0];
        if (rest.includes('/')) children.set(name, { type: 'dir', name, path: prefix + name, sha: 'dir' });
        else children.set(name, { type: 'file', name, path: p, sha: f2.sha, size: Buffer.byteLength(f2.text) });
      }
      if (!children.size) return reply(404, { message: 'Not Found' });
      return reply(200, [...children.values()].sort((a, b) => a.name.localeCompare(b.name)));
    }
    if (method === 'PUT') {
      let body;
      try { body = JSON.parse(req.postData() || '{}'); } catch { return reply(400, { message: 'Problems parsing JSON' }); }
      if (!body.message || typeof body.content !== 'string') return reply(422, { message: 'Invalid request.' });
      const existing = this.files.get(path);
      if (existing && !body.sha) return reply(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
      if (existing && body.sha !== existing.sha) return reply(409, { message: `${path} does not match ${body.sha}` });
      if (!existing && body.sha) return reply(409, { message: `${path} does not match ${body.sha}` });
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      this.put(path, text);
      const sha = this.files.get(path).sha;
      this.puts.push({ path, sha, message: body.message, revision: safeRevision(text) });
      if (this.cutAfterCommit > 0) { this.cutAfterCommit--; return route.abort('connectionreset'); }
      return reply(existing ? 200 : 201, { content: { name: path.split('/').pop(), path, sha }, commit: { sha: crypto.randomBytes(20).toString('hex') } });
    }
    return reply(405, { message: 'Method not allowed' });
  }
}
function safeRevision(text) { try { return JSON.parse(text).revision; } catch { return null; } }

module.exports = { FakeGitHub };
