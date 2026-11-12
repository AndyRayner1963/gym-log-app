// Swole: screens and wiring.  See BRIEF.md section 5.
import * as db from './db.js';
import * as M from './model.js';
import * as sync from './sync.js';
import { closeDialogs, closeSheet, confirmBox, h, messageBox, openSheet, rirStepper, stepper, toast } from './ui.js';
import * as U from './util.js';

const state = {
  view: 'home',            // home | workout | history | session | settings
  settings: { token: '', owner: '', repo: '' },
  setup: null,
  meta: {},
  setupCheckedAt: null,
  recs: [],                // every session record on the phone
  open: null,              // the open session record
  detailId: null,          // session shown in History detail
  backTo: 'home',          // where Settings' back button goes
  entry: null,             // {key, weight, value} for the set being entered
  lastLogAt: 0,            // double-tap guard
  busy: false,
  setupProblem: '',
  offerRestore: false,
  restoring: false,
  replacingToken: false,
  connText: '',
  swReg: null,
  swUpdateReady: false,
  scrollToCurrent: true,
};

const history = () => M.closedDocs(state.recs);
const exOf = (rec, id) => M.exerciseOf(rec, id, state.setup) || fromSets(rec, id);
function fromSets(rec, id) {
  const s = rec && rec.doc.sets.find(x => x.exercise_id === id);
  return s ? { id, name: s.exercise_name, group: s.group, type: s.type, measure: s.measure, increment_kg: 1, note: '', active: true } : null;
}
const valueOf = U.valueOf;

// ======================================================================
// Start-up
// ======================================================================

// Set once the first screen is drawn or the user touches anything: from then on the page is never reloaded.
let firstRendered = false;
let inputSeen = false;
for (const ev of ['pointerdown', 'keydown', 'touchstart']) document.addEventListener(ev, () => { inputSeen = true; }, { capture: true, passive: true });

async function init() {
  // A version downloaded earlier is put to use on this launch, before anything is shown.
  if ((await applyWaitingVersion()) === 'reloading') return;
  registerServiceWorker();
  try {
    await loadAll();
  } catch (e) {
    document.getElementById('app').replaceChildren(h('main.main', h('div.banner.bad',
      `This phone's storage could not be opened, so nothing can be logged safely: ${e && e.message ? e.message : e}`)));
    return;
  }
  await firstRunPersist();
  await autoClose(false);
  state.view = state.open ? 'workout' : 'home';
  render();
  sync.onChange(onSync);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onFront(); });
  window.addEventListener('pageshow', e => { if (e.persisted) onFront(); });
  window.addEventListener('online', () => { refreshSetup(false); sync.uploadAll(); });
  setInterval(tick, 250);
  if (state.settings.token) {
    refreshSetup(false).finally(() => sync.uploadAll());
  } else {
    sync.uploadAll();
  }
}

function defaultOwner() {
  const host = location.hostname || '';
  return host.endsWith('.github.io') ? host.split('.')[0] : '';
}

async function loadAll() {
  const s = (await db.kvGet('settings')) || {};
  let changed = false;
  if (s.owner === undefined) { s.owner = defaultOwner(); changed = true; }
  if (s.repo === undefined) { s.repo = 'gym-log-data'; changed = true; }
  if (s.token === undefined) { s.token = ''; changed = true; }
  if (changed) await db.kvPut('settings', s);
  state.settings = s;
  state.setup = (await db.kvGet('setup')) || null;
  state.meta = (await db.kvGet('meta')) || {};
  state.setupCheckedAt = (await db.kvGet('setupCheckedAt')) || null;
  await loadSessions();
}

async function loadSessions() {
  state.recs = await db.sessionAll();
  const open = state.recs.filter(r => r.doc.status === 'open').sort((a, b) => U.ms(b.doc.started_at) - U.ms(a.doc.started_at));
  state.open = open[0] || null;
  if (state.open && (!state.open.snapshot || !state.open.slots || !state.open.ui)) {
    // A session restored from GitHub while still open: give it the setup it needs.
    const r = U.clone(state.open);
    const exs = U.clone((state.setup && state.setup.exercises) || []);
    for (const e of M.exercisesFromSets(r.doc)) if (!exs.find(x => x.id === e.id)) exs.push(e);
    const wk = state.setup && r.doc.workout_name ? state.setup.workouts.find(w => w.name === r.doc.workout_name) : null;
    r.snapshot = { published_at: (state.setup && state.setup.published_at) || '', groups: U.clone((state.setup && state.setup.groups) || []), exercises: exs, workout: wk ? U.clone(wk) : null };
    r.slots = r.slots && r.slots.length ? r.slots : M.deriveSlots(r.doc, state.setup);
    const last = M.lastLogged(r.doc);
    r.ui = { current: last ? last.position : (r.slots[0] ? r.slots[0].position : null), draft: null, stopwatch: null };
    await saveRec(r, false);
  }
}

async function firstRunPersist() {
  if (state.meta.persist_asked) return;
  let granted = null;
  try { if (navigator.storage && navigator.storage.persist) granted = await navigator.storage.persist(); } catch { granted = null; }
  state.meta = { ...state.meta, persist_asked: U.isoLocal(), persist_result: granted };
  try { await db.kvPut('meta', state.meta); } catch { /* shown in Settings anyway */ }
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
    state.swReg = reg;
    // A version that finished downloading after start-up waits for the next launch.
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) {
          state.swUpdateReady = true;
          if (state.view === 'settings') render();
        }
      });
    });
  } catch { /* the app still works online without it */ }
}

/**
 * Cold start only: if a new version is waiting, let it take over and reload once so this
 * launch already uses the new files.  Runs before the first screen is drawn; never reloads
 * after that or after any input, and a marker in IndexedDB stops a reload loop.
 * Returns 'reloading' when the page is about to reload.
 */
async function applyWaitingVersion() {
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return null;
  let reg;
  try { reg = await navigator.serviceWorker.getRegistration(); } catch { return null; }
  if (!reg || !reg.waiting) return null;
  let marker = null;
  try { marker = await db.kvGet('swReload'); } catch { marker = null; }
  const mayReload = !(marker && marker.from === U.APP_VERSION);
  const took = new Promise(resolve => {
    navigator.serviceWorker.addEventListener('controllerchange', () => resolve(true), { once: true });
    setTimeout(() => resolve(false), 3000);
  });
  reg.waiting.postMessage({ type: 'SKIP_WAITING' });
  if (!mayReload) return null;
  if (!(await took) || firstRendered || inputSeen) return null;
  try { await db.kvPut('swReload', { from: U.APP_VERSION, at: U.isoLocal() }); } catch { return null; }
  location.reload();
  return 'reloading';
}

let lastFront = 0;
let lastUpdateCheck = Date.now();
const UPDATE_CHECK_MS = 60 * 60 * 1000;
async function onFront() {
  // iOS may have closed the database connection while the app was in the background:
  // a cheap read replaces a dead connection now, not on the user's first tap.
  await db.ping();
  const changed = await autoClose(true);
  if (changed) render();
  if (Date.now() - lastFront > 60000) { lastFront = Date.now(); refreshSetup(false); }
  sync.uploadAll();
  // Look for a new app version at most once an hour; it downloads quietly and waits.
  if (state.swReg && Date.now() - lastUpdateCheck > UPDATE_CHECK_MS) {
    lastUpdateCheck = Date.now();
    state.swReg.update().catch(() => {});
  }
}

// ======================================================================
// Persistence
// ======================================================================

/** Write a session record.  Keeps the uploader's fields (sha, everSent) from the stored copy. */
async function saveRec(rec, docChanged) {
  const stored = await db.sessionUpdate(rec.id, s => ({
    ...rec,
    sha: s ? s.sha : rec.sha,
    everSent: !!((s && s.everSent) || rec.everSent),
    dirty: docChanged ? true : (s ? s.dirty : rec.dirty),
  }));
  const i = state.recs.findIndex(r => r.id === stored.id);
  if (i >= 0) state.recs[i] = stored; else state.recs.push(stored);
  if (stored.doc.status === 'open') state.open = stored;
  else if (state.open && state.open.id === stored.id) state.open = null;
  return stored;
}

async function dropRec(id) {
  await db.sessionDel(id);
  state.recs = state.recs.filter(r => r.id !== id);
  if (state.open && state.open.id === id) state.open = null;
}

/** Brief 5.10: an open session idle for more than two hours closes itself. */
async function autoClose(announce) {
  let changed = false;
  for (const r of await db.sessionAll()) {
    if (r.doc.status !== 'open' || !M.isStale(r.doc)) continue;
    if (!r.doc.sets.length) {
      if (!r.everSent) await dropRec(r.id);
      else await saveRec(M.withDeleted(r), true);
    } else {
      await saveRec(M.withAutoClosed(r), true);
    }
    changed = true;
  }
  if (changed) {
    await loadSessions();
    state.entry = null;
    if (!state.open && state.view === 'workout') { closeSheet(); closeDialogs(); state.view = 'home'; }
    if (announce) toast('The open workout was closed: no set for two hours');
    sync.uploadAll();
  }
  return changed;
}

// ======================================================================
// Sync events
// ======================================================================

async function onSync(ev) {
  // A request that succeeds after a failed one is the evidence that the connection has returned.
  if (ev.type === 'reconnected' && ev.before === 'offline') { refreshSetup(false); sync.uploadAll(); }
  if (ev.type === 'setup') {
    state.setup = (await db.kvGet('setup')) || null;
    state.setupCheckedAt = (await db.kvGet('setupCheckedAt')) || null;
  }
  if (ev.type === 'queue' || ev.type === 'net') await refreshSyncFields();
  if (ev.type === 'setup' && (state.view === 'home' || state.view === 'settings')) render();
  else if (ev.type === 'queue' && (state.view === 'home' || state.view === 'history')) render();
  else renderStrip();
}

/** Pick up the uploader's changes (sha, dirty) without touching session content held on screen. */
async function refreshSyncFields() {
  const all = await db.sessionAll();
  const byId = new Map(all.map(r => [r.id, r]));
  for (const r of state.recs) {
    const s = byId.get(r.id);
    if (s && s.doc.revision === r.doc.revision) { r.sha = s.sha; r.dirty = s.dirty; r.everSent = s.everSent; }
  }
  for (const s of all) if (!state.recs.find(r => r.id === s.id)) state.recs.push(s);
  if (state.open) {
    const s = byId.get(state.open.id);
    if (s && s.doc.revision === state.open.doc.revision) { state.open.sha = s.sha; state.open.dirty = s.dirty; state.open.everSent = s.everSent; }
  }
}

let lastSetupTry = 0;
async function refreshSetup(manual) {
  if (!state.settings.token) return null;
  if (!manual && Date.now() - lastSetupTry < 15000) return null;
  lastSetupTry = Date.now();
  let r = null;
  try {
    r = await sync.refreshSetup();
    state.setupCheckedAt = (await db.kvGet('setupCheckedAt')) || state.setupCheckedAt;
    if (r.result === 'changed') state.setup = (await db.kvGet('setup')) || state.setup;
    state.setupProblem = (r.result === 'newer' || r.result === 'bad') ? r.message : (r.result === 'missing' ? 'There is no setup.json in the data repository yet.  Run Sync on the Mac.' : '');
    if (!state.recs.length) state.offerRestore = true;
    if (manual) {
      if (r.result === 'changed') toast('Setup refreshed');
      else if (r.result === 'same') toast('Setup is up to date');
      else toast(state.setupProblem || 'Setup not changed');
    }
  } catch (e) {
    if (manual) toast(e.kind === 'offline' ? 'Offline: setup not refreshed' : `Setup not refreshed: ${e.message}`);
  }
  if (state.view === 'home' || state.view === 'settings') render(); else renderStrip();
  return r;
}

// ======================================================================
// Rendering
// ======================================================================

const views = { home: homeView, workout: workoutView, history: historyView, session: sessionView, settings: settingsView };

function render() {
  const app = document.getElementById('app');
  if (state.view === 'workout' && !state.open) state.view = 'home';
  const old = app.querySelector('.main');
  const keep = old && app.dataset.view === state.view ? old.scrollTop : 0;
  app.replaceChildren(...views[state.view]());
  app.dataset.view = state.view;
  firstRendered = true;
  const main = app.querySelector('.main');
  if (main) main.scrollTop = keep;
  if (state.view === 'workout' && state.scrollToCurrent) {
    state.scrollToCurrent = false;
    const list = app.querySelector('.setlist');
    const row = list && (list.querySelector('.set.active') || list.lastElementChild);
    if (list && row) list.scrollTop = Math.max(0, row.offsetTop + row.offsetHeight - list.clientHeight + 8);
  }
}

function go(view) {
  closeSheet();
  if (view === 'workout') state.scrollToCurrent = true;
  state.view = view;
  document.getElementById('app').dataset.view = '';   // a new screen starts at the top
  render();
}

// ---- Strip (brief 5.12) ----

function stripInfo() {
  const q = sync.queueInfo(state.recs);
  const saved = q.sessions ? (q.sets ? `${U.plural(q.sets, 'set', 'sets')} saved on phone` : `${U.plural(q.sessions, 'change', 'changes')} waiting`) : '';
  const st = sync.net.state;
  if (!state.settings.token) return { cls: q.sessions ? 'waiting' : '', b: 'Not connected', rest: saved ? ` · ${saved}` : ' · add a token in Settings', action: true };
  if (st === 'auth') return { cls: 'bad', b: 'GitHub refused the token.', rest: '  Sets are safe on the phone.  Open Settings to replace it.', action: true };
  if (st === 'error') return { cls: 'bad', b: 'Upload problem.', rest: ` ${sync.net.message}`, action: true };
  if (st === 'offline') return { cls: 'offline', b: 'Offline', rest: saved ? ` · ${saved}` : ' · nothing waiting' };
  if (q.sessions) return { cls: 'waiting', b: sync.net.uploading ? 'Uploading' : 'Waiting', rest: ` · ${saved}` };
  if (st === 'online') return { cls: 'ok', b: 'All uploaded', rest: '' };
  return { cls: '', b: 'Connecting', rest: '' };
}

function stripEl() {
  const i = stripInfo();
  const right = state.setup ? `Setup published ${U.dayMonTime(state.setup.published_at)}` : 'No setup yet';
  const kids = [
    h('span.left', h('span.dot'), h('span', h('b', i.b), i.rest)),
    h('span.right', right),
  ];
  const attrs = { id: 'strip', class: i.cls, 'data-state': sync.net.state, 'data-waiting': String(sync.queueInfo(state.recs).sessions) };
  // The strip is the way to Settings from any screen (also mid-workout), so it is a full-size button.
  if (state.view !== 'settings') {
    return h('button.strip', { ...attrs, type: 'button', 'aria-label': `${i.b}${i.rest}.  Open Settings`, onclick: () => openSettings() }, kids);
  }
  return h('div.strip', attrs, kids);
}

function renderStrip() {
  const old = document.getElementById('strip');
  if (old) old.replaceWith(stripEl());
  const q = document.getElementById('queue-row');
  if (q) q.textContent = queueRowText();
}

function queueRowText() {
  return `${U.plural(state.recs.length, 'session', 'sessions')} on the phone · ${U.plural(sync.queueInfo(state.recs).sessions, 'session', 'sessions')} waiting to upload`;
}

function openSettings() {
  if (state.view !== 'settings') state.backTo = state.view;
  state.connText = '';
  go('settings');
  if (state.settings.token) runConnectionTest();
}

// ======================================================================
// Home
// ======================================================================

function homeView() {
  const setup = state.setup;
  const q = sync.queueInfo(state.recs);
  const items = [];
  if (!setup) items.push(h('div.banner', { 'data-banner': 'nosetup' }, 'No setup yet.  Connect and refresh in Settings.'));
  if (state.setupProblem) items.push(h('div.banner.bad', { 'data-banner': 'setup-problem' }, state.setupProblem));
  if (state.offerRestore && !state.recs.length && state.settings.token) {
    items.push(h('div.banner', { 'data-banner': 'restore' },
      'There are no sessions on this phone.  Download your history from GitHub?',
      h('div.btnrow',
        h('button.btn.secondary', { type: 'button', onclick: () => { state.offerRestore = false; render(); } }, 'Not now'),
        h('button.btn.primary', { type: 'button', 'data-action': 'restore', disabled: state.restoring, onclick: doRestore }, state.restoring ? 'Downloading…' : 'Download history'))));
  }
  const open = state.open;
  if (open) {
    const d = open.doc;
    items.unshift(h('button.choice.resume', { type: 'button', 'data-action': 'resume', onclick: () => go('workout') },
      h('div.info', h('div.name', `Resume ${d.workout_name || 'Free-form'}`),
        h('div.meta', `${U.plural(d.sets.length, 'set', 'sets')} logged · started ${U.hhmm(d.started_at)}`)),
      h('span.go', '›')));
  }
  if (setup) {
    items.push(h('div.section-title', 'Start a workout'));
    if (open) items.push(h('p.hint', { 'data-hint': 'one-open' }, 'End the open workout to start another.'));
    const hist = history();
    for (const w of setup.workouts) {
      const last = hist.find(d => d.workout_name === w.name);
      const n = w.items.length;
      items.push(h('button.choice', { type: 'button', 'data-workout': w.name, disabled: !!open, onclick: () => startWorkout(w.name) },
        h('div.info', h('div.name', w.name),
          h('div.meta', `${U.plural(n, 'exercise', 'exercises')} · ${last ? `last done ${U.dayMon(last.started_at)}` : 'not done yet'}`)),
        h('span.go', '›')));
    }
    items.push(h('button.choice', { type: 'button', 'data-workout': '', disabled: !!open, onclick: () => startWorkout(null) },
      h('div.info', h('div.name', 'Free-form'), h('div.meta', 'Choose exercises as you go')),
      h('span.go', '›')));
  }
  items.push(h('p.hint', { 'data-queue': String(q.sessions) },
    q.sessions ? `${U.plural(q.sessions, 'session', 'sessions')} waiting to upload` : 'No sessions waiting to upload'));
  // The setup's age is in the strip below; the header only carries the name.
  return [
    h('header.head', h('div.titles', h('h1', 'Swole'))),
    stripEl(),
    h('main.main', items),
    h('nav.navrow',
      h('button.btn.secondary', { type: 'button', 'data-nav': 'history', onclick: () => go('history') }, 'History'),
      h('button.btn.secondary', { type: 'button', 'data-nav': 'settings', onclick: openSettings }, 'Settings')),
  ];
}

async function startWorkout(name) {
  if (state.open) return go('workout');
  if (!state.setup) return;
  const rec = M.newSession(state.setup, name);
  try { await saveRec(rec, true); } catch (e) { return storageFailed('The workout could not be started', e); }
  state.entry = null;
  go('workout');
  if (!name) openAddExercise(null);
}

async function doRestore() {
  if (state.restoring) return;
  state.restoring = true;
  render();
  try {
    const r = await sync.restore();
    await loadSessions();
    await autoClose(false);
    state.offerRestore = false;
    toast(`Downloaded ${U.plural(r.added, 'session', 'sessions')}`);
    if (r.skipped.length) await messageBox({ title: 'Some files were skipped', text: r.skipped.join('\n') });
  } catch (e) {
    toast(e.kind === 'offline' ? 'Offline: nothing downloaded' : `Download failed: ${e.message}`);
  }
  state.restoring = false;
  render();
}

async function storageFailed(what, e) {
  await messageBox({ title: 'Not saved', text: `${what}: the phone's storage refused the write (${e && e.message ? e.message : e}).  Nothing was recorded.`, id: 'storage-failed' });
}

// ======================================================================
// Active Workout (mockup a)
// ======================================================================

function curSlot() { return state.open ? M.slotByPos(state.open, state.open.ui.current) : null; }

function elapsedText(doc) {
  const min = Math.max(0, Math.floor((Date.now() - U.ms(doc.started_at)) / 60000));
  return `Started ${U.hhmm(doc.started_at)} · ${min} min`;
}

function planText(slot, ex, long) {
  const p = M.slotPlanned(slot);
  if (p === null) return state.open && state.open.doc.workout_name ? 'added' : '';
  const t = U.targetText(ex.measure, slot.target_min, slot.target_max);
  return `${long ? U.plural(p, 'set', 'sets') : p}${t ? ` × ${t}` : ''}`;
}

function workoutView() {
  const rec = state.open;
  const doc = rec.doc;
  const slot = curSlot();
  const order = [...rec.slots].sort((a, b) => a.position - b.position);
  const idx = slot ? order.findIndex(s => s.position === slot.position) + 1 : 0;
  const exBtn = h('button.exlist', {
    type: 'button', 'data-action': 'exercises', disabled: !order.length, onclick: openExercises,
    'aria-label': order.length ? `Exercises, ${idx} of ${order.length}.  Show all` : 'No exercises yet',
  }, order.length ? `Exercises ${idx} of ${order.length}` : 'No exercises yet', h('i', '▾'));
  return [
    h('header.head.workout',
      h('button.back.home', { type: 'button', 'data-action': 'home', 'aria-label': 'Home (the workout stays open)', onclick: () => go('home') }, '‹ Home'),
      h('div.titles', h('h1', doc.workout_name || 'Free-form')),
      h('button.end', { type: 'button', 'data-action': 'end', onclick: endWorkout }, 'End Workout')),
    h('div.subhead', exBtn, h('span', { id: 'elapsed' }, elapsedText(doc))),
    stripEl(),
    h('main.main.focus', slot ? currentCard(slot) : h('div.ex.current.fill.empty', h('p.hint', 'No exercises yet.  Use + Add exercise below.'))),
    dockEl(),
  ];
}

/** Progress of a slot for lists: "3 of 3 sets", "1 of 3 sets", "2 sets", "not started". */
function progressText(rec, slot) {
  const n = M.slotSets(rec.doc, slot.position).length;
  const p = M.slotPlanned(slot);
  if (!n) return 'not started';
  return p ? `${n} of ${p} sets` : U.plural(n, 'set', 'sets');
}

/** The "Exercises" panel: every exercise in the session, in order; tap one to make it current. */
function openExercises() {
  const rec = state.open;
  if (!rec) return;
  const order = [...rec.slots].sort((a, b) => a.position - b.position);
  openSheet('exercises', [
    h('h2', 'Exercises'),
    h('p.sub', `${U.plural(order.length, 'exercise', 'exercises')} in this workout.  Tap one to do it now.`),
    order.map(slot => {
      const ex = exOf(rec, slot.exercise_id);
      const done = M.slotComplete(rec, slot);
      const cur = slot.position === rec.ui.current;
      const meta = [progressText(rec, slot), planText(slot, ex, false)].filter(Boolean).join(' · ');
      return h(`button.opt.slot-opt${cur ? '.current' : ''}`, { type: 'button', 'data-slot': String(slot.position), 'aria-current': cur ? 'true' : null,
        onclick: async () => { await makeCurrent(slot.position); closeSheet(); } },
        h(`div.num${done ? '.done' : cur ? '.now' : ''}`, done ? '✓' : String(slot.position)),
        h('div.info', h('div.name', ex.name, cur ? h('span.tag.now', 'now') : null), h('div.hist', meta)));
    }),
    h('button.cancel', { type: 'button', 'data-action': 'cancel', onclick: closeSheet }, 'Cancel'),
  ]);
}

function shortSet(s) {
  if (!s) return '';
  const v = s.measure === 'time' ? `${U.num(s.duration_s)} s` : U.num(s.reps);
  if (s.type === 'bodyweight' && !(s.weight_kg > 0) && s.measure === 'time') return v;
  return `${U.weightShort(s.type, s.weight_kg)} × ${v}`;
}

function currentCard(slot) {
  const rec = state.open;
  const ex = exOf(rec, slot.exercise_id);
  const sets = M.slotSets(rec.doc, slot.position);
  const target = M.slotTarget(slot);
  const complete = M.slotComplete(rec, slot);
  const lt = M.lastTime(history(), ex.id);
  const swapped = slot.planned_exercise_id && slot.planned_exercise_id !== slot.exercise_id;
  const meta = [ex.group, ex.type, planText(slot, ex, true)].filter(Boolean).join(' · ') + (swapped ? ` · instead of ${slot.planned_exercise_name}` : '');
  const notes = [];
  if (ex.note) notes.push(h('div', h('span', 'Note'), ex.note));
  if (slot.comment) notes.push(h('div', h('span', 'Today'), slot.comment));
  const rows = sets.map(s => h('button.set.done', { type: 'button', 'data-set': s.set_id, onclick: () => openEditSet(rec.id, s.set_id) },
    h('span.n', `Set ${s.set_number}`),
    h('span.v', shortOrFull(s), rirEl(s), s.exercise_id !== slot.exercise_id ? h('span.other', ` · ${s.exercise_name}`) : null),
    h('span.t', `${U.hhmm(s.logged_at)} · tap to edit`)));
  if (!complete) {
    const n = sets.length + 1;
    const e = ensureEntry(slot);
    rows.push(h('div.set.active', h('span.n', `Set ${n}`), h('span.v', { id: 'active-v' }, entryText(ex, e)), h('span.t', 'now')));
    // Sets still to come (an unplanned slot counts 3 inside the app, v1.1.0).
    for (let k = n + 1; k <= target; k++) {
      const ls = lt && lt.sets[k - 1];
      rows.push(h('div.set.todo', h('span.n', `Set ${k}`), h('span.v', ls ? shortOrFull(ls) : ''), h('span.t', ls ? 'last time' : '')));
    }
  }
  const next = M.nextOpenSlot(rec, slot.position);
  let nextEl;
  if (next) {
    const nex = exOf(rec, next.exercise_id);
    const plan = planText(next, nex, false);
    nextEl = h('button.next', { type: 'button', 'data-action': 'next', 'data-slot': String(next.position), onclick: () => goNext(next.position) },
      h('span.k', 'Next:'), h('span.v', `${nex.name}${plan ? ` · ${plan}` : ''}`), h('i', '›'));
  } else {
    const anyPlanned = rec.slots.some(s => M.slotPlanned(s) !== null);
    nextEl = h('div.next.none', { 'data-next': 'none' }, h('span.k', 'Next:'),
      h('span.v', anyPlanned ? 'nothing left — all planned sets logged' : 'add another exercise below when ready'));
  }
  return h('div.ex.current.fill', { 'data-slot': String(slot.position) },
    h('div.toprow',
      h('div.num.now', String(slot.position)),
      h('div.info', h('div.name', ex.name), h('div.meta', meta)),
      h('button.swap', { type: 'button', 'data-action': 'swap', onclick: openSwap }, h('i', '⇄'), ' Swap')),
    notes.length ? h('div.notes', notes) : null,
    h('div.lasttime', lt ? `Last time ${U.dayMon(lt.started_at)} · ${U.compactSets(lt.sets, false)}` : 'Not done before'),
    h('div.setlist', rows,
      h('button.addset', { type: 'button', 'data-action': 'add-set', onclick: () => addExtraSet(slot.position) }, '+ Set')),
    nextEl);
}

function shortOrFull(s) { return U.setText(s.type, s.measure, s.weight_kg, valueOf(s)); }

/** " · RIR 2" or " · F" after a set's figures, only where recorded (v1.1.0). */
function rirEl(s) {
  const t = U.rirShort(s);
  return t ? h('span.rir', { 'data-rir': t }, ` · ${t}`) : null;
}

function tankText(measure) { return measure === 'time' ? 'time left in the tank' : 'reps left in the tank'; }

function entryText(ex, e) {
  if (e.weight === null || e.weight === undefined || !e.value) return '–';
  return U.setText(ex.type, ex.measure, e.weight, e.value);
}

function ensureEntry(slot) {
  const rec = state.open;
  const n = M.nextSetNumber(rec, slot);
  const key = `${slot.position}|${n}|${slot.exercise_id}`;
  if (state.entry && state.entry.key === key) return state.entry;
  const d = rec.ui.draft;
  if (d && d.key === key) state.entry = { key, weight: d.weight, value: d.value };
  else {
    const p = M.prefill(rec, slot, history());
    state.entry = { key, weight: p.weight, value: p.value };
  }
  return state.entry;
}

function canLog(e) { return e && e.weight !== null && e.weight !== undefined && e.value !== null && e.value !== undefined && e.value > 0; }

function dockEl() {
  const rec = state.open;
  const slot = curSlot();
  const anySets = rec.doc.sets.length > 0;
  const minor = h('div.minor',
    h('button', { type: 'button', 'data-action': 'undo', disabled: !anySets, onclick: undoLast }, 'Undo last set'),
    h('button', { type: 'button', 'data-action': 'add-exercise', onclick: () => openAddExercise(null) }, '+ Add exercise'));
  if (!slot) {
    return h('section.dock', { 'data-dock': 'empty' },
      h('div.title', h('b', rec.doc.workout_name || 'Free-form'), h('span', '')),
      h('p.msg', 'Add an exercise to start logging.'),
      h('button.log', { type: 'button', 'data-action': 'add-first', onclick: () => openAddExercise(null) }, '+ Add exercise'),
      minor);
  }
  const ex = exOf(rec, slot.exercise_id);
  const aim = M.slotTarget(slot);
  if (M.slotComplete(rec, slot)) {
    // Done state (v1.0.1, RIR row v1.1.0): the exercise stays current after its last planned set.
    // Next takes the Log button's place.  Where the weight and reps steppers were: the RIR of the
    // last set (left) and + Extra set (right).  All of them ignore taps for a second after a log.
    // The RIR lives on the last set only: logging an extra set moves it there (v1.1.1, see
    // M.withLoggedSet); the + Extra set tap itself changes no RIR.
    const n = M.slotSets(rec.doc, slot.position).length;
    const ps = M.slotBase(slot);
    const status = n > ps ? `${n} sets done (${ps} planned)` : `${n} of ${ps} sets done`;
    const next = M.nextOpenSlot(rec, slot.position);
    const last = M.slotLastSet(rec.doc, slot.position);
    const rir = rirStepper({
      label: `RIR · Set ${last.set_number}`, value: U.rirCode(last), name: 'rir', small: tankText(last.measure),
      guard: guarded, onChange: code => changeRir(last.set_id, code),
    });
    const extra = h('button.btn.secondary.extracard', { type: 'button', 'data-action': 'extra-set', onclick: () => addExtraSet(slot.position) }, '+ Extra set');
    const row = h('div.steps.donerow', rir, extra);
    if (next) {
      const nex = exOf(rec, next.exercise_id);
      return h('section.dock', { 'data-dock': 'complete' },
        h('p.donestate', { 'data-done': 'next' }, `${status} · ${ex.name}`),
        row,
        h('button.log.nextbtn', { type: 'button', 'data-action': 'next-dock', 'data-slot': String(next.position), onclick: () => goNext(next.position) },
          h('span.lbl', 'Next: '), h('span.nm', nex.name), h('i', ' ›')),
        minor);
    }
    return h('section.dock', { 'data-dock': 'complete' },
      h('p.donestate', { 'data-done': 'all' }, h('b', 'All planned sets logged'), h('span', `${status} · ${ex.name}`)),
      row,
      minor);
  }
  const e = ensureEntry(slot);
  const n = M.nextSetNumber(rec, slot);
  const lt = M.lastTime(history(), ex.id);
  const hint = lt ? (lt.sets[n - 1] ? `last time ${shortSet(lt.sets[n - 1])}` : 'last time –') : 'not done before';
  const inc = Number(ex.increment_kg) > 0 ? Number(ex.increment_kg) : 1;
  const target = U.targetText(ex.measure, slot.target_min, slot.target_max);
  const logBtn = h('button.log', { type: 'button', 'data-action': 'log', onclick: logSet });
  const updateLog = () => {
    logBtn.replaceChildren(...[`Log Set ${n}`, canLog(e) ? h('span', U.setText(ex.type, ex.measure, e.weight, e.value)) : null].filter(Boolean));
    logBtn.disabled = !canLog(e);
    const av = document.getElementById('active-v');
    if (av) av.textContent = entryText(ex, e);
  };
  const changed = () => { updateLog(); saveDraft(); };
  const left = stepper({ label: U.weightLabel(ex.type), value: e.weight, step: inc, kind: 'weight', name: 'weight', small: `step ${U.num(inc)} kg`, onChange: v => { e.weight = v; changed(); } });
  const right = ex.measure === 'time'
    ? stepper({ label: 'Seconds', value: e.value, step: 5, kind: 'secs', name: 'seconds', small: target ? `target ${target}` : 'steps of 5 s', onChange: v => { e.value = v; changed(); } })
    : stepper({ label: 'Reps', value: e.value, step: 1, kind: 'reps', name: 'reps', small: target ? `target ${target.replace(' reps', '')}` : '', onChange: v => { e.value = v; changed(); } });
  updateLog();
  let watch = null;
  if (ex.measure === 'time') {
    const sw = rec.ui.stopwatch;
    watch = h(`button.watch${sw ? '.running' : ''}`, { type: 'button', 'data-action': 'stopwatch', onclick: toggleWatch },
      h('i', sw ? '■' : '▶'), h('span', { id: 'watch-text' }, sw ? `Stop · ${clockText(Date.now() - sw.startedAt)}` : 'Start stopwatch'));
  }
  return h('section.dock', { 'data-dock': 'entry' },
    h('div.title', h('b', `Set ${n} of ${aim} · ${ex.name}`), h('span', hint)),
    h('div.steps', left, right),
    watch,
    logBtn,
    minor);
}

function clockText(msv) {
  const s = Math.max(0, Math.floor(msv / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function tick() {
  if (state.view !== 'workout' || !state.open) return;
  const el = document.getElementById('elapsed');
  if (el) { const t = elapsedText(state.open.doc); if (el.textContent !== t) el.textContent = t; }
  const sw = state.open.ui.stopwatch;
  const wt = document.getElementById('watch-text');
  if (sw && wt) wt.textContent = `Stop · ${clockText(Date.now() - sw.startedAt)}`;
}

let draftChain = Promise.resolve();
function saveDraft() {
  const rec = state.open;
  if (!rec || !state.entry) return;
  const draft = { key: state.entry.key, weight: state.entry.weight, value: state.entry.value };
  draftChain = draftChain.then(() => {
    if (!state.open || state.open.id !== rec.id) return;
    return saveRec({ ...state.open, ui: { ...state.open.ui, draft } }, false);
  }).catch(() => { /* a lost draft only loses typing, never a set */ });
}

/** Wait for typed figures and RIR taps already on their way to storage. */
async function settle() { await draftChain; await rirChain; }

async function saveUi(rec) {
  await settle();
  try { await saveRec(rec, false); } catch (e) { return storageFailed('The change could not be saved', e); }
}

async function logSet() {
  const t = Date.now();
  if (state.busy || t - state.lastLogAt < 1000) return;   // double-tap guard (5.7)
  const rec = state.open;
  const slot = curSlot();
  const e = state.entry;
  if (!rec || !slot || !canLog(e)) return;
  state.busy = true;
  state.lastLogAt = t;
  const ex = exOf(rec, slot.exercise_id);
  const n = M.nextSetNumber(rec, slot);
  try {
    await settle();
    const { rec: next } = M.withLoggedSet(state.open, slot.position, e.weight, e.value);
    await saveRec(next, true);      // write first: shown as logged only after this resolves
  } catch (err) {
    state.busy = false;
    state.lastLogAt = 0;
    await storageFailed(`Set ${n} of ${ex.name} (${U.setText(ex.type, ex.measure, e.weight, e.value)}) was not saved`, err);
    return;
  }
  state.busy = false;
  state.entry = null;
  state.scrollToCurrent = true;
  render();
  sync.uploadAll();
}

async function toggleWatch() {
  const rec = state.open;
  if (!rec || !state.entry) return;
  const sw = rec.ui.stopwatch;
  if (!sw) {
    await saveUi({ ...rec, ui: { ...rec.ui, stopwatch: { startedAt: Date.now(), key: state.entry.key } } });
  } else {
    const secs = Math.max(1, Math.round((Date.now() - sw.startedAt) / 1000));
    state.entry.value = secs;
    await saveUi({ ...rec, ui: { ...rec.ui, stopwatch: null, draft: { key: state.entry.key, weight: state.entry.weight, value: secs } } });
  }
  render();
}

async function makeCurrent(pos) {
  if (!state.open) return;
  await settle();
  if (state.open.ui.current !== pos) state.entry = null;
  await saveUi(M.withCurrent(state.open, pos));
  state.scrollToCurrent = true;
  render();
}

/** True within a second of a logged set: Next / + Extra set sit where Log was (double-tap guard, 5.7). */
function guarded() { return Date.now() - state.lastLogAt < 1000 || state.busy; }

async function goNext(pos) {
  if (guarded()) return;
  await makeCurrent(pos);
}

async function addExtraSet(pos) {
  if (guarded()) return;
  await settle();
  state.entry = null;
  await saveUi(M.withExtraSet(state.open, pos));
  state.scrollToCurrent = true;
  render();
}

/**
 * A tap on the done state's RIR stepper: rewrite that set's rir/failed at once (one saved change,
 * upload queued).  Taps are written in order; the screen is redrawn once the last one is stored.
 */
let rirChain = Promise.resolve();
let rirPending = 0;
function changeRir(setId, code) {
  const recId = state.open && state.open.id;
  if (!recId) return;
  rirPending++;
  rirChain = rirChain.then(async () => {
    await draftChain;
    if (!state.open || state.open.id !== recId || !state.open.doc.sets.find(s => s.set_id === setId)) return;
    try {
      await saveRec(M.withRir(state.open, setId, code), true);
    } catch (e) {
      rirPending = 0;
      await storageFailed('The RIR could not be saved', e);
      render();
      return;
    }
    sync.uploadAll();
  }).finally(() => {
    rirPending = Math.max(0, rirPending - 1);
    if (!rirPending && state.view === 'workout') render();
  });
}

async function undoLast() {
  const rec = state.open;
  const last = rec && M.lastLogged(rec.doc);
  if (!last) return;
  const r = await confirmBox({ title: `Remove the last set (${shortOrFull(last)})?`, text: `Set ${last.set_number} of ${last.exercise_name}.`, ok: 'Remove', id: 'undo' });
  if (!r.ok || !state.open || state.open.id !== rec.id) return;
  await settle();
  try { await saveRec(M.withUndo(state.open), true); } catch (e) { return storageFailed('The set could not be removed', e); }
  state.entry = null;
  state.scrollToCurrent = true;
  render();
  sync.uploadAll();
}

async function endWorkout() {
  const rec = state.open;
  if (!rec) return;
  const n = rec.doc.sets.length;
  const r = await confirmBox({
    title: 'End workout?',
    text: n ? `${U.plural(n, 'set', 'sets')} logged` : 'No sets logged, so nothing will be kept.',
    ok: 'End', danger: false, id: 'end',
    input: n ? { label: 'Session comment', placeholder: 'Comment (optional)', value: rec.doc.comment } : null,
  });
  if (!r.ok || !state.open || state.open.id !== rec.id) return;
  await settle();
  try {
    if (!n) {
      const fresh = await db.sessionGet(rec.id);
      if (fresh && fresh.everSent) await saveRec(M.withDeleted(state.open), true); else await dropRec(rec.id);
    } else {
      await saveRec(M.withEnded(state.open, r.value), true);
    }
  } catch (e) { return storageFailed('The workout could not be ended', e); }
  state.entry = null;
  go('home');
  toast(n ? 'Workout saved' : 'Workout discarded');
  sync.uploadAll();
}

// ---- Swap panel (mockup b) ----

function openSwap() {
  const rec = state.open;
  const slot = curSlot();
  if (!slot) return;
  const ex = exOf(rec, slot.exercise_id);
  const logged = M.slotSets(rec.doc, slot.position);
  const planned = M.slotPlanned(slot);
  const later = new Set(rec.slots
    .filter(s => s.position !== slot.position && M.slotSets(rec.doc, s.position).length === 0 && M.slotPlanned(s) !== null)
    .map(s => s.exercise_id));
  const hist = history();
  const others = rec.snapshot.exercises.filter(e => e.active && e.group === ex.group && e.id !== ex.id);
  const ordered = [...others.filter(e => !later.has(e.id)), ...others.filter(e => later.has(e.id))];
  let sub = `Other exercises in ${ex.group}.`;
  if (planned) {
    const left = Math.max(0, planned - logged.length);
    sub += `  ${left === 1 ? 'One set' : `${left} sets`} left`;
    sub += logged.length ? `; the ${logged.length === 1 ? 'set' : 'sets'} already logged ${logged.length === 1 ? 'stays' : 'stay'} as ${ex.name}.` : '.';
  } else if (logged.length) {
    sub += `  The ${logged.length === 1 ? 'set' : 'sets'} already logged ${logged.length === 1 ? 'stays' : 'stay'} as ${ex.name}.`;
  }
  const opts = ordered.map(o => {
    const lt = M.lastTime(hist, o.id);
    return h(`button.opt${later.has(o.id) ? '.dimmed' : ''}`, { type: 'button', 'data-ex': o.id, onclick: () => doSwap(o.id) },
      h('div.info',
        h('div.name', o.name, later.has(o.id) ? h('span.tag', 'later today') : null),
        h('div.hist', lt ? `Last ${U.dayMon(lt.started_at)} · ${U.compactSets(lt.sets, true)}` : 'Not done before · starts blank')),
      h('span.chip', o.type));
  });
  openSheet('swap', [
    h('h2', `Swap ${ex.name}`),
    h('p.sub', sub),
    opts.length ? opts : h('p.hint', 'No other active exercises in this group.'),
    h('button.cancel', { type: 'button', 'data-action': 'cancel', onclick: closeSheet }, 'Cancel'),
  ]);
}

async function doSwap(exId) {
  const slot = curSlot();
  await settle();
  state.entry = null;
  await saveUi(M.withSwap(state.open, slot.position, exId));
  render();
  closeSheet();
}

// ---- Add Exercise panel ----

function openAddExercise(group) {
  const rec = state.open;
  if (!rec) return;
  const snap = rec.snapshot;
  const active = snap.exercises.filter(e => e.active);
  const groups = [...snap.groups.filter(g => active.some(e => e.group === g)), ...new Set(active.map(e => e.group).filter(g => !snap.groups.includes(g)))];
  if (!group) {
    openSheet('add', [
      h('h2', 'Add exercise'),
      h('p.sub', 'Choose a group.'),
      groups.map(g => h('button.opt.group-opt', { type: 'button', 'data-group': g, onclick: () => openAddExercise(g) },
        h('div.info', h('div.name', g), h('div.hist', U.plural(active.filter(e => e.group === g).length, 'exercise', 'exercises'))),
        h('span.go', '›'))),
      groups.length ? null : h('p.hint', 'No active exercises in the setup.'),
      h('button.cancel', { type: 'button', 'data-action': 'cancel', onclick: closeSheet }, 'Cancel'),
    ]);
    return;
  }
  const hist = history();
  openSheet('add', [
    h('h2', group),
    h('p.sub', 'Choose an exercise.  It goes to the end of the list.'),
    active.filter(e => e.group === group).map(e => {
      const lt = M.lastTime(hist, e.id);
      return h('button.opt', { type: 'button', 'data-ex': e.id, onclick: () => doAddExercise(e.id) },
        h('div.info', h('div.name', e.name),
          h('div.hist', lt ? `Last ${U.dayMon(lt.started_at)} · ${U.compactSets(lt.sets, true)}` : 'Not done before · starts blank')),
        h('span.chip', e.type));
    }),
    h('div.btnrow',
      h('button.cancel', { type: 'button', 'data-action': 'groups', onclick: () => openAddExercise(null) }, '‹ Groups'),
      h('button.cancel', { type: 'button', 'data-action': 'cancel', onclick: closeSheet }, 'Cancel')),
  ]);
}

async function doAddExercise(exId) {
  await settle();
  state.entry = null;
  await saveUi(M.withAddedExercise(state.open, exId));
  state.scrollToCurrent = true;
  render();
  closeSheet();
}

// ---- Edit Set panel (open or past session) ----

function openEditSet(recId, setId) {
  const rec = state.recs.find(r => r.id === recId);
  const s = rec && rec.doc.sets.find(x => x.set_id === setId);
  if (!s) return;
  const ex = exOf(rec, s.exercise_id);
  const inc = ex && Number(ex.increment_kg) > 0 ? Number(ex.increment_kg) : 1;
  let w = s.weight_kg;
  let v = valueOf(s);
  let rir = U.rirCode(s);
  const save = h('button.btn.primary', { type: 'button', 'data-action': 'save' }, 'Save');
  const upd = () => { save.disabled = w === null || !v; };
  const left = stepper({ label: U.weightLabel(s.type), value: w, step: inc, kind: 'weight', name: 'edit-weight', small: `step ${U.num(inc)} kg`, onChange: x => { w = x; upd(); } });
  const right = s.measure === 'time'
    ? stepper({ label: 'Seconds', value: v, step: 5, kind: 'secs', name: 'edit-seconds', small: 'steps of 5 s', onChange: x => { v = x; upd(); } })
    : stepper({ label: 'Reps', value: v, step: 1, kind: 'reps', name: 'edit-reps', small: '', onChange: x => { v = x; upd(); } });
  // RIR for any set (v1.1.0), with "–" for not recorded, before F.
  const rirEdit = rirStepper({ label: 'RIR', value: rir, name: 'edit-rir', small: tankText(s.measure), allowNone: true, onChange: c => { rir = c; } });
  const rirHelp = h('div.rirhelp',
    h('p.lead', h('b', 'Reps in reserve'), ` (${s.measure === 'time' ? 'time' : 'reps'} left)`),
    h('p', h('span.k', 'F'), 'failed'), h('p', h('span.k', '5+'), 'five or more'), h('p', h('span.k', '–'), 'not recorded'));
  const del = h('button.btn.danger', { type: 'button', 'data-action': 'delete' }, 'Delete');
  save.addEventListener('click', async () => {
    if (w === null || !v) return;
    const cur = state.recs.find(r => r.id === recId);
    if (w === s.weight_kg && v === valueOf(s) && rir === U.rirCode(s)) { closeSheet(); return; }
    await settle();
    try { await saveRec(M.withEditedSet(cur.id === (state.open && state.open.id) ? state.open : cur, setId, w, v, rir === U.rirCode(s) ? undefined : rir), true); }
    catch (e) { return storageFailed('The correction could not be saved', e); }
    closeSheet();
    if (state.open && state.open.id === recId) state.entry = null;
    render();
    toast('Set corrected');
    sync.uploadAll();
  });
  del.addEventListener('click', async () => {
    const r = await confirmBox({ title: `Delete set ${s.set_number} of ${s.exercise_name}?`, ok: 'Delete', id: 'delete-set' });
    if (!r.ok) return;
    const cur = state.open && state.open.id === recId ? state.open : state.recs.find(x => x.id === recId);
    await settle();
    try { await saveRec(M.withDeletedSet(cur, setId), true); } catch (e) { return storageFailed('The set could not be deleted', e); }
    closeSheet();
    if (state.open && state.open.id === recId) state.entry = null;
    render();
    toast('Set deleted');
    sync.uploadAll();
  });
  openSheet('edit', [
    h('h2', `Edit set ${s.set_number}`),
    h('p.sub', `${s.exercise_name} · logged ${U.hhmm(s.logged_at)}${s.edited_at ? ` · corrected ${U.hhmm(s.edited_at)}` : ''}`),
    h('div.steps', left, right),
    h('div.steps.rirrow', rirEdit, rirHelp),
    h('div.btnrow', del, save),
    h('button.cancel', { type: 'button', 'data-action': 'cancel', onclick: closeSheet }, 'Cancel'),
  ]);
}

// ======================================================================
// History
// ======================================================================

function backHead(label, onBack, title, sub) {
  return h('header.head.withback',
    h('button.back', { type: 'button', 'data-action': 'back', onclick: onBack }, `‹ ${label}`),
    h('div.titles', h('h1', title), sub ? h('p', sub) : null));
}

function historyView() {
  const list = state.recs.filter(r => r.doc.status !== 'deleted')
    .sort((a, b) => U.ms(b.doc.started_at) - U.ms(a.doc.started_at));
  const items = [h('p.hint', 'Gym History.xlsx is rebuilt from these sessions at every Sync, so a change made in Excel is overwritten.  Correct sessions here.')];
  for (const r of list) {
    const d = r.doc;
    const chips = [];
    if (d.status === 'open') chips.push(h('span.chip.go', 'Open'));
    if (d.status === 'auto_closed') chips.push(h('span.chip.warn', 'Auto-closed'));
    if (sync.waiting(r)) chips.push(h('span.chip.warn', 'Not uploaded'));
    items.push(h('button.choice.hist-item', { type: 'button', 'data-session': r.id, onclick: () => openSession(r.id) },
      h('div.info', h('div.name', U.longDay(d.started_at)),
        h('div.meta', `${d.workout_name || 'Free-form'} · ${U.plural(d.sets.length, 'set', 'sets')} · ${U.hhmm(d.started_at)}–${d.ended_at ? U.hhmm(d.ended_at) : 'now'}`)),
      chips));
  }
  if (!list.length) items.push(h('p.hint', 'No sessions on this phone yet.'));
  return [backHead('Home', () => go('home'), 'History'), stripEl(), h('main.main.pad-bottom', items)];
}

function openSession(id) {
  const r = state.recs.find(x => x.id === id);
  if (r && r.doc.status === 'open') return go('workout');
  state.detailId = id;
  go('session');
}

function sessionView() {
  const rec = state.recs.find(r => r.id === state.detailId);
  if (!rec || rec.doc.status === 'deleted') { state.view = 'history'; return historyView(); }
  const d = rec.doc;
  const positions = [...new Set(d.sets.map(s => s.position))].sort((a, b) => a - b);
  const cards = positions.map(pos => {
    const sets = M.slotSets(d, pos);
    const first = sets[0];
    const names = [...new Set(sets.map(s => s.exercise_name))];
    const planned = first.planned_exercise_name && !names.includes(first.planned_exercise_name) ? ` · planned ${first.planned_exercise_name}` : '';
    return h('div.slotcard', { 'data-slot': String(pos) },
      h('div.name', names.join(' / ')),
      h('div.meta', `${first.group} · ${first.type}${planned}`),
      sets.map(s => h('button.set.done', { type: 'button', 'data-set': s.set_id, onclick: () => openEditSet(rec.id, s.set_id) },
        h('span.n', `Set ${s.set_number}`),
        h('span.v', shortOrFull(s), rirEl(s), names.length > 1 ? h('span.other', ` · ${s.exercise_name}`) : null),
        h('span.t', `${U.hhmm(s.logged_at)}${s.edited_at ? ' · corrected' : ''}`))));
  });
  const comment = h('textarea.field', { rows: 3, 'aria-label': 'Session comment', name: 'comment', maxlength: 2000, placeholder: 'No comment' });
  comment.value = d.comment || '';
  const saveC = h('button.btn.secondary', { type: 'button', 'data-action': 'save-comment', disabled: true }, 'Save comment');
  comment.addEventListener('input', () => { saveC.disabled = comment.value.trim() === (d.comment || ''); });
  saveC.addEventListener('click', async () => {
    try { await saveRec(M.withComment(rec, comment.value), true); } catch (e) { return storageFailed('The comment could not be saved', e); }
    toast('Comment saved');
    render();
    sync.uploadAll();
  });
  const delBtn = h('button.btn.danger', { type: 'button', 'data-action': 'delete-session' }, 'Delete session');
  delBtn.addEventListener('click', async () => {
    const r = await confirmBox({ title: `Delete the session of ${U.dayMonthLong(d.date)}?`, text: 'Its file stays on GitHub marked as deleted, and Sync removes it from Excel.', ok: 'Delete', id: 'delete-session' });
    if (!r.ok) return;
    try { await saveRec(M.withDeleted(rec), true); } catch (e) { return storageFailed('The session could not be deleted', e); }
    toast('Session deleted');
    go('history');
    sync.uploadAll();
  });
  const status = d.status === 'auto_closed' ? 'Auto-closed' : 'Closed';
  return [
    backHead('History', () => go('history'), d.workout_name || 'Free-form', `${U.longDay(d.started_at)} · ${U.hhmm(d.started_at)}–${d.ended_at ? U.hhmm(d.ended_at) : ''}`),
    stripEl(),
    h('main.main.pad-bottom',
      h('p.hint', `${status} · ${U.plural(d.sets.length, 'set', 'sets')} · revision ${d.revision}${sync.waiting(rec) ? ' · not uploaded yet' : ''}.  Tap a set to correct or delete it.`),
      cards.length ? cards : h('p.hint', 'No sets in this session.'),
      h('div.section-title', 'Comment'),
      comment, saveC,
      h('div.section-title', 'Session'),
      h('p.hint', 'The start time and the workout cannot be changed.'),
      delBtn),
  ];
}

// ======================================================================
// Settings
// ======================================================================

async function saveSettings(patch) {
  const s = { ...state.settings, ...patch };
  await db.kvPut('settings', s);
  state.settings = s;
}

async function runConnectionTest() {
  state.connText = 'Testing…';
  updateConn();
  const r = await sync.testConnection();
  state.connText = r.text;
  state.connOk = r.ok;
  updateConn();
  renderStrip();
}
function updateConn() {
  const el = document.getElementById('conn-status');
  if (!el) return;
  el.textContent = state.connText || 'Not tested yet';
  el.className = `row ${state.connText && state.connText !== 'Testing…' ? (state.connOk ? 'ok' : 'bad') : ''}`;
}

function settingsView() {
  const s = state.settings;
  const groups = [];

  // Token
  const tokenGroup = [h('h2', 'GitHub token')];
  if (s.token && !state.replacingToken) {
    tokenGroup.push(h('p.row', { 'data-token': 'saved' }, 'Token saved, ending ', h('b.mono', s.token.slice(-4))));
    tokenGroup.push(h('div.btnrow',
      h('button.btn.secondary', { type: 'button', 'data-action': 'replace-token', onclick: async () => {
        const r = await confirmBox({ title: 'Replace the saved token?', text: 'You will paste a new one next.', ok: 'Replace', id: 'replace-token' });
        if (r.ok) { state.replacingToken = true; render(); }
      } }, 'Replace token'),
      h('button.btn.danger', { type: 'button', 'data-action': 'remove-token', onclick: async () => {
        const r = await confirmBox({ title: 'Remove the saved token?', text: 'Sets stay on the phone, but nothing uploads until a token is saved again.', ok: 'Remove', id: 'remove-token' });
        if (!r.ok) return;
        await saveSettings({ token: '' });
        state.connText = '';
        sync.uploadAll();
        render();
      } }, 'Remove token')));
  } else {
    const input = h('input.field.mono', { type: 'password', name: 'token', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', placeholder: 'github_pat_…', 'aria-label': 'GitHub token' });
    const saveT = h('button.btn.primary', { type: 'button', 'data-action': 'save-token', disabled: true }, 'Save token');
    input.addEventListener('input', () => { saveT.disabled = !input.value.trim(); });
    saveT.addEventListener('click', async () => {
      const t = input.value.trim();
      if (!t) return;
      await saveSettings({ token: t });
      input.value = '';
      state.replacingToken = false;
      render();
      await runConnectionTest();
      await refreshSetup(true);
      sync.uploadAll();
    });
    tokenGroup.push(h('label.lab', 'Paste the token'), input, h('div.btnrow',
      state.replacingToken ? h('button.btn.secondary', { type: 'button', onclick: () => { state.replacingToken = false; render(); } }, 'Cancel') : null,
      saveT));
  }
  tokenGroup.push(h('p.row', 'The token stays on this phone and is sent only to api.github.com.'));
  groups.push(h('section.group', { 'data-group': 'token' }, tokenGroup));

  // Data repository
  const owner = h('input.field', { type: 'text', name: 'owner', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Repository owner' });
  owner.value = s.owner || '';
  const repo = h('input.field', { type: 'text', name: 'repo', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Repository name' });
  repo.value = s.repo || '';
  const saveR = h('button.btn.secondary', { type: 'button', 'data-action': 'save-repo', disabled: true }, 'Save repository');
  const chk = () => { saveR.disabled = (owner.value.trim() === (s.owner || '') && repo.value.trim() === (s.repo || '')) || !owner.value.trim() || !repo.value.trim(); };
  owner.addEventListener('input', chk);
  repo.addEventListener('input', chk);
  saveR.addEventListener('click', async () => {
    await saveSettings({ owner: owner.value.trim(), repo: repo.value.trim() });
    toast('Repository saved');
    render();
    if (state.settings.token) { await runConnectionTest(); refreshSetup(true); sync.uploadAll(); }
  });
  groups.push(h('section.group', { 'data-group': 'repo' }, h('h2', 'Data repository'),
    h('label.lab', 'Owner'), owner, h('label.lab', 'Name'), repo, saveR));

  // Connection
  groups.push(h('section.group', { 'data-group': 'connection' }, h('h2', 'Connection'),
    h('p.row', { id: 'conn-status', class: state.connText && state.connText !== 'Testing…' ? (state.connOk ? 'ok' : 'bad') : null }, state.connText || 'Not tested yet'),
    h('button.btn.secondary', { type: 'button', 'data-action': 'test', disabled: !s.token, onclick: runConnectionTest }, 'Test connection')));

  // Setup
  const st = state.setup;
  groups.push(h('section.group', { 'data-group': 'setup' }, h('h2', 'Setup'),
    h('p.row', st ? h('span', 'Published ', h('b', U.dayMonTime(st.published_at)), ` · ${U.plural(st.exercises.filter(e => e.active).length, 'active exercise', 'active exercises')} · ${U.plural(st.workouts.length, 'workout', 'workouts')}`) : 'No setup yet.  Connect and refresh in Settings.'),
    h('p.row', state.setupCheckedAt ? `Last checked ${U.dayMonTime(state.setupCheckedAt)}` : 'Not checked yet'),
    state.open ? h('p.row', 'A refresh applies from the next workout; the one in progress keeps its setup.') : null,
    h('button.btn.secondary', { type: 'button', 'data-action': 'refresh-setup', disabled: !s.token, onclick: () => refreshSetup(true) }, 'Refresh setup now')));

  // History download (6.5)
  groups.push(h('section.group', { 'data-group': 'restore' }, h('h2', 'History on GitHub'),
    h('p.row', 'Downloads any session files that are not on this phone, for example after a reinstall.'),
    h('button.btn.secondary', { type: 'button', 'data-action': 'restore', disabled: !s.token || state.restoring, onclick: doRestore }, state.restoring ? 'Downloading…' : 'Download history')));

  // Storage
  const persist = h('p.row', { id: 'persist-status' }, 'Checking…');
  const usage = h('p.row', { id: 'storage-usage' }, '');
  fillStorage(persist, usage);
  groups.push(h('section.group', { 'data-group': 'storage' }, h('h2', 'Storage on this phone'), persist, usage,
    h('p.row', { id: 'queue-row' }, queueRowText())));

  // Export
  groups.push(h('section.group', { 'data-group': 'export' }, h('h2', 'Export'),
    h('p.row', 'Saves every session and the setup copy on this phone to one file.  The token is not included.'),
    h('button.btn.secondary', { type: 'button', 'data-action': 'export', onclick: exportAll }, 'Export everything')));

  // App
  groups.push(h('section.group', { 'data-group': 'app' }, h('h2', 'App'),
    h('p.row', { 'data-version': U.APP_VERSION }, 'Swole version ', h('b', U.APP_VERSION)),
    state.swUpdateReady ? h('p.row.ok', 'A new version has been downloaded.  It takes effect the next time the app is opened.') : null));

  return [backHead(state.backTo === 'workout' ? 'Workout' : state.backTo === 'history' ? 'History' : 'Home', () => go(state.backTo === 'settings' ? 'home' : state.backTo), 'Settings'),
    stripEl(), h('main.main.pad-bottom', groups)];
}

async function fillStorage(persistEl, usageEl) {
  try {
    const p = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null;
    persistEl.replaceChildren('Persistent storage: ', h(`b.${p ? 'ok' : 'bad'}`, p ? 'granted' : (p === null ? 'unknown' : 'not granted')),
      p ? '.  iOS keeps the data even when space runs low.' : '.  iOS may clear the app’s data if the phone runs short of space; uploads are the safeguard.');
    persistEl.dataset.persisted = String(p);
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      usageEl.textContent = `Using ${(e.usage / 1024).toFixed(0)} KB of the space the browser allows.`;
    }
  } catch {
    persistEl.textContent = 'Persistent storage: unknown';
  }
}

async function exportAll() {
  const recs = (await db.sessionAll()).sort((a, b) => U.ms(a.doc.started_at) - U.ms(b.doc.started_at));
  const data = { format: 1, kind: 'swole-export', exported_at: U.isoLocal(), app_version: U.APP_VERSION, setup: state.setup, sessions: recs.map(r => r.doc) };
  const name = `swole-export-${U.localDate()}.json`;
  const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
  try {
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Swole export' });
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, class: 'hidden' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

init();
