// DOM helpers, steppers, confirmation boxes (brief 5.11), sheets and toasts.
// All text goes in through textContent: names from the setup are never parsed as HTML.

import { num, parseNum, tidy } from './util.js';

/** h('div.card', {onclick, 'data-x': 1}, child, 'text', [more]) */
export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'text') el.textContent = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

// ---- Where the last tap landed: a destructive button must never sit under it ----
let lastPoint = null;
document.addEventListener('pointerdown', e => { lastPoint = { x: e.clientX, y: e.clientY, t: Date.now() }; }, true);

function under(el, p) {
  if (!p) return false;
  const r = el.getBoundingClientRect();
  const m = 24; // margin: a sloppy second tap lands near, not exactly on, the first
  return p.x >= r.left - m && p.x <= r.right + m && p.y >= r.top - m && p.y <= r.bottom + m;
}

// ---- Confirmation box ----
let openBox = null;

/**
 * confirmBox({title, text, ok, danger, input}) → Promise<{ok:boolean, value?:string}>
 * Cancel is the default: Escape, Enter outside the text field, and a tap outside the box all cancel.
 */
export function confirmBox({ title, text, ok = 'OK', danger = true, input = null, cancel = 'Cancel', id = 'confirm' }) {
  if (openBox) openBox.close(false);
  const layer = document.getElementById('dialogs');
  return new Promise(resolve => {
    let field = null;
    const cancelBtn = h('button.btn.secondary', { type: 'button', 'data-role': 'cancel', text: cancel });
    const okBtn = h(`button.btn.${danger ? 'danger' : 'primary'}`, { type: 'button', 'data-role': 'ok', text: ok });
    if (input) {
      field = h('textarea.field', { rows: 3, placeholder: input.placeholder || '', 'aria-label': input.label || 'Comment', maxlength: 2000 });
      field.value = input.value || '';
    }
    const box = h('div.box', { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'box-title', 'data-dialog': id },
      h('h2', { id: 'box-title', text: title }),
      text ? h('p.boxtext', { text }) : null,
      field,
      h('div.boxbtns', cancelBtn, okBtn));
    const back = h('div.backdrop', { 'data-dialog-backdrop': id }, box);
    const close = (isOk) => {
      if (!openBox || openBox.back !== back) return;
      openBox = null;
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      resolve(isOk ? { ok: true, value: field ? field.value : undefined } : { ok: false });
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      if (e.key === 'Enter' && e.target !== field && e.target !== okBtn) { e.preventDefault(); close(false); }
    };
    back.addEventListener('click', e => { if (e.target === back) close(false); });
    cancelBtn.addEventListener('click', () => close(false));
    okBtn.addEventListener('click', () => close(true));
    document.addEventListener('keydown', onKey, true);
    layer.appendChild(back);
    openBox = { back, close };
    // Keep the destructive button away from the spot that opened the box.
    const p = lastPoint && Date.now() - lastPoint.t < 2000 ? lastPoint : null;
    if (under(okBtn, p)) box.classList.add('shift-up');
    if (under(okBtn, p)) { box.classList.remove('shift-up'); box.classList.add('shift-down'); }
    cancelBtn.focus({ preventScroll: true });
  });
}

/** A message with one button (used for failures the user must see). */
export function messageBox({ title, text, ok = 'OK', id = 'message' }) {
  if (openBox) openBox.close(false);
  const layer = document.getElementById('dialogs');
  return new Promise(resolve => {
    const okBtn = h('button.btn.primary', { type: 'button', 'data-role': 'ok', text: ok });
    const box = h('div.box', { role: 'alertdialog', 'aria-modal': 'true', 'data-dialog': id },
      h('h2', { text: title }), text ? h('p.boxtext', { text }) : null, h('div.boxbtns.one', okBtn));
    const back = h('div.backdrop', box);
    const close = () => { if (openBox && openBox.back === back) openBox = null; back.remove(); resolve(); };
    okBtn.addEventListener('click', close);
    layer.appendChild(back);
    openBox = { back, close };
    okBtn.focus({ preventScroll: true });
  });
}

export function closeDialogs() { if (openBox) openBox.close(false); }

// ---- Sheets (Swap, Add Exercise, Edit Set) ----
let sheetClose = null;
export function openSheet(id, content, { onClose } = {}) {
  closeSheet();
  const layer = document.getElementById('sheets');
  const sheet = h('div.sheet', { role: 'dialog', 'aria-modal': 'true', 'data-sheet': id }, h('div.grab'), content);
  const dim = h('div.dim', { 'data-sheet-dim': id });
  dim.addEventListener('click', () => closeSheet());
  layer.append(dim, sheet);
  sheetClose = () => { dim.remove(); sheet.remove(); sheetClose = null; if (onClose) onClose(); };
  return sheet;
}
export function closeSheet() { if (sheetClose) sheetClose(); }
export function sheetOpen() { return !!sheetClose; }

// ---- Toast ----
let toastTimer = null;
export function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---- Stepper ----
/**
 * A stepper: − [figure] +.  The figure is an input, so a tap opens the number pad.
 * kind: 'weight' (decimal, ≥ 0, steps of step), 'reps' (whole, steps of 1), 'secs' (whole, steps of 5)
 * value null means blank; from blank, + starts at one step (brief 5.7).
 */
export function stepper({ label, value, step, kind, small, onChange, name }) {
  let v = value;
  const isWeight = kind === 'weight';
  const input = h('input.val', {
    type: 'text', inputmode: isWeight ? 'decimal' : 'numeric', autocomplete: 'off', enterkeyhint: 'done',
    'aria-label': label, name, placeholder: '–', spellcheck: 'false',
  });
  // The figure's size follows its length (data-len), so 42.5 or 102.25 is never cut off.
  const fit = () => { input.dataset.len = String(Math.min(8, Math.max(1, input.value.length))); };
  input.value = v === null || v === undefined ? '' : num(v);
  fit();
  const set = (nv, fromTyping) => {
    v = nv;
    if (!fromTyping) input.value = v === null ? '' : num(v);
    fit();
    onChange(v);
  };
  const minus = h('button.pm', { type: 'button', 'aria-label': `${label} down`, 'data-step': 'minus', text: '−' });
  const plus = h('button.pm', { type: 'button', 'aria-label': `${label} up`, 'data-step': 'plus', text: '+' });
  minus.addEventListener('click', () => {
    if (v === null || v === undefined) return set(isWeight ? 0 : null);
    const floor = isWeight ? 0 : 1;
    let nv = tidy(v - step);
    if (nv < floor) nv = floor;
    set(nv);
  });
  plus.addEventListener('click', () => {
    if (v === null || v === undefined) return set(step);
    set(tidy(v + step));
  });
  input.addEventListener('input', () => {
    let n = parseNum(input.value);
    if (n !== null && !isWeight) n = Math.round(n);
    set(n, true);
  });
  input.addEventListener('blur', () => { input.value = v === null || v === undefined ? '' : num(v); fit(); });
  input.addEventListener('focus', () => { setTimeout(() => { try { input.select(); } catch { /* ignore */ } }, 0); });
  const smallEl = h('small', { text: small || '' });
  const el = h('div.step', { 'data-kind': kind },
    h('label', { text: label }),
    h('div.ctl', minus, input, plus),
    smallEl);
  el.setValue = nv => { v = nv; input.value = v === null || v === undefined ? '' : num(v); fit(); };
  el.setSmall = t => { smallEl.textContent = t; };
  return el;
}
