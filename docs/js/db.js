// IndexedDB: the app's only store for anything that matters.
//   kv        key/value: 'settings', 'setup', 'meta'
//   sessions  one record per session, keyPath 'id'
// Every write resolves only when the transaction has committed, so callers can
// show a set as logged only after it is on disk (brief 6.1, write first).
//
// Lost connections.  iOS closes the database connection of a page that has been
// in the background or suspended; the page is not told, and the next
// db.transaction() throws "The database connection is closing".  So:
//   - the cached connection is dropped when the browser closes it (onclose) or
//     when a transaction cannot be created on it;
//   - an operation that fails because the connection was lost, before any of its
//     requests succeeded (so nothing was written), is retried once on a fresh
//     connection.  Genuine failures (quota, constraint, a bug) are never retried.
//   - opening is retried once after a short pause before an error is reported.

const DB_NAME = 'swole';
const DB_VERSION = 1;
const OPEN_RETRY_MS = 300;
let dbp = null;     // promise of the cached connection
let live = null;    // the cached connection itself

function openOnce() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => forget(db);                         // closed by the browser
      db.onversionchange = () => { forget(db); db.close(); };
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('The database could not be opened'));
    req.onblocked = () => reject(Object.assign(new Error('Database blocked by another copy of the app'), { name: 'BlockedError' }));
  });
}

function open() {
  if (dbp) return dbp;
  const p = (async () => {
    let db;
    try { db = await openOnce(); } catch (e) {
      await new Promise(r => setTimeout(r, OPEN_RETRY_MS));
      db = await openOnce();
    }
    live = db;
    return db;
  })();
  dbp = p;
  p.catch(() => { if (dbp === p) dbp = null; });
  return p;
}

/** Drop the cached connection (if it is still this one) so the next operation reopens. */
function forget(db) {
  if (db && live && db !== live) return;
  try { if (live) live.close(); } catch { /* already closed */ }
  live = null;
  dbp = null;
}

/** An error that means the connection was lost rather than the operation being refused. */
function isLost(e) {
  if (!e) return false;
  if (e.name === 'InvalidStateError' || e.name === 'UnknownError') return true;
  if (e.name === 'QuotaExceededError' || e.name === 'ConstraintError' || e.name === 'DataError') return false;
  return /connection|closing|closed/i.test(String(e.message || ''));
}

class Lost extends Error {
  constructor(cause) { super(cause && cause.message ? cause.message : 'Database connection lost'); this.cause = cause; this.lost = true; }
}

/** Run attempt(db) on the cached connection; if it reports a lost connection, reopen and run it once more. */
async function withRetry(attempt) {
  const db = await open();
  try {
    return await attempt(db);
  } catch (e) {
    if (!(e instanceof Lost)) throw e;
    forget(db);
  }
  const db2 = await open();
  try {
    return await attempt(db2);
  } catch (e) {
    if (e instanceof Lost) { forget(db2); throw e.cause || e; }
    throw e;
  }
}

/**
 * One transaction.  body(store, done) issues the requests; call ok() whenever a
 * request succeeds, so a later failure is not taken for a lost connection.
 */
function transaction(db, store, mode, body) {
  return new Promise((resolve, reject) => {
    let t;
    try {
      t = db.transaction(store, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
    } catch (e) {
      reject(isLost(e) ? new Lost(e) : e);
      return;
    }
    let anyOk = false;
    let settled = false;
    const state = { result: undefined, ok: () => { anyOk = true; } };
    const fail = e => {
      if (settled) return;
      settled = true;
      reject(!anyOk && isLost(e) ? new Lost(e) : e);
    };
    t.oncomplete = () => { if (!settled) { settled = true; resolve(state.result); } };
    t.onerror = () => fail(t.error || new Error('Database write failed'));
    t.onabort = () => fail(t.error || new Error('Database write aborted'));
    try {
      body(t.objectStore(store), state, fail, t);
    } catch (e) {
      try { t.abort(); } catch { /* already finished */ }
      fail(e);
    }
  });
}

function tx(store, mode, fn) {
  return withRetry(db => transaction(db, store, mode, (os, state) => {
    const r = fn(os);
    if (r && 'onsuccess' in r) r.onsuccess = () => { state.ok(); state.result = r.result; };
  }));
}

export const kvGet = key => tx('kv', 'readonly', os => os.get(key));
export const kvPut = (key, value) => tx('kv', 'readwrite', os => os.put(value, key));
export const kvDel = key => tx('kv', 'readwrite', os => os.delete(key));

export const sessionGet = id => tx('sessions', 'readonly', os => os.get(id));
export const sessionAll = () => tx('sessions', 'readonly', os => os.getAll());
export const sessionPut = rec => tx('sessions', 'readwrite', os => os.put(rec));
export const sessionDel = id => tx('sessions', 'readwrite', os => os.delete(id));

/** A cheap read that replaces a dead connection before anything else needs it. */
export async function ping() {
  try { await kvGet('meta'); return true; } catch { return false; }
}

/**
 * Read-modify-write of one session in a single transaction, so the uploader and
 * the screen never overwrite each other's fields.  fn(stored|undefined) returns
 * the record to store, or undefined to leave it.  Resolves with what was stored.
 * On a retry fn runs again on the record read inside the new transaction, so fn
 * must depend only on its argument (every caller's fn does).
 */
export function sessionUpdate(id, fn) {
  return withRetry(db => transaction(db, 'sessions', 'readwrite', (os, state, fail, t) => {
    const g = os.get(id);
    g.onsuccess = () => {
      state.ok();
      try {
        state.result = fn(g.result);
        if (state.result !== undefined) os.put(state.result);
      } catch (e) {
        try { t.abort(); } catch { /* already finished */ }
        fail(e);
      }
    };
  }));
}
