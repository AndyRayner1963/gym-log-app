// Small helpers: time, formatting, ids.  No DOM here.

export const APP_VERSION = self.SWOLE_VERSION || '0.0.0';
export const FORMAT = 1;

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Current time as a Date.  Everything reads the clock through Date.now(). */
export function now() { return new Date(Date.now()); }

/** ISO 8601 with the local offset, seconds precision: 2026-11-10T16:42:05+07:00 */
export function isoLocal(d = now()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** Local calendar date YYYY-MM-DD. */
export function localDate(d = now()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function ms(iso) { return iso ? Date.parse(iso) : NaN; }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "16:42" in the phone's local time. */
export function hhmm(iso) {
  const d = new Date(ms(iso));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** "9 Nov" */
export function dayMon(iso) {
  const d = new Date(ms(iso));
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
/** "9 Nov 08:15" */
export function dayMonTime(iso) { return `${dayMon(iso)} ${hhmm(iso)}`; }
/** "Tue 3 Nov 2026" */
export function longDay(iso) {
  const d = new Date(ms(iso));
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
/** "3 November" (from a YYYY-MM-DD date) */
export function dayMonthLong(dateStr) {
  const [, m, dd] = dateStr.split('-').map(Number);
  return `${dd} ${MONTHS_LONG[m - 1]}`;
}

export function uuid() {
  if (self.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }

/** Round away float noise (0.1 + 0.2) while keeping 1.25-style quarters exact. */
export function tidy(n) { return Math.round(n * 1000) / 1000; }

/** Number shown without rounding: 42.5, 21.25, 0. */
export function num(n) { return n === null || n === undefined || n === '' ? '' : String(tidy(Number(n))); }

/** Parse a typed figure.  Accepts a comma as decimal mark.  Returns null if blank or invalid. */
export function parseNum(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? tidy(n) : null;
}

// ---- Labels from the data contract (brief 3.3) ----

export const WEIGHT_LABEL = {
  machine: 'Weight kg', cable: 'Weight kg', barbell: 'Plates kg',
  dumbbell: 'Each kg', kettlebell: 'Each kg', bodyweight: 'Added kg', assisted: 'Assist kg',
};
export function weightLabel(type) { return WEIGHT_LABEL[type] || 'Weight kg'; }

/** Weight as written in lists: "45 kg", "20 kg plates", "14 kg each", "+2.5 kg", "25 kg assist". */
export function weightText(type, w) {
  const v = num(w);
  switch (type) {
    case 'barbell': return `${v} kg plates`;
    case 'dumbbell': case 'kettlebell': return `${v} kg each`;
    case 'bodyweight': return Number(w) > 0 ? `+${v} kg` : 'BW';
    case 'assisted': return `${v} kg assist`;
    default: return `${v} kg`;
  }
}

/** Short weight for compact lines ("45", "+2.5", "BW"). */
export function weightShort(type, w) {
  if (type === 'bodyweight') return Number(w) > 0 ? `+${num(w)}` : 'BW';
  return num(w);
}

export function valueOf(set) { return set.measure === 'time' ? set.duration_s : set.reps; }
export function valueText(measure, v) { return measure === 'time' ? `${num(v)} s` : num(v); }

/** "45 kg × 11", "28 kg each × 70 s", "BW × 20", "50 s" (bodyweight time with no weight). */
export function setText(type, measure, w, v) {
  if (type === 'bodyweight' && !(Number(w) > 0) && measure === 'time') return `${num(v)} s`;
  return `${weightText(type, w)} × ${valueText(measure, v)}`;
}

/**
 * "45 × 12, 11, 10" or "40 × 12 · 42.5 × 10, 9" for a run of sets of one exercise.
 * withUnit: "45 kg × 12, 11, 10", "25 kg assist × 8, 7".
 */
export function compactSets(sets, withUnit = false) {
  if (!sets.length) return '';
  const groups = [];
  for (const s of sets) {
    const key = `${s.type}|${num(s.weight_kg)}`;
    const v = s.measure === 'time' ? `${num(s.duration_s)} s` : num(s.reps);
    const g = groups[groups.length - 1];
    if (g && g.key === key) { g.v.push(v); continue; }
    // The unit is written once, on the first weight.
    const w = withUnit && !groups.length ? weightText(s.type, s.weight_kg) : weightShort(s.type, s.weight_kg);
    groups.push({ key, w, v: [v] });
  }
  return groups.map(g => `${g.w} × ${g.v.join(', ')}`).join(' · ');
}

/** "10–12 reps", "60–75 s", "10+ reps", "up to 12 reps", or "" */
export function targetText(measure, min, max) {
  const unit = measure === 'time' ? ' s' : ' reps';
  const has = v => v !== null && v !== undefined && v !== '';
  if (has(min) && has(max)) return min === max ? `${min}${unit}` : `${min}–${max}${unit}`;
  if (has(min)) return `${min}+${unit}`;
  if (has(max)) return `up to ${max}${unit}`;
  return '';
}

// ---- Reps in reserve (v1.1.0) ----
// A set may carry rir (0–5, 5 meaning "5 or more") and failed (true when he tried another rep,
// or more time, and could not complete it: stored as rir 0, failed true).  Both or neither.
// In the app a value is a code: null (not recorded), 'F', or 0–5.

/** The stepper's values in order.  The Edit Set panel also has null (not recorded) before 'F'. */
export const RIR_CODES = ['F', 0, 1, 2, 3, 4, 5];
export const RIR_DEFAULT = 3;

/** The code of a set: null, 'F' or 0–5. */
export function rirCode(set) {
  if (!set || set.rir === undefined || set.rir === null) return null;
  return set.failed ? 'F' : Math.max(0, Math.min(5, Math.round(Number(set.rir))));
}

/** The figure: "–", "F", "0" … "4", "5+". */
export function rirFigure(code) {
  if (code === null || code === undefined) return '–';
  if (code === 'F') return 'F';
  return code >= 5 ? '5+' : String(code);
}

/** Compact suffix for set rows: "RIR 2", "RIR 5+", "F", or "" when not recorded. */
export function rirShort(set) {
  const c = rirCode(set);
  if (c === null) return '';
  return c === 'F' ? 'F' : `RIR ${rirFigure(c)}`;
}

/** Writes a code onto a set (mutates it): null removes both fields. */
export function applyRir(set, code) {
  if (code === null || code === undefined) { delete set.rir; delete set.failed; return; }
  if (code === 'F') { set.rir = 0; set.failed = true; return; }
  set.rir = Math.max(0, Math.min(5, Math.round(Number(code))));
  set.failed = false;
}

export function plural(n, one, many){ return `${n} ${n === 1 ? one : many}`; }
