// Session model: pure functions over session records.  Callers persist the
// returned record and only then show the change (write first).
//
// A session record in IndexedDB:
//   id         session_id
//   doc        the session file exactly as uploaded (brief 3.2)
//   path       sessions/<YYYY>/<YYYY-MM-DD>_<id>.json, fixed at start
//   sha        GitHub's version marker for the file, or null
//   dirty      true while the doc has changes GitHub has not confirmed
//   everSent   true once an upload of this session has been attempted
//   snapshot   the setup the session started with (groups, exercises, workout)
//   slots      one per exercise slot: position, planned exercise and plan, actual exercise
//   ui         current slot, entry draft, stopwatch start

import { APP_VERSION, FORMAT, clone, isoLocal, localDate, ms, now, tidy, uuid } from './util.js';

export const AUTO_CLOSE_MS = 2 * 60 * 60 * 1000;

export function sessionPath(id, date) {
  return `sessions/${date.slice(0, 4)}/${date}_${id}.json`;
}

/** Start a session.  workoutName null for free-form. */
export function newSession(setup, workoutName) {
  const id = uuid();
  const t = now();
  const started = isoLocal(t);
  const date = localDate(t);
  const workout = workoutName ? setup.workouts.find(w => w.name === workoutName) : null;
  const exercises = clone(setup.exercises || []);
  const byId = new Map(exercises.map(e => [e.id, e]));
  const slots = [];
  if (workout) {
    const items = [...workout.items].sort((a, b) => a.order - b.order);
    for (const it of items) {
      const ex = byId.get(it.exercise_id);
      if (!ex) continue;
      slots.push({
        position: slots.length + 1,
        planned_exercise_id: ex.id,
        planned_exercise_name: ex.name,
        planned_sets: it.sets,
        target_min: it.target_min ?? null,
        target_max: it.target_max ?? null,
        comment: it.comment || '',
        exercise_id: ex.id,
        extra: 0,
      });
    }
  }
  const doc = {
    format: FORMAT,
    session_id: id,
    revision: 1,
    status: 'open',
    date,
    started_at: started,
    workout_name: workout ? workout.name : '',
    comment: '',
    setup_published_at: setup.published_at || '',
    app_version: APP_VERSION,
    updated_at: started,
    sets: [],
  };
  return {
    id, doc,
    path: sessionPath(id, date),
    sha: null, dirty: true, everSent: false,
    snapshot: { published_at: setup.published_at || '', groups: clone(setup.groups || []), exercises, workout: workout ? clone(workout) : null },
    slots,
    ui: { current: slots.length ? 1 : null, draft: null, stopwatch: null },
  };
}

/** Raise the revision and stamp the change.  Mutates doc. */
export function touch(doc) {
  doc.revision = (doc.revision || 0) + 1;
  doc.updated_at = isoLocal();
  doc.app_version = APP_VERSION;
}

export function exerciseOf(rec, id, setup) {
  const list = (rec && rec.snapshot && rec.snapshot.exercises) || [];
  return list.find(e => e.id === id) || ((setup && setup.exercises) || []).find(e => e.id === id) || null;
}

export function slotByPos(rec, pos) { return rec.slots.find(s => s.position === pos) || null; }

export function slotSets(doc, pos) {
  return doc.sets.filter(s => s.position === pos).sort((a, b) => a.set_number - b.set_number);
}

/** Planned number of sets including "+ Set" extras, or null for an unplanned slot. */
export function slotPlanned(slot) {
  return slot.planned_sets ? slot.planned_sets + (slot.extra || 0) : null;
}

export function slotComplete(rec, slot) {
  const p = slotPlanned(slot);
  return p !== null && slotSets(rec.doc, slot.position).length >= p;
}

export function nextSetNumber(rec, slot) { return slotSets(rec.doc, slot.position).length + 1; }

// ---- History look-ups ----

/** Closed sessions newest first (the input for pre-fill rule 1). */
export function closedDocs(recs) {
  return recs.map(r => r.doc)
    .filter(d => d.status === 'closed' || d.status === 'auto_closed')
    .sort((a, b) => ms(b.started_at) - ms(a.started_at));
}

/** The last closed session in which this exercise was actually done, and its sets of it. */
export function lastTime(history, exId) {
  for (const d of history) {
    const sets = d.sets.filter(s => s.exercise_id === exId)
      .sort((a, b) => a.position - b.position || a.set_number - b.set_number);
    if (sets.length) return { doc: d, date: d.date, started_at: d.started_at, sets };
  }
  return null;
}

/** Pre-fill for the next set in a slot (brief 5.7).  Returns {weight, value} with nulls for blank. */
export function prefill(rec, slot, history) {
  const exId = slot.exercise_id;
  const today = slotSets(rec.doc, slot.position).filter(s => s.exercise_id === exId);
  const just = today.length ? [...today].sort((a, b) => ms(b.logged_at) - ms(a.logged_at))[0] : null;
  if (just) return { weight: just.weight_kg, value: just.measure === 'time' ? just.duration_s : just.reps, source: 'today' };
  const last = lastTime(history, exId);
  if (last) {
    const s1 = last.sets[0];
    return { weight: s1.weight_kg, value: s1.measure === 'time' ? s1.duration_s : s1.reps, source: 'last' };
  }
  return { weight: null, value: null, source: 'blank' };
}

// ---- Changes to the open session ----

/** Append a set to the slot.  Returns a new record (not yet saved). */
export function withLoggedSet(rec, pos, weight, value) {
  const r = clone(rec);
  const slot = slotByPos(r, pos);
  const ex = exerciseOf(r, slot.exercise_id);
  const set = { set_id: uuid(), position: pos, set_number: nextSetNumber(r, slot) };
  if (slot.planned_exercise_id) {
    set.planned_exercise_id = slot.planned_exercise_id;
    set.planned_exercise_name = slot.planned_exercise_name;
  }
  Object.assign(set, {
    exercise_id: ex.id, exercise_name: ex.name, group: ex.group, type: ex.type, measure: ex.measure,
    weight_kg: tidy(weight),
  });
  if (ex.measure === 'time') set.duration_s = Math.round(value); else set.reps = Math.round(value);
  set.logged_at = isoLocal();
  r.doc.sets.push(set);
  touch(r.doc);
  r.dirty = true;
  r.ui.draft = null;
  r.ui.stopwatch = null;
  // No automatic move: after the last planned set the exercise stays current, in its
  // "done" state, until the user taps Next or + Extra set (v1.0.1).
  return { rec: r, set };
}

/** The next slot after pos (wrapping) whose planned sets are not all logged. */
export function nextOpenSlot(rec, pos) {
  const order = [...rec.slots].sort((a, b) => a.position - b.position);
  const i = order.findIndex(s => s.position === pos);
  const rotated = [...order.slice(i + 1), ...order.slice(0, i)];
  return rotated.find(s => slotPlanned(s) !== null && !slotComplete(rec, s)) || null;
}

function renumber(doc, pos) {
  slotSets(doc, pos).forEach((s, i) => { s.set_number = i + 1; });
}

export function withEditedSet(rec, setId, weight, value) {
  const r = clone(rec);
  const s = r.doc.sets.find(x => x.set_id === setId);
  if (!s) throw new Error('Set not found');
  s.weight_kg = tidy(weight);
  if (s.measure === 'time') s.duration_s = Math.round(value); else s.reps = Math.round(value);
  s.edited_at = isoLocal();
  touch(r.doc);
  r.dirty = true;
  return r;
}

export function withDeletedSet(rec, setId) {
  const r = clone(rec);
  const i = r.doc.sets.findIndex(x => x.set_id === setId);
  if (i < 0) throw new Error('Set not found');
  const pos = r.doc.sets[i].position;
  r.doc.sets.splice(i, 1);
  renumber(r.doc, pos);
  // An extra set that was asked for but not logged goes with the deleted set, so deleting
  // the last planned set brings back the steppers for that set rather than a phantom extra.
  const slot = r.slots ? r.slots.find(x => x.position === pos) : null;
  if (slot && slot.planned_sets) slot.extra = Math.max(0, slotSets(r.doc, pos).length - slot.planned_sets);
  touch(r.doc);
  r.dirty = true;
  if (r.ui) r.ui.draft = null;
  return r;
}

/** The most recently logged set of the session, or null. */
export function lastLogged(doc) {
  let best = null, bi = -1;
  doc.sets.forEach((s, i) => {
    if (!best || ms(s.logged_at) > ms(best.logged_at) || (ms(s.logged_at) === ms(best.logged_at) && i > bi)) { best = s; bi = i; }
  });
  return best;
}

export function withUndo(rec) {
  const last = lastLogged(rec.doc);
  if (!last) return null;
  const r = withDeletedSet(rec, last.set_id);
  r.ui.current = last.position;
  return r;
}

export function withSwap(rec, pos, exId) {
  const r = clone(rec);
  const slot = slotByPos(r, pos);
  slot.exercise_id = exId;
  r.ui.current = pos;
  r.ui.draft = null;
  r.ui.stopwatch = null;
  return r;
}

export function withAddedExercise(rec, exId) {
  const r = clone(rec);
  const pos = r.slots.reduce((m, s) => Math.max(m, s.position), 0) + 1;
  r.slots.push({
    position: pos, planned_exercise_id: null, planned_exercise_name: null, planned_sets: null,
    target_min: null, target_max: null, comment: '', exercise_id: exId, extra: 0,
  });
  r.ui.current = pos;
  r.ui.draft = null;
  r.ui.stopwatch = null;
  return r;
}

export function withExtraSet(rec, pos) {
  const r = clone(rec);
  const slot = slotByPos(r, pos);
  if (slot.planned_sets) slot.extra = (slot.extra || 0) + 1;
  r.ui.current = pos;
  r.ui.draft = null;
  return r;
}

export function withCurrent(rec, pos) {
  const r = clone(rec);
  if (r.ui.current !== pos) { r.ui.draft = null; r.ui.stopwatch = null; }
  r.ui.current = pos;
  return r;
}

/** End: returns a new record, or {discard:true} when no set was logged. */
export function withEnded(rec, comment) {
  const r = clone(rec);
  r.doc.comment = (comment || '').trim();
  r.doc.status = 'closed';
  r.doc.ended_at = isoLocal();
  touch(r.doc);
  r.dirty = true;
  r.ui = { current: null, draft: null, stopwatch: null };
  return r;
}

/** Time of the last activity in an open session: the last set, or the start. */
export function lastActivity(doc) {
  const last = lastLogged(doc);
  return last ? last.logged_at : doc.started_at;
}

export function isStale(doc) {
  return doc.status === 'open' && Date.now() - ms(lastActivity(doc)) > AUTO_CLOSE_MS;
}

export function withAutoClosed(rec) {
  const r = clone(rec);
  const last = lastLogged(r.doc);
  r.doc.status = 'auto_closed';
  r.doc.ended_at = last.logged_at;
  touch(r.doc);
  r.dirty = true;
  r.ui = { current: null, draft: null, stopwatch: null };
  return r;
}

/** A session that must vanish but may already be on GitHub: keep the file, marked deleted. */
export function withDeleted(rec) {
  const r = clone(rec);
  r.doc.status = 'deleted';
  r.doc.sets = [];
  if (!r.doc.ended_at) r.doc.ended_at = isoLocal();
  touch(r.doc);
  r.dirty = true;
  if (r.ui) r.ui = { current: null, draft: null, stopwatch: null };
  return r;
}

export function withComment(rec, comment) {
  const r = clone(rec);
  r.doc.comment = (comment || '').trim();
  touch(r.doc);
  r.dirty = true;
  return r;
}

/**
 * Slots for a session that came from GitHub (restore) and so has no slots of its
 * own: from the workout in the setup when the names match, then from the sets.
 */
export function deriveSlots(doc, setup) {
  const slots = [];
  const workout = doc.workout_name && setup ? (setup.workouts || []).find(w => w.name === doc.workout_name) : null;
  const exs = (setup && setup.exercises) || [];
  const positions = [...new Set(doc.sets.map(s => s.position))].sort((a, b) => a - b);
  if (workout) {
    [...workout.items].sort((a, b) => a.order - b.order).forEach((it, i) => {
      const ex = exs.find(e => e.id === it.exercise_id);
      if (!ex) return;
      slots.push({
        position: i + 1, planned_exercise_id: ex.id, planned_exercise_name: ex.name, planned_sets: it.sets,
        target_min: it.target_min ?? null, target_max: it.target_max ?? null, comment: it.comment || '',
        exercise_id: ex.id, extra: 0,
      });
    });
  }
  for (const pos of positions) {
    const sets = slotSets(doc, pos);
    const last = sets[sets.length - 1];
    let slot = slots.find(s => s.position === pos);
    if (!slot) {
      slot = {
        position: pos, planned_exercise_id: last.planned_exercise_id || null,
        planned_exercise_name: last.planned_exercise_name || null, planned_sets: null,
        target_min: null, target_max: null, comment: '', exercise_id: last.exercise_id, extra: 0,
      };
      slots.push(slot);
    } else {
      slot.exercise_id = last.exercise_id;
      if (slot.planned_sets && sets.length > slot.planned_sets) slot.extra = sets.length - slot.planned_sets;
    }
  }
  return slots.sort((a, b) => a.position - b.position);
}

/** Exercises from a set list, for a past session with no snapshot. */
export function exercisesFromSets(doc) {
  const m = new Map();
  for (const s of doc.sets) {
    if (!m.has(s.exercise_id)) m.set(s.exercise_id, { id: s.exercise_id, name: s.exercise_name, group: s.group, type: s.type, measure: s.measure, increment_kg: null, note: '', active: true });
  }
  return [...m.values()];
}
