// Tiny static server: serves docs/ under /gym-log-app/ so relative-URL mistakes show up.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', 'docs');
const PREFIX = '/gym-log-app/';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

function start() {
  const hits = [];
  const overrides = {};   // published path -> text, so a test can publish a "new version"
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    hits.push(url.pathname);
    if (url.pathname === '/gym-log-app') { res.writeHead(301, { Location: PREFIX }); return res.end(); }
    if (!url.pathname.startsWith(PREFIX)) { res.writeHead(404); return res.end('outside the app path'); }
    let rel = decodeURIComponent(url.pathname.slice(PREFIX.length)) || 'index.html';
    if (Object.prototype.hasOwnProperty.call(overrides, rel)) {
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(rel)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return res.end(overrides[rel]);
    }
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    resolve({ server, port, base: `http://localhost:${port}${PREFIX}`, origin: `http://localhost:${port}`, hits, overrides, close: () => new Promise(r => server.close(r)) });
  }));
}

module.exports = { start, ROOT };

if (require.main === module) {
  start().then(s => console.log(`Serving ${ROOT} at ${s.base}`));
}
