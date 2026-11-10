// IndexedDB: the app's only store for anything that matters.
//   kv        key/value: 'settings', 'setup', 'meta'
//   sessions  one record per session, keyPath 'id'
// Every write resolves only when the transaction has committed, so callers can
// show a set as logged only after it is on disk (brief 6.1, write first).

const DB_NAME = 'swole';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbp = null; };
      resolve(db);
    };
    req.onerror = () => { dbp = null; reject(req.error); };
    req.onblocked = () => reject(new Error('Database blocked by another copy of the app'));
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error || new Error('Database write failed'));
    t.onabort = () => reject(t.error || new Error('Database write aborted'));
    const os = t.objectStore(store);
    const r = fn(os);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
  });
}

export const kvGet = key => tx('kv', 'readonly', os => os.get(key));
export const kvPut = (key, value) => tx('kv', 'readwrite', os => os.put(value, key));
export const kvDel = key => tx('kv', 'readwrite', os => os.delete(key));

export const sessionGet = id => tx('sessions', 'readonly', os => os.get(id));
export const sessionAll = () => tx('sessions', 'readonly', os => os.getAll());
export const sessionPut = rec => tx('sessions', 'readwrite', os => os.put(rec));
export const sessionDel = id => tx('sessions', 'readwrite', os => os.delete(id));

/**
 * Read-modify-write of one session in a single transaction, so the uploader and
 * the screen never overwrite each other's fields.  fn(stored|undefined) returns
 * the record to store, or undefined to leave it.  Resolves with what was stored.
 */
export async function sessionUpdate(id, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction('sessions', 'readwrite', { durability: 'strict' });
    const os = t.objectStore('sessions');
    let out;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error || new Error('Database write failed'));
    t.onabort = () => reject(t.error || new Error('Database write aborted'));
    const g = os.get(id);
    g.onsuccess = () => {
      try {
        out = fn(g.result);
        if (out !== undefined) os.put(out);
      } catch (e) { t.abort(); reject(e); }
    };
  });
}
