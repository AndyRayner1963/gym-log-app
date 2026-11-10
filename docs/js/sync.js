// Upload queue (brief 6.3), setup refresh (5.12), restore (6.5) and the
// connection state shown in the strip.  The result of a request is the only
// evidence of a connection: navigator.onLine is never read.

import * as db from './db.js';
import * as gh from './github.js';
import { deriveSlots } from './model.js';
import { isoLocal, ms } from './util.js';

// ---- Connection state ----
// state: unknown | online | offline | auth | error | notoken
export const net = { state: 'unknown', message: '', uploading: false };
const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(ev) { for (const fn of listeners) { try { fn(ev); } catch (e) { /* a listener must not break sync */ } } }

function setState(state, message = '') {
  const before = net.state;
  net.state = state;
  net.message = message;
  emit({ type: 'net', before, state });
  if (state === 'online' && before !== 'online') emit({ type: 'reconnected', before });
}

function fail(e) {
  if (e.kind === 'offline') setState('offline');
  else if (e.kind === 'auth') setState('auth', e.message);
  else if (e.kind === 'forbidden' || e.kind === 'notfound')
    setState('error', `GitHub refused access to the data repository (${e.status || e.kind}).  Check the repository name and the token in Settings.`);
  else setState('error', `Upload failed: ${e.message}`);
}

export async function config() {
  const s = (await db.kvGet('settings')) || {};
  return { token: s.token || '', owner: s.owner || '', repo: s.repo || '' };
}

// ---- Queue ----

/** A session that is waiting to go up.  An open session with no sets has nothing to say yet. */
export function waiting(rec) {
  if (!rec.dirty) return false;
  return !(rec.doc.status === 'open' && rec.doc.sets.length === 0 && !rec.everSent);
}

export function queueInfo(recs) {
  const q = recs.filter(waiting);
  return { sessions: q.length, sets: q.reduce((n, r) => n + r.doc.sets.length, 0) };
}

/** Canonical JSON: sorted keys, no spaces.  Used to decide "content matches". */
export function canonical(x) {
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
  return JSON.stringify(x);
}

export function serialize(doc) { return JSON.stringify(doc, null, 2) + '\n'; }

let running = null;
let again = false;

/** Upload every session with unsent changes, one at a time.  Never loops on failure. */
export function uploadAll() {
  if (running) { again = true; return running; }
  running = (async () => {
    try {
      do {
        again = false;
        const ok = await runOnce();
        if (!ok) break;
      } while (again);
    } finally {
      running = null;
      net.uploading = false;
      emit({ type: 'queue' });
    }
  })();
  return running;
}

async function runOnce() {
  const cfg = await config();
  if (!cfg.token) { setState('notoken'); return false; }
  const recs = (await db.sessionAll()).filter(waiting).sort((a, b) => ms(a.doc.started_at) - ms(b.doc.started_at));
  if (!recs.length) { emit({ type: 'queue' }); return true; }
  net.uploading = true;
  emit({ type: 'queue' });
  for (const r of recs) {
    try {
      await uploadOne(cfg, r.id);
      setState('online');
    } catch (e) {
      fail(e);
      return false;
    }
    emit({ type: 'queue' });
  }
  return true;
}

async function uploadOne(cfg, id) {
  const rec = await db.sessionGet(id);
  if (!rec || !waiting(rec)) return;
  const doc = rec.doc;
  const rev = doc.revision;
  const text = serialize(doc);
  const message = `Swole: ${doc.date} ${doc.workout_name || 'free-form'} (${doc.status}, revision ${rev})`;
  await db.sessionUpdate(id, s => (s ? Object.assign(s, { everSent: true }) : undefined));

  let newSha = null;
  // Step 1: we hold the marker, so send an update to that version.
  if (rec.sha) {
    try {
      newSha = await gh.putFile(cfg, rec.path, text, rec.sha, message);
    } catch (e) {
      if (e.kind !== 'conflict') throw e;   // Step 3: marker out of date, do step 2 once.
    }
  }
  // Step 2: ask GitHub whether the file exists.
  if (!newSha) {
    const remote = await gh.getFile(cfg, rec.path);
    if (!remote) {
      newSha = await gh.putFile(cfg, rec.path, text, null, message);
    } else {
      let rdoc = null;
      try { rdoc = JSON.parse(remote.text); } catch { rdoc = null; }
      if (rdoc && Number(rdoc.revision) >= rev && canonical(rdoc) === canonical(doc)) newSha = remote.sha;
      else newSha = await gh.putFile(cfg, rec.path, text, remote.sha, message);
    }
  }
  if (!newSha) throw new gh.GitHubError('http', 0, 'GitHub did not return a version marker');
  // Step 4: mark uploaded only on GitHub's confirmation, and only if nothing changed meanwhile.
  await db.sessionUpdate(id, s => {
    if (!s) return undefined;
    s.sha = newSha;
    s.everSent = true;
    if (s.doc.revision === rev && canonical(s.doc) === canonical(doc)) s.dirty = false;
    else again = true;
    return s;
  });
}

// ---- Setup ----

export function validSetup(s) {
  return s && typeof s === 'object' && Array.isArray(s.groups) && Array.isArray(s.exercises) && Array.isArray(s.workouts);
}

/**
 * Fetch setup.json.  Returns {result: 'changed'|'same'|'missing'|'newer'|'bad'}.
 * Throws a GitHubError on connection or token failure.
 */
export async function refreshSetup() {
  const cfg = await config();
  if (!cfg.token) { setState('notoken'); return { result: 'notoken' }; }
  let remote;
  try {
    remote = await gh.getFile(cfg, 'setup.json');
    setState('online');
  } catch (e) { fail(e); throw e; }
  await db.kvPut('setupCheckedAt', isoLocal());
  if (!remote) return { result: 'missing' };
  let s;
  try { s = JSON.parse(remote.text); } catch { return { result: 'bad', message: 'setup.json is not valid JSON' }; }
  if (Number(s.format) > 1) return { result: 'newer', message: `setup.json is format ${s.format}; this app reads format 1.  Update the app.` };
  if (!validSetup(s)) return { result: 'bad', message: 'setup.json is missing groups, exercises or workouts' };
  const stored = await db.kvGet('setup');
  if (stored && stored.hash === s.hash && stored.published_at === s.published_at) return { result: 'same' };
  await db.kvPut('setup', s);
  emit({ type: 'setup' });
  return { result: 'changed' };
}

// ---- Connection test ----
export async function testConnection() {
  const cfg = await config();
  if (!cfg.token) return { ok: false, text: 'No token saved' };
  try {
    const repo = await gh.getRepo(cfg);
    setState('online');
    const warn = repo && repo.private === false ? '  Warning: this repository is public.' : '';
    return { ok: true, text: `Connected to ${repo && repo.full_name ? repo.full_name : `${cfg.owner}/${cfg.repo}`}.${warn}` };
  } catch (e) {
    fail(e);
    if (e.kind === 'offline') return { ok: false, text: 'Offline: no answer from GitHub.' };
    if (e.kind === 'auth') return { ok: false, text: 'GitHub refused the token.' };
    if (e.kind === 'notfound' || e.kind === 'forbidden') return { ok: false, text: `Repository ${cfg.owner}/${cfg.repo} not found, or the token cannot see it.` };
    return { ok: false, text: `GitHub answered: ${e.message}` };
  }
}

// ---- Restore (6.5) ----

export async function listRemoteSessions(cfg) {
  const top = await gh.listDir(cfg, 'sessions');
  if (!top) return [];
  const files = [];
  for (const e of top) {
    if (e.type === 'dir') {
      const inner = (await gh.listDir(cfg, e.path)) || [];
      for (const f of inner) if (f.type === 'file' && f.name.endsWith('.json')) files.push(f);
    } else if (e.type === 'file' && e.name.endsWith('.json')) files.push(e);
  }
  return files;
}

/** Download every session file that is not on the phone.  Returns {added, skipped:[names]}. */
export async function restore(progress) {
  const cfg = await config();
  let files;
  try { files = await listRemoteSessions(cfg); setState('online'); } catch (e) { fail(e); throw e; }
  const setup = await db.kvGet('setup');
  const local = new Set((await db.sessionAll()).map(r => r.id));
  let added = 0;
  const skipped = [];
  let i = 0;
  for (const f of files) {
    i++;
    if (progress) progress(i, files.length);
    let remote;
    try { remote = await gh.getFile(cfg, f.path); } catch (e) { fail(e); throw e; }
    if (!remote) continue;
    let doc;
    try { doc = JSON.parse(remote.text); } catch { skipped.push(`${f.name} (not valid JSON)`); continue; }
    if (Number(doc.format) > 1) { skipped.push(`${f.name} (format ${doc.format} is newer than this app)`); continue; }
    if (!doc.session_id || !Array.isArray(doc.sets)) { skipped.push(`${f.name} (not a session file)`); continue; }
    if (local.has(doc.session_id)) continue;
    await db.sessionPut({
      id: doc.session_id, doc, path: f.path, sha: remote.sha, dirty: false, everSent: true,
      snapshot: null, slots: deriveSlots(doc, setup), ui: { current: null, draft: null, stopwatch: null },
    });
    local.add(doc.session_id);
    added++;
  }
  emit({ type: 'queue' });
  return { added, skipped, total: files.length };
}
