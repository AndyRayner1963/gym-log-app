// Shared test helpers: browser, app page, database seeding and reading.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { FakeGitHub } = require('./fake-github');
const server = require('./server');

const FIX = path.resolve(__dirname, '..', '..', 'fixtures');
const SETUP = JSON.parse(fs.readFileSync(path.join(FIX, 'setup.json'), 'utf8'));
const SESSION_FILES = fs.readdirSync(path.join(FIX, 'sessions', '2026')).filter(f => f.endsWith('.json')).sort();
const FIXTURE_SESSIONS = SESSION_FILES.map(f => ({ path: `sessions/2026/${f}`, text: fs.readFileSync(path.join(FIX, 'sessions', '2026', f), 'utf8') }));
const fixtureDoc = idPrefix => JSON.parse(FIXTURE_SESSIONS.find(s => s.path.includes(idPrefix)).text);
const closedFixtureDocs = () => FIXTURE_SESSIONS.map(s => JSON.parse(s.text)).filter(d => d.status === 'closed' || d.status === 'auto_closed');

const VIEWPORT = { width: 430, height: 932 };
// A fixed "now" in Bangkok, after every fixture session.
const T0 = new Date('2026-11-12T16:30:00+07:00');

let shared = null;
async function env() {
  if (!shared) {
    const srv = await server.start();
    const browser = await chromium.launch();
    shared = { srv, browser };
  }
  return shared;
}
async function closeEnv() {
  if (!shared) return;
  await shared.browser.close();
  await shared.srv.close();
  shared = null;
}

/**
 * Open the app.  Options:
 *   fake        FakeGitHub (a new online one by default)
 *   sw          allow the service worker (default false: blocked, so routing is plain)
 *   time        install Playwright's clock at this time (default T0); null for the real clock
 *   seed        {settings, setup, sessions:[doc]} written to IndexedDB, then the page reloads
 *   dsf         deviceScaleFactor (default 1)
 */
async function openApp(opts = {}) {
  const { srv, browser } = await env();
  const fake = opts.fake || new FakeGitHub();
  const ctx = await browser.newContext({
    viewport: VIEWPORT, deviceScaleFactor: opts.dsf || 1, timezoneId: 'Asia/Bangkok', locale: 'en-GB',
    serviceWorkers: opts.sw ? 'allow' : 'block', acceptDownloads: true, hasTouch: false,
  });
  await fake.attach(ctx);
  // Test-only: remember every IndexedDB connection the page opens, so a test can close
  // them behind the app's back, as iOS does to a backgrounded page.  Nothing in docs/ changes.
  await ctx.addInitScript(() => {
    const open = IDBFactory.prototype.open;
    window.__idbConns = [];
    IDBFactory.prototype.open = function (...args) {
      const req = open.apply(this, args);
      req.addEventListener('success', () => window.__idbConns.push(req.result));
      return req;
    };
  });
  const requests = [];
  ctx.on('request', r => requests.push(r.url()));
  const page = await ctx.newPage();
  const errors = [];
  const consoleErrors = [];
  const dialogs = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('dialog', d => { dialogs.push(d.type()); d.dismiss().catch(() => {}); });
  if (opts.time !== null) await page.clock.install({ time: opts.time || T0 });
  await page.goto(srv.base);
  await ready(page);
  if (opts.seed) {
    await seed(page, opts.seed);
    await page.reload();
    await ready(page);
  }
  return { ctx, page, fake, srv, errors, consoleErrors, dialogs, requests, close: () => ctx.close() };
}

async function ready(page) {
  await page.waitForFunction(() => document.getElementById('app') && document.getElementById('app').dataset.view);
}

const SETTINGS = (fake, extra = {}) => ({ token: fake.token, owner: fake.owner, repo: fake.repo, ...extra });

/** Write settings / setup / sessions straight into the app's IndexedDB. */
async function seed(page, { settings, setup, sessions, meta }) {
  await page.evaluate(async ({ settings, setup, sessions, meta }) => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('swole', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => {
      const t = db.transaction(['kv', 'sessions'], 'readwrite');
      t.oncomplete = res; t.onerror = () => rej(t.error);
      if (settings) t.objectStore('kv').put(settings, 'settings');
      if (setup) t.objectStore('kv').put(setup, 'setup');
      if (meta) t.objectStore('kv').put(meta, 'meta');
      for (const d of sessions || []) {
        t.objectStore('sessions').put({
          id: d.session_id, doc: d, path: `sessions/${d.date.slice(0, 4)}/${d.date}_${d.session_id}.json`,
          sha: null, dirty: false, everSent: true, snapshot: null, slots: [], ui: { current: null, draft: null, stopwatch: null },
        });
      }
    });
    db.close();
  }, { settings, setup, sessions, meta });
}

/** Everything in the app's database. */
async function readDB(page) {
  return page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('swole', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const all = (store) => new Promise((res, rej) => { const t = db.transaction(store); const os = t.objectStore(store); const r = os.getAll(); const k = os.getAllKeys(); t.oncomplete = () => res({ keys: k.result, values: r.result }); t.onerror = () => rej(t.error); });
    const kv = await all('kv');
    const sessions = await all('sessions');
    db.close();
    const kvObj = {};
    kv.keys.forEach((k, i) => { kvObj[k] = kv.values[i]; });
    return { kv: kvObj, sessions: sessions.values };
  });
}

async function openSession(page) {
  const d = await readDB(page);
  return d.sessions.find(s => s.doc.status === 'open') || null;
}

async function waitFor(fn, { timeout = 8000, interval = 50, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${message} (last: ${last && last.message ? last.message : JSON.stringify(last)})`);
}

/** Tap Log after moving the fake clock past the one-second guard, and wait for the write. */
async function logSet(page, { advance = 1100 } = {}) {
  const before = ((await openSession(page)) || { doc: { sets: [] } }).doc.sets.length;
  if (advance) await page.clock.fastForward(advance);
  await page.click('[data-action=log]');
  await waitFor(async () => ((await openSession(page)) || { doc: { sets: [] } }).doc.sets.length === before + 1, { message: 'set to be logged' });
  await page.waitForSelector('[data-action=log], [data-dock]');
}

async function setEntry(page, weight, value) {
  if (weight !== undefined) await page.fill('.dock input[name=weight]', String(weight));
  if (value !== undefined) {
    const sel = (await page.$('.dock input[name=reps]')) ? '.dock input[name=reps]' : '.dock input[name=seconds]';
    await page.fill(sel, String(value));
  }
}

async function entryValues(page) {
  return page.evaluate(() => {
    const w = document.querySelector('.dock input[name=weight]');
    const v = document.querySelector('.dock input[name=reps]') || document.querySelector('.dock input[name=seconds]');
    const log = document.querySelector('[data-action=log]');
    return { weight: w ? w.value : null, value: v ? v.value : null, logDisabled: log ? log.disabled : null, logText: log ? log.textContent : null };
  });
}

/** Close every database connection the page holds, without telling the app.  Returns how many. */
async function closeConnections(page) {
  return page.evaluate(() => { const n = window.__idbConns.length; for (const c of window.__idbConns) c.close(); window.__idbConns = []; return n; });
}

async function strip(page) { return (await page.textContent('#strip')).replace(/\s+/g, ' ').trim(); }

module.exports = {
  FakeGitHub, SETUP, FIXTURE_SESSIONS, fixtureDoc, closedFixtureDocs, T0, VIEWPORT, SETTINGS,
  env, closeEnv, openApp, ready, seed, readDB, openSession, waitFor, logSet, setEntry, entryValues, strip, closeConnections,
};
