// Progress calculations (v1.2.0): exercise default targets, the estimated one-rep max (e1RM),
// the step-up indicator and the done state's "against last time" line.  Pure functions with no
// imports, no DOM and no storage: nothing here is ever written to a session file.
//
// Shared definitions:
//   e1RM-eligible   measure reps, type machine, cable, barbell, dumbbell or kettlebell
//                   (never bodyweight or assisted, whose weight figure is not the load lifted)
//   e1RM            weight × (1 + (reps + k) / 30), k = the set's RIR if recorded (a failed set
//                   is stored as rir 0), else 0.  No cap on reps + k.
//   baseline        the last set of the exercise in the last closed session in which it was done
//                   (the last element of M.lastTime(history, id).sets); the caller supplies it.
//   effective target  the slot's own workout target_min / target_max where present, each on its
//                   own, else the exercise's default from the session's setup snapshot.

/** Types whose weight is the load lifted, so an e1RM (and a step up in weight) means something. */
export const LOAD_TYPES = ['machine', 'cable', 'barbell', 'dumbbell', 'kettlebell'];

/** Tolerance for comparing kilograms and predicted reps (floating point). */
export const EPS = 1e-6;

/** A finite number, or null for absent, blank or invalid. */
function n(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

/** An exercise or a set (both carry type and measure) whose e1RM is calculated. */
export function e1rmEligible(x) { return !!x && x.measure === 'reps' && LOAD_TYPES.includes(x.type); }

/** A timed exercise or set with a load (the step-up indicator's timed rule). */
export function timedLoadEligible(x) { return !!x && x.measure === 'time' && LOAD_TYPES.includes(x.type); }

/** k of a stored set: its rir when recorded (failed sets carry rir 0), else 0. */
export function rirK(set) {
  const r = n(set && set.rir);
  return r === null ? 0 : r;
}

/** k of an RIR code as the stepper holds it: null ("–") and 'F' count 0, else the number. */
export function codeK(code) {
  if (code === null || code === undefined || code === 'F') return 0;
  return n(code) ?? 0;
}

/** Estimated one-rep max. */
export function e1rm(weight, reps, k = 0) { return weight * (1 + (reps + k) / 30); }

/** e1RM of a stored set, or null if it is not eligible.  code, when given, overrides its RIR. */
export function setE1rm(set, code) {
  if (!e1rmEligible(set)) return null;
  const w = n(set.weight_kg), r = n(set.reps);
  if (w === null || r === null) return null;
  return e1rm(w, r, code === undefined ? rirK(set) : codeK(code));
}

/** Reps predicted at weight w + i, at the same RIR, from a set of w × r at RIR k. */
export function predictedReps(w, r, k, i) { return 30 * (e1rm(w, r, k) / (w + i) - 1) - k; }

/** The effective target of a slot: {min, max}, each a number or null. */
export function effectiveTarget(slot, ex) {
  const pick = (own, def) => (n(own) !== null ? n(own) : n(def));
  return {
    min: pick(slot && slot.target_min, ex && ex.target_min),
    max: pick(slot && slot.target_max, ex && ex.target_max),
  };
}

/**
 * The step-up signal for an exercise: {on, next, predicted?}.  next is the weight one increment
 * above the baseline (W + i); the cue shows while the entry weight is below it.  Information only:
 * it never changes the pre-fill or anything recorded.
 *   Reps (e1RM-eligible): on when the effective target_min exists, W > 0 and the reps predicted
 *     at W + i (same RIR) reach target_min.  Above target_max still counts: no "two steps".
 *   Timed with a load type: on when the effective target_max exists and the baseline's
 *     duration_s reaches it.
 *   Otherwise (no baseline, no target, bodyweight or assisted, increment ≤ 0): off.
 */
export function stepUp(ex, base, target) {
  const off = { on: false, next: null };
  if (!ex || !base) return off;
  const i = n(ex.increment_kg);
  const w = n(base.weight_kg);
  if (i === null || i <= 0 || w === null) return off;
  const next = Math.round((w + i) * 1000) / 1000;
  const t = target || { min: null, max: null };
  if (e1rmEligible(ex)) {
    const r = n(base.reps);
    if (t.min === null || !(w > 0) || r === null) return off;
    const predicted = predictedReps(w, r, rirK(base), i);
    return predicted >= t.min - EPS ? { on: true, next, predicted } : { on: false, next: null, predicted };
  }
  if (timedLoadEligible(ex)) {
    const d = n(base.duration_s);
    if (t.max === null || d === null) return off;
    return d >= t.max ? { on: true, next } : off;
  }
  return off;
}

/** Whether the cue shows for this entry weight: the signal is on and the weight is below W + i. */
export function cueShown(signal, weight) {
  if (!signal || !signal.on) return false;
  const w = n(weight);
  return w !== null && w < signal.next - EPS;
}

/** Colour band of a percentage of last time: 'up' (≥ 103), 'down' (≤ 97) or 'same'. */
export function band(pct) { return pct >= 103 ? 'up' : pct <= 97 ? 'down' : 'same'; }

/**
 * The done state's line: today's last set (with the RIR code on the stepper, "–" counting 0)
 * against the baseline.  Returns {today, base, pct, band}, or null when either set is not e1RM-eligible or
 * the baseline's e1RM is not above zero.
 */
export function performance(today, code, base) {
  if (!e1rmEligible(today) || !e1rmEligible(base)) return null;
  const t = setE1rm(today, code);   // code undefined: the set's own stored RIR
  const b = setE1rm(base);
  if (t === null || b === null || !(b > 0)) return null;
  const pct = Math.round((t / b) * 100);
  return { today: t, base: b, pct, band: band(pct) };
}

/** "e1RM 56.0 · 95% of last time" */
export function performanceText(p) { return `e1RM ${p.today.toFixed(1)} · ${p.pct}% of last time`; }
