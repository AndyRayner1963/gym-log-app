// App tests: BRIEF.md section 10.3 (App 1–14), plus the session-file contract and a few extras.
// Run from the repository root:  node --test tests/app/
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');
const { FakeGitHub, SETUP, T0 } = H;

after(() => H.closeEnv());

const clone = x => JSON.parse(JSON.stringify(x));
const norm = s => s.replace(/\s+/g, ' ').trim();

/** A fake store holding the fixture setup, and an app seeded with token, setup and (optionally) history. */
async function start({ history = true, sw = false, token, time, fake } = {}) {
  fake = fake || new FakeGitHub();
  if (!fake.get('setup.json')) fake.put('setup.json', JSON.stringify(SETUP, null, 2));
  const app = await H.openApp({
    fake, sw, time,
    seed: { settings: H.SETTINGS(fake, token ? { token } : {}), setup: SETUP, sessions: history ? H.closedFixtureDocs() : [] },
  });
  return app;
}

async function begin(page, name = 'Test Upper') {
  await page.click(`[data-workout="${name}"]`);
  await page.waitForSelector('#app[data-view=workout]');
}

async function endWorkout(page, comment) {
  await page.click('[data-action=end]');
  await page.waitForSelector('[data-dialog=end]');
  if (comment !== undefined) await page.fill('[data-dialog=end] textarea', comment);
  await page.click('[data-dialog=end] [data-role=ok]');
  await page.waitForSelector('#app[data-view=home]');
}

async function setVisibility(page, v) {
  await page.evaluate(v => {
    Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
    Object.defineProperty(document, 'hidden', { value: v === 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, v);
}

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/;

// ---------------------------------------------------------------------------

test('App 1: offline from the start: start, log, end; everything in the database; queue shows one session', async () => {
  const fake = new FakeGitHub();
  const app = await start({ sw: true, fake });
  const { page, ctx } = app;
  await H.waitForController(page);
  // Network off: the app's own site and GitHub.
  fake.mode = 'offline';
  await ctx.setOffline(true);
  await page.reload();
  await H.ready(page);
  assert.equal(await page.getAttribute('#app', 'data-view'), 'home', 'the app opens from the service worker cache');
  await begin(page);
  await H.logSet(page);
  await H.logSet(page);
  await H.logSet(page);
  await H.tapNext(page);
  await H.logSet(page);
  await endWorkout(page, 'Offline session');
  const db = await H.readDB(page);
  assert.equal(db.sessions.filter(s => s.doc.date === '2026-11-12').length, 1);
  const s = db.sessions.find(x => x.doc.date === '2026-11-12');
  assert.equal(s.doc.status, 'closed');
  assert.equal(s.doc.sets.length, 4);
  assert.equal(s.doc.comment, 'Offline session');
  assert.equal(s.dirty, true);
  assert.equal(s.sha, null);
  assert.equal(await page.getAttribute('[data-queue]', 'data-queue'), '1');
  assert.match(await page.textContent('[data-queue]'), /^1 session waiting to upload$/);
  assert.match(await H.strip(page), /Offline · 4 sets saved on phone/);
  assert.equal(fake.puts.length, 0);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('App 2: reload mid-session returns the same session, sets and current exercise', async () => {
  const app = await start();
  const { page } = app;
  await begin(page);
  await H.logSet(page);
  await H.logSet(page);
  await H.goSlot(page, 3);
  await page.waitForSelector('.ex.current[data-slot="3"]');
  await H.setEntry(page, 30, 7);
  await H.waitFor(async () => { const o = await H.openSession(page); return o.ui.draft && o.ui.draft.weight === 30 && o.ui.draft.value === 7; }, { message: 'draft saved' });
  const before = await H.openSession(page);
  await page.reload();
  await H.ready(page);
  assert.equal(await page.getAttribute('#app', 'data-view'), 'workout');
  const afterRec = await H.openSession(page);
  assert.equal(afterRec.id, before.id);
  assert.equal(afterRec.doc.sets.length, 2);
  assert.ok(await page.$('.ex.current[data-slot="3"]'), 'current exercise is still slot 3');
  const e = await H.entryValues(page);
  assert.equal(e.weight, '30');
  assert.equal(e.value, '7');
  const info = await H.panelInfo(page);
  assert.equal(info.find(i => i.slot === 1).done, false, 'slot 1 has 2 of 3 sets, not done');
  assert.match(info.find(i => i.slot === 1).text, /2 of 3 sets/);
  assert.equal(info.find(i => i.slot === 3).current, true);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('App 3: when the network returns the session uploads once; the store holds exactly one file', async () => {
  const fake = new FakeGitHub();
  fake.put('setup.json', JSON.stringify(SETUP, null, 2));
  fake.mode = 'offline';
  const app = await start({ fake });
  const { page } = app;
  await begin(page);
  await H.logSet(page);
  await H.logSet(page);
  await endWorkout(page);
  assert.match(await H.strip(page), /Offline · 2 sets saved on phone/);
  fake.mode = 'online';
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await H.waitFor(async () => /All uploaded/.test(await H.strip(page)), { message: 'All uploaded' });
  const paths = fake.sessionPaths();
  assert.equal(paths.length, 1);
  const db = await H.readDB(page);
  const rec = db.sessions.find(s => s.doc.date === '2026-11-12');
  assert.equal(paths[0], rec.path);
  assert.deepEqual(fake.json(paths[0]), rec.doc);
  assert.equal(rec.dirty, false);
  assert.equal(rec.sha, fake.get(paths[0]).sha);
  assert.equal(fake.puts.filter(p => p.path === rec.path).length, 1, 'one PUT for the session');
  // Further triggers send nothing more.
  await setVisibility(page, 'visible');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(400);
  assert.equal(fake.puts.filter(p => p.path === rec.path).length, 1);
  assert.equal(await page.getAttribute('[data-queue]', 'data-queue'), '0');
  await app.close();
});

test('App 4: connection cut mid-upload, then restored: still one file, with the latest revision', async () => {
  const fake = new FakeGitHub();
  const app = await start({ fake });
  const { page } = app;
  await begin(page);
  // 1. GitHub stores the file but the reply never arrives: the app holds no marker.
  fake.cutAfterCommit = 1;
  await H.logSet(page);
  await H.waitFor(async () => fake.puts.length === 1 && /Offline/.test(await H.strip(page)), { message: 'cut upload' });
  let rec = await H.openSession(page);
  assert.equal(rec.dirty, true);
  assert.equal(rec.sha, null);
  // 2. Next trigger: file exists with an older revision; update it.  Cut again.
  fake.cutAfterCommit = 1;
  await H.logSet(page);
  await H.waitFor(() => fake.puts.length === 2, { message: 'second PUT' });
  // 3. Fully offline for a set.
  await H.waitFor(async () => /Offline/.test(await H.strip(page)), { message: 'offline' });
  fake.mode = 'offline';
  await H.logSet(page);
  // 4. Restored.  (Three sets done: move on to the next exercise first.)
  fake.mode = 'online';
  await H.tapNext(page);
  await H.logSet(page);
  await H.waitFor(async () => /All uploaded/.test(await H.strip(page)), { message: 'All uploaded' });
  rec = await H.openSession(page);
  const paths = fake.sessionPaths();
  assert.equal(paths.length, 1, 'exactly one session file');
  assert.equal(fake.json(paths[0]).revision, rec.doc.revision);
  assert.deepEqual(fake.json(paths[0]), rec.doc);
  assert.equal(rec.dirty, false);
  assert.equal(rec.sha, fake.get(paths[0]).sha);
  // 5. Marker out of date (file changed elsewhere): the app re-reads once and updates.
  const other = fake.json(paths[0]);
  other.comment = 'changed elsewhere';
  fake.put(paths[0], JSON.stringify(other));
  await H.logSet(page);
  await H.waitFor(async () => { const r = await H.openSession(page); return r && !r.dirty; }, { message: 'upload after 409' });
  rec = await H.openSession(page);
  assert.equal(fake.sessionPaths().length, 1);
  assert.equal(fake.json(paths[0]).revision, rec.doc.revision);
  assert.equal(fake.json(paths[0]).sets.length, 5);
  await app.close();
});

test('App 5: pre-fill rules 1, 2 and 3, for both measures', async () => {
  // Rules 1 and 2, with the fixture history.
  let app = await start();
  let page = app.page;
  await begin(page, 'Test Lower');
  // Rule 1, reps: set 1 of the last closed session with Test Leg Press (9 Nov: 130 × 13, not 5 Nov: 120 × 15).
  let e = await H.entryValues(page);
  assert.deepEqual([e.weight, e.value, e.logDisabled], ['130', '13', false]);
  assert.match(e.logText, /Log Set 1\s*130 kg × 13/);
  // Rule 2, reps: set 2 takes today's values from the set just logged.
  await H.setEntry(page, 140, 10);
  await H.logSet(page);
  e = await H.entryValues(page);
  assert.deepEqual([e.weight, e.value], ['140', '10']);
  // Rule 1, time: Test Kettlebell Carry, 9 Nov set 1: 28 kg × 75 s (not 5 Nov: 70 s).
  await H.goSlot(page, 2);
  await page.waitForSelector('.dock input[name=seconds]');
  e = await H.entryValues(page);
  assert.deepEqual([e.weight, e.value], ['28', '75']);
  // Rule 2, time.
  await H.setEntry(page, 30, 60);
  await H.logSet(page);
  e = await H.entryValues(page);
  assert.deepEqual([e.weight, e.value], ['30', '60']);
  assert.match(e.logText, /Log Set 2\s*30 kg each × 60 s/);
  await app.close();

  // Rule 3: no history, blank, Log inactive until both figures are entered; plus starts at one step.
  app = await start({ history: false });
  page = app.page;
  await begin(page, 'Test Upper');
  e = await H.entryValues(page);
  assert.deepEqual([e.weight, e.value, e.logDisabled], ['', '', true]);
  await page.click('.dock [data-kind=weight] [data-step=plus]');
  e = await H.entryValues(page);
  assert.deepEqual([e.weight, e.value, e.logDisabled], ['5', '', true], 'weight from blank starts at one step (5 kg)');
  await page.click('.dock [data-kind=reps] [data-step=plus]');
  e = await H.entryValues(page);
  assert.deepEqual([e.weight, e.value, e.logDisabled], ['5', '1', false]);
  // Time measure, blank: Test Plank.
  await H.goSlot(page, 4);
  await page.waitForSelector('.dock input[name=seconds]');
  e = await H.entryValues(page);
  assert.deepEqual([e.weight, e.value, e.logDisabled], ['', '', true]);
  await page.click('.dock [data-kind=secs] [data-step=plus]');
  e = await H.entryValues(page);
  assert.deepEqual([e.value, e.logDisabled], ['5', true], 'seconds from blank starts at 5');
  await page.click('.dock [data-kind=weight] [data-step=plus]');
  e = await H.entryValues(page);
  assert.deepEqual([e.weight, e.logDisabled], ['2.5', false]);
  // Quarter steps display without rounding (barbell, 1.25 kg).
  await page.click('[data-action=add-exercise]');
  await page.click('[data-sheet=add] [data-group=Pull]');
  await page.click('[data-sheet=add] [data-ex=B04]');
  await page.waitForSelector('.ex.current[data-slot="5"]');
  await page.click('.dock [data-kind=weight] [data-step=plus]');
  await page.click('.dock [data-kind=weight] [data-step=plus]');
  await page.click('.dock [data-kind=weight] [data-step=plus]');
  e = await H.entryValues(page);
  assert.equal(e.weight, '3.75');
  await page.click('.dock [data-kind=weight] [data-step=minus]');
  await page.click('.dock [data-kind=weight] [data-step=minus]');
  await page.click('.dock [data-kind=weight] [data-step=minus]');
  await page.click('.dock [data-kind=weight] [data-step=minus]');
  e = await H.entryValues(page);
  assert.equal(e.weight, '0', 'weight never goes below zero');
  assert.equal(await page.textContent('.dock [data-kind=weight] label'), 'Plates kg');
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('App 6: swap mid-exercise: logged sets keep the first exercise; later sets carry planned and actual', async () => {
  const app = await start();
  const { page } = app;
  await begin(page);
  await H.goSlot(page, 2);
  await page.waitForSelector('.ex.current[data-slot="2"]');
  let e = await H.entryValues(page);
  assert.deepEqual([e.weight, e.value], ['45', '12']);
  await H.logSet(page);
  await page.click('[data-action=swap]');
  await page.waitForSelector('[data-sheet=swap]');
  const opts = await page.$$eval('[data-sheet=swap] [data-ex]', els => els.map(el => ({ id: el.dataset.ex, text: el.textContent })));
  assert.deepEqual(opts.map(o => o.id), ['B02', 'B04', 'B03'], 'same-group active exercises; planned-later one last');
  assert.match(opts[2].text, /later today/);
  assert.match(opts[0].text, /Last 7 Nov · 35 kg × 12, 11/);
  assert.match(opts[1].text, /Last 8 Nov/);
  assert.match(await page.textContent('[data-sheet=swap] .sub'), /2 sets left; the set already logged stays as Test Cable Row/);
  await page.click('[data-sheet=swap] [data-ex=B02]');
  await page.waitForSelector('[data-sheet=swap]', { state: 'detached' });
  // Pre-fill from the new exercise's own history (7 Nov, first set of Test Machine Row: 35 × 12).
  e = await H.entryValues(page);
  assert.deepEqual([e.weight, e.value], ['35', '12']);
  await H.logSet(page);
  await H.logSet(page);
  const rec = await H.openSession(page);
  const slot2 = rec.doc.sets.filter(s => s.position === 2).sort((a, b) => a.set_number - b.set_number);
  assert.deepEqual(slot2.map(s => [s.set_number, s.planned_exercise_id, s.planned_exercise_name, s.exercise_id, s.exercise_name, s.type, s.group]), [
    [1, 'B01', 'Test Cable Row', 'B01', 'Test Cable Row', 'cable', 'Pull'],
    [2, 'B01', 'Test Cable Row', 'B02', 'Test Machine Row', 'machine', 'Pull'],
    [3, 'B01', 'Test Cable Row', 'B02', 'Test Machine Row', 'machine', 'Pull'],
  ]);
  // Swap back is possible and destroys nothing.
  await H.goSlot(page, 2);
  await page.click('[data-action=swap]');
  assert.ok(await page.$('[data-sheet=swap] [data-ex=B01]'), 'the planned exercise is offered to swap back');
  await page.click('[data-sheet=swap] [data-action=cancel]');
  assert.equal((await H.openSession(page)).doc.sets.length, 3);
  await app.close();
});

test('App 7: an extra set beyond the plan is numbered and stored', async () => {
  const app = await start();
  const { page } = app;
  await begin(page);
  await H.logSet(page);
  await H.logSet(page);
  await H.logSet(page);
  // v1.0.1: the exercise stays current in its done state; nothing moves without a tap.
  await page.waitForSelector('[data-dock=complete]');
  assert.ok(await page.$('.ex.current[data-slot="1"]'), 'still on the same exercise');
  assert.ok((await H.panelInfo(page)).find(i => i.slot === 1).done, 'slot 1 ticked');
  await H.tapExtra(page);
  assert.match(await page.textContent('.dock .title b'), /^Set 4 of 4 · Test Machine Press$/);
  const set3 = (await H.openSession(page)).doc.sets.find(s => s.position === 1 && s.set_number === 3);
  const e = await H.entryValues(page);
  assert.deepEqual([e.weight, e.value], [String(set3.weight_kg), String(set3.reps)], 'extra set pre-filled by rule 2');
  await H.logSet(page);
  await page.waitForSelector('[data-dock=complete]');
  assert.equal(norm(await page.textContent('[data-done=next]')), '4 sets done (3 planned) · Test Machine Press');
  // And one more with the in-box "+ Set", which in the done state is the same as + Extra set.
  await page.clock.fastForward(1100);
  await page.click('.ex.current [data-action=add-set]');
  await page.waitForSelector('[data-dock=entry]');
  assert.match(await page.textContent('.dock .title b'), /^Set 5 of 5 · Test Machine Press$/);
  await H.logSet(page);
  const rec = await H.openSession(page);
  const s1 = rec.doc.sets.filter(s => s.position === 1).sort((a, b) => a.set_number - b.set_number);
  assert.deepEqual(s1.map(s => s.set_number), [1, 2, 3, 4, 5]);
  assert.equal(s1[3].planned_exercise_id, 'A01');
  assert.equal(s1[3].exercise_id, 'A01');
  await app.close();
});

test('App 8: each confirmation box appears, cancels by default, and acts only on the explicit button', async () => {
  const app = await start();
  const { page } = app;

  /** Opens the box with `open`, checks it, and cancels it three ways; returns the opener's box. */
  async function cancelThreeWays(id, open, unchanged) {
    for (const how of ['button', 'outside', 'escape']) {
      const opener = await open();
      await page.waitForSelector(`[data-dialog=${id}]`);
      const okBox = await page.locator(`[data-dialog=${id}] [data-role=ok]`).boundingBox();
      if (opener) {
        const overlap = !(okBox.x > opener.x + opener.width || okBox.x + okBox.width < opener.x || okBox.y > opener.y + opener.height || okBox.y + okBox.height < opener.y);
        assert.equal(overlap, false, `${id}: destructive button is not under the spot that opened the box`);
      }
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.dataset.role), 'cancel', `${id}: Cancel is the default`);
      if (how === 'button') await page.click(`[data-dialog=${id}] [data-role=cancel]`);
      if (how === 'outside') await page.mouse.click(5, 5);
      if (how === 'escape') await page.keyboard.press('Escape');
      await page.waitForSelector(`[data-dialog=${id}]`, { state: 'detached' });
      await unchanged();
    }
  }
  const box = sel => page.locator(sel).boundingBox();
  const clickAndBox = sel => async () => { const b = await box(sel); await page.click(sel); return b; };

  await begin(page);
  await H.logSet(page);
  await H.logSet(page);
  const countIs = n => async () => assert.equal((await H.openSession(page)).doc.sets.length, n);

  // Undo last set.
  await cancelThreeWays('undo', clickAndBox('[data-action=undo]'), countIs(2));
  await page.click('[data-action=undo]');
  assert.match(norm(await page.textContent('[data-dialog=undo] h2')), /^Remove the last set \(40 kg × 12\)\?$/);
  await page.click('[data-dialog=undo] [data-role=ok]');
  await H.waitFor(async () => (await H.openSession(page)).doc.sets.length === 1, { message: 'undo' });

  // Delete a set (from Edit Set).
  await H.logSet(page);
  const setId = (await H.openSession(page)).doc.sets.find(s => s.set_number === 1).set_id;
  await page.click(`[data-set="${setId}"]`);
  await page.waitForSelector('[data-sheet=edit]');
  await cancelThreeWays('delete-set', clickAndBox('[data-sheet=edit] [data-action=delete]'), countIs(2));
  await page.click('[data-sheet=edit] [data-action=delete]');
  assert.equal(norm(await page.textContent('[data-dialog=delete-set] h2')), 'Delete set 1 of Test Machine Press?');
  await page.click('[data-dialog=delete-set] [data-role=ok]');
  await H.waitFor(async () => (await H.openSession(page)).doc.sets.length === 1, { message: 'delete set' });
  const left = (await H.openSession(page)).doc.sets;
  assert.equal(left[0].set_number, 1, 'later sets renumbered');

  // End Workout.
  await cancelThreeWays('end', clickAndBox('[data-action=end]'), async () => assert.ok(await H.openSession(page)));
  await page.click('[data-action=end]');
  assert.equal(norm(await page.textContent('[data-dialog=end] h2')), 'End workout?');
  assert.equal(norm(await page.textContent('[data-dialog=end] .boxtext')), '1 set logged');
  await page.click('[data-dialog=end] [data-role=ok]');
  await page.waitForSelector('#app[data-view=home]');
  assert.equal(await H.openSession(page), null);

  // Delete a past session (History).
  await page.click('[data-nav=history]');
  const target = H.fixtureDoc('2bd74d3b');
  await page.click(`[data-session="${target.session_id}"]`);
  await page.waitForSelector('#app[data-view=session]');
  const statusOf = async () => (await H.readDB(page)).sessions.find(s => s.id === target.session_id).doc.status;
  await cancelThreeWays('delete-session', async () => { await page.locator('[data-action=delete-session]').scrollIntoViewIfNeeded(); const b = await box('[data-action=delete-session]'); await page.click('[data-action=delete-session]'); return b; },
    async () => assert.equal(await statusOf(), 'closed'));
  await page.click('[data-action=delete-session]');
  assert.equal(norm(await page.textContent('[data-dialog=delete-session] h2')), 'Delete the session of 3 November?');
  await page.click('[data-dialog=delete-session] [data-role=ok]');
  await H.waitFor(async () => (await statusOf()) === 'deleted', { message: 'session deleted' });
  const del = (await H.readDB(page)).sessions.find(s => s.id === target.session_id).doc;
  assert.deepEqual(del.sets, []);
  assert.equal(del.revision, target.revision + 1);

  // Remove the token, and Replace the token (Settings).
  await page.waitForSelector('#app[data-view=history]');
  await page.click('[data-action=back]');
  await page.click('[data-nav=settings]');
  await page.waitForSelector('[data-token=saved]');
  const tokenIs = async () => assert.equal((await H.readDB(page)).kv.settings.token, 'good-token');
  await cancelThreeWays('replace-token', clickAndBox('[data-action=replace-token]'), tokenIs);
  await cancelThreeWays('remove-token', clickAndBox('[data-action=remove-token]'), tokenIs);
  await page.click('[data-action=remove-token]');
  assert.equal(norm(await page.textContent('[data-dialog=remove-token] h2')), 'Remove the saved token?');
  await page.click('[data-dialog=remove-token] [data-role=ok]');
  await H.waitFor(async () => (await H.readDB(page)).kv.settings.token === '', { message: 'token removed' });
  assert.deepEqual(app.dialogs, [], 'the browser\u2019s own pop-ups are never used');
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('App 9: double-tap guard: two taps within a second log one set', async () => {
  const app = await start();
  const { page } = app;
  await begin(page);
  await page.clock.fastForward(1100);
  await page.click('[data-action=log]');
  await page.click('[data-action=log]');
  await page.waitForTimeout(300);
  assert.equal((await H.openSession(page)).doc.sets.length, 1);
  await page.dblclick('[data-action=log]');
  await page.waitForTimeout(300);
  assert.equal((await H.openSession(page)).doc.sets.length, 1, 'still within the second after the log');
  await page.clock.fastForward(1100);
  await page.click('[data-action=log]');
  await H.waitFor(async () => (await H.openSession(page)).doc.sets.length === 2, { message: 'second set after a second' });
  await app.close();
});

test('App 10: auto-close after two hours, with the end time taken from the last set', async () => {
  const app = await start();
  const { page, fake } = app;
  await begin(page);
  await H.logSet(page);
  await page.clock.fastForward('05:00');
  await H.logSet(page);
  const last = (await H.openSession(page)).doc.sets[1].logged_at;
  // 1 h 59 min after the last set: still open.
  await page.clock.fastForward('01:59:00');
  await setVisibility(page, 'hidden');
  await setVisibility(page, 'visible');
  await page.waitForTimeout(200);
  assert.ok(await H.openSession(page), 'not closed before two hours');
  // Past two hours: closed when the app returns to the front.
  await page.clock.fastForward('02:00');
  await setVisibility(page, 'hidden');
  await setVisibility(page, 'visible');
  await page.waitForSelector('#app[data-view=home]');
  const db = await H.readDB(page);
  const s = db.sessions.find(x => x.doc.date === '2026-11-12');
  assert.equal(s.doc.status, 'auto_closed');
  assert.equal(s.doc.ended_at, last);
  assert.equal(await H.openSession(page), null);
  await H.waitFor(() => fake.sessionPaths().length === 1 && fake.json(fake.sessionPaths()[0]).status === 'auto_closed', { message: 'auto_closed uploaded' });
  // A session with no sets is discarded without trace, also on opening the app.
  await begin(page);
  const emptyId = (await H.openSession(page)).id;
  await page.clock.fastForward('02:01:00');
  await page.reload();
  await H.ready(page);
  assert.equal(await page.getAttribute('#app', 'data-view'), 'home');
  const db2 = await H.readDB(page);
  assert.equal(db2.sessions.find(x => x.id === emptyId), undefined);
  assert.equal(fake.sessionPaths().filter(p => p.includes(emptyId)).length, 0);
  await app.close();
});

test('App 11: a token rejected by the store shows the 6.4 message and loses nothing', async () => {
  const app = await start({ token: 'bad-token' });
  const { page, fake } = app;
  await begin(page);
  await H.logSet(page);
  await H.logSet(page);
  await H.waitFor(async () => /refused/.test(await H.strip(page)), { message: 'refused message' });
  assert.match(await H.strip(page), /GitHub refused the token\. Sets are safe on the phone\. Open Settings to replace it\./);
  let rec = await H.openSession(page);
  assert.equal(rec.doc.sets.length, 2);
  assert.equal(rec.dirty, true);
  assert.equal(fake.sessionPaths().length, 0);
  // Replace the token: everything goes up.
  await page.click('#strip');
  await page.waitForSelector('#app[data-view=settings]');
  await page.click('[data-action=replace-token]');
  await page.click('[data-dialog=replace-token] [data-role=ok]');
  await page.fill('input[name=token]', 'good-token');
  await page.click('[data-action=save-token]');
  await H.waitFor(() => fake.sessionPaths().length === 1, { message: 'upload with the new token' });
  await page.click('[data-action=back]');
  await page.waitForSelector('#app[data-view=workout]');
  rec = await H.openSession(page);
  assert.equal(fake.json(fake.sessionPaths()[0]).sets.length, 2);
  await H.waitFor(async () => /All uploaded/.test(await H.strip(page)), { message: 'All uploaded' });
  assert.ok(fake.log.every(l => l.auth === '' || l.auth.startsWith('Bearer ')));
  await app.close();
});

test('App 12: stopwatch: start, wait with the page hidden, stop; the seconds match the clock', async () => {
  const app = await start();
  const { page } = app;
  await begin(page);
  await H.goSlot(page, 4);
  await page.waitForSelector('[data-action=stopwatch]');
  await page.click('[data-action=stopwatch]');
  await page.waitForSelector('.watch.running');
  await setVisibility(page, 'hidden');
  await page.clock.fastForward(47000);
  await setVisibility(page, 'visible');
  await page.click('[data-action=stopwatch]');
  await page.waitForSelector('.watch:not(.running)');
  assert.equal((await H.entryValues(page)).value, '47');
  // A reload (or a crash) while it runs does not stop it: it is worked out from the start time.
  await page.click('[data-action=stopwatch]');
  await page.waitForSelector('.watch.running');
  await H.waitFor(async () => (await H.openSession(page)).ui.stopwatch, { message: 'stopwatch saved' });
  await page.clock.fastForward(20000);
  await page.reload();
  await H.ready(page);
  await page.waitForSelector('.watch.running');
  await page.clock.fastForward(10000);
  await page.click('[data-action=stopwatch]');
  await page.waitForSelector('.watch:not(.running)');
  assert.equal((await H.entryValues(page)).value, '30');
  await H.logSet(page, { advance: 0 });
  const set = (await H.openSession(page)).doc.sets[0];
  assert.equal(set.duration_s, 30);
  assert.equal(set.measure, 'time');
  assert.equal(set.reps, undefined);
  await app.close();
});

test('App 13: a setup refresh during a session does not alter that session', async () => {
  const app = await start();
  const { page, fake } = app;
  await begin(page);
  await H.logSet(page);
  const before = clone(await H.openSession(page));
  const s2 = clone(SETUP);
  s2.published_at = '2026-11-12T09:00:00+07:00';
  s2.hash = 'changed';
  s2.exercises.find(e => e.id === 'A01').name = 'Test Machine Press Renamed';
  s2.exercises.find(e => e.id === 'B01').note = 'A new note';
  s2.workouts.find(w => w.name === 'Test Upper').items.find(i => i.exercise_id === 'B01').sets = 5;
  fake.put('setup.json', JSON.stringify(s2, null, 2));
  await page.click('#strip');
  await page.click('[data-action=refresh-setup]');
  await H.waitFor(async () => (await H.readDB(page)).kv.setup.published_at === s2.published_at, { message: 'setup stored' });
  await page.click('[data-action=back]');
  await page.waitForSelector('#app[data-view=workout]');
  assert.match(await page.textContent('.ex.current .name'), /^Test Machine Press$/);
  assert.match((await H.panelInfo(page)).find(i => i.slot === 2).text, /3 × 10–12 reps/);
  await H.goSlot(page, 2);
  await page.waitForSelector('.ex.current[data-slot="2"]');
  assert.match(await page.textContent('.ex.current .notes'), /Neutral V-handle/);
  assert.doesNotMatch(await page.textContent('.ex.current .notes'), /A new note/);
  await H.goSlot(page, 1);
  await page.waitForSelector('.ex.current[data-slot="1"]');
  await H.logSet(page);
  const during = await H.openSession(page);
  assert.equal(during.doc.setup_published_at, before.doc.setup_published_at);
  assert.equal(during.doc.sets[1].exercise_name, 'Test Machine Press');
  assert.deepEqual(during.snapshot, before.snapshot);
  assert.deepEqual(during.slots, before.slots);
  await endWorkout(page);
  // The next session uses the new setup.
  await begin(page);
  assert.match(await page.textContent('.ex.current .name'), /^Test Machine Press Renamed$/);
  assert.match((await H.panelInfo(page)).find(i => i.slot === 2).text, /5 × 10–12 reps/);
  assert.equal((await H.openSession(page)).doc.setup_published_at, s2.published_at);
  await app.close();
});

test('App 14: nothing is requested from any address other than the app\u2019s own and api.github.com', async () => {
  const fake = new FakeGitHub();
  const app = await start({ sw: true, fake });
  const { page, srv, requests } = app;
  const auth = [];
  app.ctx.on('request', r => { const a = r.headers().authorization; if (a) auth.push(r.url()); });
  await H.waitForController(page);
  await page.reload();
  await H.ready(page);
  // A normal session touching every screen.
  await begin(page);
  await H.logSet(page);
  await page.click('[data-action=swap]');
  await page.click('[data-sheet=swap] [data-ex=A02]');
  await page.waitForSelector('[data-sheet=swap]', { state: 'detached' });
  assert.equal((await H.entryValues(page)).logText, 'Log Set 2', 'never done before: blank, Log inactive');
  await H.setEntry(page, 20, 12);
  await H.logSet(page);
  await page.click('[data-action=add-exercise]');
  await page.click('[data-sheet=add] [data-group=Core]');
  await page.click('[data-sheet=add] [data-ex=D01]');
  await H.logSet(page);
  const setId = (await H.openSession(page)).doc.sets[0].set_id;
  await H.goSlot(page, 1);
  await page.click(`[data-set="${setId}"]`);
  await page.click('[data-sheet=edit] .steps [data-kind=reps] [data-step=plus]');
  await page.click('[data-sheet=edit] [data-action=save]');
  await endWorkout(page, 'Normal session');
  await page.click('[data-nav=history]');
  await page.click('[data-action=back]');
  await page.click('[data-nav=settings]');
  await page.click('[data-action=test]');
  await page.waitForSelector('#conn-status.ok');
  await page.click('[data-action=refresh-setup]');
  await H.waitFor(async () => /All uploaded/.test(await H.strip(page)), { message: 'All uploaded' });
  const bad = requests.filter(u => !u.startsWith(`${srv.origin}/`) && !u.startsWith('https://api.github.com/') && !u.startsWith('blob:') && !u.startsWith('data:'));
  assert.deepEqual(bad, []);
  assert.ok(requests.some(u => u.startsWith('https://api.github.com/')), 'GitHub was used');
  assert.ok(auth.length > 0 && auth.every(u => u.startsWith('https://api.github.com/')), 'the token goes only to api.github.com');
  assert.ok(requests.filter(u => u.startsWith(srv.origin)).every(u => u.startsWith(`${srv.origin}/gym-log-app/`)), 'every own request stays under the app path');
  assert.deepEqual(app.errors, [], 'no script errors');
  // The only console messages allowed are the browser's network log for GitHub's expected
  // 404 when the app asks whether a new session file exists (brief 6.3 step 2).
  assert.deepEqual(app.consoleErrors.filter(m => !/Failed to load resource: the server responded with a status of 404/.test(m)), []);
  assert.deepEqual(app.dialogs, []);
  await app.close();
});

// ---------------------------------------------------------------------------
// Beyond 10.3: the data contract, the shell, restore, export, storage failure.

test('Contract: a session file made by the app matches the fixture shape', async () => {
  const fake = new FakeGitHub();
  const app = await start({ fake });
  const { page } = app;
  // Preset workout: planned sets, a swap, an extra set, a time exercise, an added exercise, a correction.
  await begin(page);
  await H.logSet(page);
  await page.click('[data-action=swap]');
  await page.click('[data-sheet=swap] [data-ex=A03]');
  await H.setEntry(page, 12.5, 10);
  await H.logSet(page);
  await H.logSet(page);
  await page.waitForSelector('[data-dock=complete]');
  await page.clock.fastForward(1100);
  await page.click('.ex.current [data-action=add-set]');
  await page.waitForSelector('[data-dock=entry]');
  await H.logSet(page);
  await H.goSlot(page, 4);
  await page.waitForSelector('.ex.current[data-slot="4"]');
  await H.logSet(page);
  await page.click('[data-action=add-exercise]');
  await page.click('[data-sheet=add] [data-group=Legs]');
  await page.click('[data-sheet=add] [data-ex=C02]');
  await H.logSet(page);
  const first = (await H.openSession(page)).doc.sets[0].set_id;
  await H.goSlot(page, 1);
  await page.click(`[data-set="${first}"]`);
  await page.click('[data-sheet=edit] .steps [data-kind=weight] [data-step=plus]');
  await page.click('[data-sheet=edit] [data-action=save]');
  await endWorkout(page, 'Contract check');
  // Free-form session.
  await begin(page, '');
  await page.click('[data-sheet=add] [data-group=Core]');
  await page.click('[data-sheet=add] [data-ex=D02]');
  await H.logSet(page);
  await endWorkout(page);
  await H.waitFor(() => fake.sessionPaths().length === 2 && fake.sessionPaths().every(p => ['closed'].includes(fake.json(p).status)), { message: 'both uploaded' });

  const fixtures = H.FIXTURE_SESSIONS.map(s => JSON.parse(s.text));
  const fixtureClosed = fixtures.find(d => d.status === 'closed');
  const topKeys = Object.keys(fixtureClosed).sort();
  const fxSet = (measure, planned) => fixtures.flatMap(d => d.sets).find(s => s.measure === measure && !!s.planned_exercise_id === planned && !s.edited_at);
  // edited_at and the RIR pair (v1.1.0) are optional; they are checked separately below.
  const setKeys = s => Object.keys(s).filter(k => !['edited_at', 'rir', 'failed'].includes(k)).sort();
  // The fixtures have planned sets of both measures but an unplanned set only for reps, so the
  // unplanned shape is the planned one without the planned pair; checked here against reps.
  const expectedKeys = (measure, planned) => {
    const base = setKeys(fxSet(measure, true));
    return planned ? base : base.filter(k => !k.startsWith('planned_'));
  };
  assert.deepEqual(expectedKeys('reps', false), setKeys(fxSet('reps', false)));

  for (const p of fake.sessionPaths()) {
    const doc = fake.json(p);
    assert.deepEqual(Object.keys(doc).sort(), topKeys, `${p}: top-level keys as the fixtures`);
    assert.equal(doc.format, 1);
    assert.match(p, new RegExp(`^sessions/(\\d{4})/\\1-\\d\\d-\\d\\d_${doc.session_id}\\.json$`));
    assert.equal(p, `sessions/${doc.date.slice(0, 4)}/${doc.date}_${doc.session_id}.json`);
    assert.equal(doc.date, doc.started_at.slice(0, 10));
    for (const k of ['started_at', 'ended_at', 'updated_at']) assert.match(doc[k], ISO, `${k} is ISO with offset`);
    assert.ok(doc.started_at.endsWith('+07:00'));
    assert.ok(Number.isInteger(doc.revision) && doc.revision > 0);
    assert.equal(doc.setup_published_at, SETUP.published_at);
    assert.equal(typeof doc.app_version, 'string');
    for (const s of doc.sets) {
      assert.deepEqual(setKeys(s), expectedKeys(s.measure, !!s.planned_exercise_id), `set keys for ${s.measure}, planned=${!!s.planned_exercise_id}`);
      assert.match(s.logged_at, ISO);
      if (s.edited_at !== undefined) assert.match(s.edited_at, ISO);
      assert.equal('rir' in s, 'failed' in s, 'rir and failed come together');
      if ('rir' in s) {
        assert.ok(Number.isInteger(s.rir) && s.rir >= 0 && s.rir <= 5);
        assert.equal(typeof s.failed, 'boolean');
        if (s.failed) assert.equal(s.rir, 0);
      }
      assert.equal(typeof s.weight_kg, 'number');
      if (s.measure === 'reps') assert.ok(Number.isInteger(s.reps)); else assert.ok(Number.isInteger(s.duration_s));
      const ex = SETUP.exercises.find(e => e.id === s.exercise_id);
      assert.deepEqual([s.exercise_name, s.group, s.type, s.measure], [ex.name, ex.group, ex.type, ex.measure]);
    }
    const positions = [...new Set(doc.sets.map(s => s.position))].sort((a, b) => a - b);
    for (const pos of positions) {
      const nums = doc.sets.filter(s => s.position === pos).map(s => s.set_number).sort((a, b) => a - b);
      assert.deepEqual(nums, nums.map((_, i) => i + 1));
    }
    // The fixtures carry the RIR pair too, in the same shape.
    for (const f of fixtures) for (const s of f.sets) assert.equal('rir' in s, 'failed' in s);
  }
  const preset = fake.sessionPaths().map(p => fake.json(p)).find(d => d.workout_name === 'Test Upper');
  const free = fake.sessionPaths().map(p => fake.json(p)).find(d => d.workout_name === '');
  assert.ok(preset.sets.some(s => s.planned_exercise_id && s.planned_exercise_id !== s.exercise_id), 'swap recorded');
  assert.ok(preset.sets.some(s => s.set_number === 4), 'extra set recorded');
  assert.ok(preset.sets.some(s => s.edited_at), 'correction recorded');
  const added = preset.sets.find(s => s.exercise_id === 'C02');
  assert.equal(added.position, 5);
  assert.equal(added.planned_exercise_id, undefined, 'added exercise has no planned exercise');
  assert.ok(free.sets.every(s => s.planned_exercise_id === undefined && s.planned_exercise_name === undefined));
  assert.equal(preset.comment, 'Contract check');
  // RIR: only the last set of slot 1 (the extra set 4) carries the default; set 3's moved to it (v1.1.1).
  assert.deepEqual(preset.sets.filter(s => s.position === 1).sort((a, b) => a.set_number - b.set_number).map(s => [s.rir, s.failed]),
    [[undefined, undefined], [undefined, undefined], [undefined, undefined], [3, false]]);
  assert.ok(preset.sets.filter(s => s.position !== 1).every(s => s.rir === undefined), 'no RIR on slots that are not complete');
  await app.close();
});

test('Shell: service worker caches every app file; manifest, icons, meta tags, CSP and relative URLs', async () => {
  const docs = path.resolve(__dirname, '..', '..', 'docs');
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(docs).map(f => path.relative(docs, f).split(path.sep).join('/')).filter(f => f !== 'sw.js');
  const sw = fs.readFileSync(path.join(docs, 'sw.js'), 'utf8');
  const listed = JSON.parse(sw.match(/const FILES = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  for (const f of files) assert.ok(listed.includes(f), `${f} is in the service worker's cache list`);
  for (const f of listed) assert.ok(f === './' || files.includes(f), `${f} exists`);
  const manifest = JSON.parse(fs.readFileSync(path.join(docs, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.name, 'Swole');
  assert.equal(manifest.short_name, 'Swole');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.orientation, 'portrait');
  assert.equal(manifest.start_url, './');
  const html = fs.readFileSync(path.join(docs, 'index.html'), 'utf8');
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /apple-touch-icon" href="icons\/icon-180.png"/);
  assert.match(html, /apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /default-src 'self'/);
  assert.match(html, /connect-src 'self' https:\/\/api\.github\.com;/);
  assert.match(html, /img-src 'self' data:/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)/, 'no inline script');
  assert.doesNotMatch(html, /style=/, 'no inline style');
  assert.doesNotMatch(html, /(src|href)="\//, 'no root-relative URLs');
  for (const f of files.filter(f => /\.(js|css|html|webmanifest)$/.test(f))) {
    const text = fs.readFileSync(path.join(docs, f), 'utf8');
    const urls = text.match(/https?:\/\/[^\s'"`)]+/g) || [];
    assert.deepEqual(urls.filter(u => !u.startsWith('https://api.github.com')), [], `${f} names no other site`);
    assert.doesNotMatch(text, /window\.(confirm|alert|prompt)|[^.\w](alert|confirm|prompt)\(/, `${f} uses no browser pop-ups`);
    assert.doesNotMatch(text, /console\.log/, `${f} logs nothing`);
  }
  for (const size of [180, 192, 512]) {
    const png = fs.readFileSync(path.join(docs, 'icons', `icon-${size}.png`));
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  // In the browser: version shown in Settings, persistent storage asked for on first run, owner default.
  const app = await start({ history: false });
  const { page } = app;
  const version = fs.readFileSync(path.join(docs, 'version.js'), 'utf8').match(/SWOLE_VERSION = '([^']+)'/)[1];
  await page.click('[data-nav=settings]');
  assert.equal(await page.getAttribute('[data-version]', 'data-version'), version);
  await page.waitForSelector('#persist-status[data-persisted]');
  assert.match(await page.textContent('#persist-status'), /Persistent storage: (granted|not granted)/);
  const db = await H.readDB(page);
  assert.ok(db.kv.meta.persist_asked, 'persistent storage requested on first run');
  // Tap-target sizes are measured screen by screen in the "Tap targets" test.
  await page.click('[data-action=back]');
  await begin(page);
  const fonts = await page.evaluate(() => [...document.querySelectorAll('input, textarea')].map(e => parseFloat(getComputedStyle(e).fontSize)));
  assert.ok(fonts.every(f => f >= 16), 'inputs are at least 16 px');
  await app.close();
});

test('Restore: with a working token and no sessions, the app offers and downloads its history', async () => {
  const fake = new FakeGitHub();
  fake.put('setup.json', JSON.stringify(SETUP, null, 2));
  for (const s of H.FIXTURE_SESSIONS) fake.put(s.path, s.text);
  const app = await start({ fake, history: false });
  const { page } = app;
  await page.waitForSelector('[data-banner=restore]');
  await page.click('[data-banner=restore] [data-action=restore]');
  // The restore writes every file first, then auto-closes the stale open session; the banner goes
  // only when all of that is done.  Waiting for the count alone raced the auto-close (seen once).
  await page.waitForSelector('[data-banner=restore]', { state: 'detached' });
  await H.waitFor(async () => (await H.readDB(page)).sessions.length === H.FIXTURE_SESSIONS.length, { message: 'all sessions downloaded' });
  const db = await H.readDB(page);
  for (const s of H.FIXTURE_SESSIONS) {
    const doc = JSON.parse(s.text);
    const rec = db.sessions.find(r => r.id === doc.session_id);
    assert.equal(rec.path, s.path);
    if (doc.status !== 'open') {
      assert.deepEqual(rec.doc, doc, 'a closed session is stored exactly as downloaded');
      assert.equal(rec.dirty, false);
      assert.equal(rec.sha, fake.get(s.path).sha);
    }
  }
  // The fixture's open session is more than two hours old here, so it is auto-closed by the normal route.
  const open = db.sessions.find(r => r.id.startsWith('f271ee04'));
  assert.equal(open.doc.status, 'auto_closed');
  assert.equal(open.doc.ended_at, '2026-11-10T16:48:00+07:00');
  await page.click('[data-nav=history]');
  assert.equal(await page.locator('[data-session]').count(), H.FIXTURE_SESSIONS.length - 1, 'History lists every session but the deleted one');
  // Pre-fill now works from the downloaded history.
  await page.click('[data-action=back]');
  await begin(page, 'Test Lower');
  const e = await H.entryValues(page);
  assert.deepEqual([e.weight, e.value], ['130', '13']);
  assert.deepEqual(fake.puts.map(p => p.path), [open.path], 'only the auto-closed session was written back');
  await app.close();
});

test('Export: one file with every session and the setup, and no token', async () => {
  const app = await start();
  const { page } = app;
  await page.click('[data-nav=settings]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export]')]);
  const text = fs.readFileSync(await download.path(), 'utf8');
  const data = JSON.parse(text);
  assert.match(download.suggestedFilename(), /^swole-export-2026-11-12\.json$/);
  assert.equal(data.sessions.length, H.closedFixtureDocs().length);
  assert.deepEqual(data.setup, SETUP);
  assert.ok(!text.includes('good-token'), 'the token is not exported');
  await app.close();
});

test('Storage failure: a set that cannot be written is named in a blocking message and not shown as logged', async () => {
  const app = await start();
  const { page } = app;
  await begin(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...a) {
      if (this.name === 'sessions') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return put.apply(this, a);
    };
  });
  await page.clock.fastForward(1100);
  await page.click('[data-action=log]');
  await page.waitForSelector('[data-dialog=storage-failed]');
  assert.match(norm(await page.textContent('[data-dialog=storage-failed]')), /Set 1 of Test Machine Press \(40 kg × 12\) was not saved/);
  assert.equal(await page.locator('.ex.current .set.done').count(), 0);
  await page.click('[data-dialog=storage-failed] [data-role=ok]');
  assert.equal((await H.openSession(page)).doc.sets.length, 0);
  await app.close();
});

test('Update: at cold start a waiting version takes over and the page reloads once; never after it is in use', async () => {
  const app = await start({ sw: true });
  const { page, ctx, srv } = app;
  const swVersion = p => p.evaluate(() => self.SWOLE_VERSION);
  const waiting = p => p.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()).waiting);
  const original = await swVersion(page);
  try {
    await H.waitForController(page);
    // A new version is published; the running page (an app in use) finds it and downloads it.
    srv.overrides['version.js'] = "self.SWOLE_VERSION = '9.9.9-test';\n";
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
    await H.waitFor(() => waiting(page), { message: 'new version waiting' });
    let navA = 0;
    page.on('framenavigated', f => { if (f === page.mainFrame()) navA++; });
    // Cold start of the app while the old page is still alive, so the new version is still waiting.
    const b = await ctx.newPage();
    let navB = 0;
    b.on('framenavigated', f => { if (f === b.mainFrame()) navB++; });
    await b.goto(srv.base);
    await H.waitFor(async () => { try { return (await swVersion(b)) === '9.9.9-test'; } catch { return false; } }, { message: 'new version in use' });
    await H.ready(b);
    assert.equal(navB, 2, 'exactly one reload');
    assert.equal((await H.readDB(b)).kv.swReload.from, original);
    await b.waitForTimeout(500);
    assert.equal(navA, 0, 'the page already in use is never reloaded');
    assert.equal(await swVersion(page), original);
    // Loop guard: a marker for the running version blocks a second reload even if another version waits.
    await H.seed(b, {});
    await b.evaluate(async () => {
      const db = await new Promise(r => { const q = indexedDB.open('swole', 1); q.onsuccess = () => r(q.result); });
      await new Promise(r => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put({ from: '9.9.9-test', at: 'x' }, 'swReload'); t.oncomplete = r; });
      db.close();
    });
    srv.overrides['version.js'] = "self.SWOLE_VERSION = '9.9.9-next';\n";
    await b.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
    await H.waitFor(() => waiting(b), { message: 'second version waiting' });
    const c = await ctx.newPage();
    let navC = 0;
    c.on('framenavigated', f => { if (f === c.mainFrame()) navC++; });
    await c.goto(srv.base);
    await H.ready(c);
    await c.waitForTimeout(800);
    assert.equal(navC, 1, 'no reload when the marker says this version already reloaded');
    assert.equal(await swVersion(c), '9.9.9-test');
    assert.deepEqual(app.errors, []);
  } finally {
    delete srv.overrides['version.js'];
    await app.close();
  }
});

test('Tap targets: every button and tappable row on every screen is at least 44 × 44 (brief 5.1)', async () => {
  const app = await start();
  const { page } = app;
  const problems = [];
  const measure = async screen => {
    // One atomic evaluation, so a re-render cannot detach elements between query and measurement.
    const r = await page.evaluate(() => {
      const sel = '#app button, #app input, #app textarea, #app a, #app [role=button], #sheets button, #sheets input, #dialogs button, #dialogs input, #dialogs textarea';
      const els = [...document.querySelectorAll(sel)].filter(e => e.getClientRects().length);
      const small = els.map(e => {
        const b = e.getBoundingClientRect();
        return { what: (e.textContent || e.name || e.getAttribute('aria-label') || e.tagName).trim().slice(0, 30), w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 };
      }).filter(x => x.w < 44 || x.h < 44);
      return { count: els.length, small };
    });
    assert.ok(r.count > 0, `${screen}: something measured`);
    for (const s of r.small) problems.push(`${screen}: "${s.what}" ${s.w} × ${s.h}`);
  };
  await measure('Home');
  await begin(page);
  await H.logSet(page);
  await measure('Active Workout (reps)');
  await H.logSet(page);
  await H.logSet(page);
  await page.waitForSelector('[data-dock=complete] [data-action=next-dock]');
  await measure('Done state (Next and + Extra set)');
  await page.click('[data-action=exercises]');
  await page.waitForSelector('[data-sheet=exercises]');
  await measure('Exercises panel');
  await page.click('[data-sheet=exercises] [data-action=cancel]');
  await page.click('[data-action=home]');
  await page.waitForSelector('[data-action=resume]');
  await measure('Home (workout open)');
  await page.click('[data-action=resume]');
  await page.waitForSelector('#app[data-view=workout]');
  await H.goSlot(page, 4);
  await page.waitForSelector('[data-action=stopwatch]');
  await measure('Active Workout (time)');
  await page.click('[data-action=stopwatch]');
  await page.waitForSelector('.watch.running');
  await measure('Active Workout (stopwatch running)');
  await page.click('[data-action=stopwatch]');
  await page.click('[data-action=swap]');
  await page.waitForSelector('[data-sheet=swap]');
  await measure('Swap');
  await page.click('[data-sheet=swap] [data-action=cancel]');
  await page.click('[data-action=add-exercise]');
  await page.waitForSelector('[data-sheet=add] [data-group]');
  await measure('Add Exercise (groups)');
  await page.click('[data-sheet=add] [data-group=Pull]');
  await page.waitForSelector('[data-sheet=add] [data-ex]');
  await measure('Add Exercise (exercises)');
  await page.click('[data-sheet=add] [data-action=cancel]');
  await H.goSlot(page, 1);
  const setId = (await H.openSession(page)).doc.sets[0].set_id;
  await page.click(`[data-set="${setId}"]`);
  await page.waitForSelector('[data-sheet=edit]');
  await measure('Edit Set');
  await page.click('[data-sheet=edit] [data-action=cancel]');
  await page.click('[data-action=end]');
  await page.waitForSelector('[data-dialog=end]');
  await measure('End Workout box');
  await page.click('[data-dialog=end] [data-role=ok]');
  await page.waitForSelector('#app[data-view=home]');
  await page.click('[data-nav=history]');
  await page.waitForSelector('#app[data-view=history]');
  await measure('History');
  await page.click('[data-session^="a8b0b276"]');
  await page.waitForSelector('#app[data-view=session]');
  await measure('History session');
  await page.click('[data-action=back]');
  await page.click('[data-action=back]');
  await page.click('[data-nav=settings]');
  await page.waitForSelector('#app[data-view=settings]');
  await measure('Settings');
  await page.click('[data-action=replace-token]');
  await page.click('[data-dialog=replace-token] [data-role=ok]');
  await page.waitForSelector('input[name=token]');
  await measure('Settings (token entry)');
  assert.deepEqual(problems, []);
  await app.close();
});

// ---------------------------------------------------------------------------
// Lost database connection (iOS closes it for a backgrounded or suspended page).
// Simulation: the test closes the page's IndexedDB connection with IDBDatabase.close()
// behind the app's back, so the app's next db.transaction() throws InvalidStateError
// "The database connection is closing", the error seen on the iPhone.

const failureBox = page => page.$('[data-dialog=storage-failed]');

test('Lost connection (a): mid-session, the next Log tap reconnects and stores exactly one set', async () => {
  const app = await start();
  const { page } = app;
  await begin(page);
  await H.logSet(page);
  assert.ok((await H.closeConnections(page)) >= 1, 'a connection was closed');
  await H.logSet(page);
  await page.waitForTimeout(300);
  assert.equal(await failureBox(page), null, 'no "Not saved" box');
  const rec = await H.openSession(page);
  assert.equal(rec.doc.sets.length, 2, 'exactly one more set');
  assert.equal(new Set(rec.doc.sets.map(s => s.set_id)).size, 2);
  assert.equal(await page.locator('.ex.current .set.done').count(), 2);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('Lost connection (b): starting a workout from Home reconnects', async () => {
  const app = await start();
  const { page } = app;
  assert.ok((await H.closeConnections(page)) >= 1);
  await begin(page);
  assert.equal(await failureBox(page), null);
  const db = await H.readDB(page);
  assert.equal(db.sessions.filter(s => s.doc.status === 'open').length, 1, 'one session started');
  await H.logSet(page);
  assert.equal((await H.openSession(page)).doc.sets.length, 1);
  await app.close();
});

test('Lost connection (c): the upload marks the session uploaded after the connection is lost mid-upload', async () => {
  const fake = new FakeGitHub();
  const app = await start({ fake });
  const { page } = app;
  let release;
  fake.holdPut = new Promise(r => { release = r; });
  await begin(page);
  await H.logSet(page);
  await H.waitFor(() => fake.held === 1, { message: 'PUT in flight' });
  assert.ok((await H.closeConnections(page)) >= 1);
  fake.holdPut = null;
  release();
  await H.waitFor(async () => { const r = await H.openSession(page); return r && !r.dirty && r.sha; }, { message: 'session marked uploaded' });
  const rec = await H.openSession(page);
  const paths = fake.sessionPaths();
  assert.equal(paths.length, 1);
  assert.equal(rec.sha, fake.get(paths[0]).sha);
  assert.equal(fake.json(paths[0]).revision, rec.doc.revision);
  assert.equal(fake.puts.length, 1, 'no second upload was needed');
  assert.equal(await failureBox(page), null);
  await app.close();
});

test('Lost connection (e): after a background/foreground cycle the connection is replaced before the first tap', async () => {
  const app = await start();
  const { page } = app;
  await begin(page);
  await H.logSet(page);
  await setVisibility(page, 'hidden');
  assert.ok((await H.closeConnections(page)) >= 1);
  await setVisibility(page, 'visible');
  await H.waitFor(() => page.evaluate(() => window.__idbConns.length >= 1), { message: 'connection reopened on return to the front' });
  await H.logSet(page);
  assert.equal(await failureBox(page), null);
  assert.equal((await H.openSession(page)).doc.sets.length, 2);
  // The same through a back-forward-cache style restore (pageshow with persisted).
  assert.ok((await H.closeConnections(page)) >= 1);
  await page.evaluate(() => { const e = new Event('pageshow'); Object.defineProperty(e, 'persisted', { value: true }); window.dispatchEvent(e); });
  await H.waitFor(() => page.evaluate(() => window.__idbConns.length >= 1), { message: 'connection reopened on pageshow' });
  await H.logSet(page);
  assert.equal((await H.openSession(page)).doc.sets.length, 3);
  assert.deepEqual(app.errors, []);
  await app.close();
});

// ---------------------------------------------------------------------------
// Layout: the figure fits, the current exercise fills the middle, Home during a workout.

/** Is the whole figure visible?  Both the input's own overflow and the measured text width. */
async function figureFits(page, selector) {
  return page.evaluate(sel => {
    const el = document.querySelector(sel);
    const cs = getComputedStyle(el);
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const text = ctx.measureText(el.value).width * (1 + parseFloat(cs.letterSpacing || 0) / parseFloat(cs.fontSize) || 1);
    return { value: el.value, scroll: el.scrollWidth, client: el.clientWidth, text: Math.ceil(ctx.measureText(el.value).width), size: parseFloat(cs.fontSize) };
  }, selector);
}

test('Stepper figure: 42.5, 122.5, 21.25, 102.25 and 120 s show whole in the dock and in Edit Set at 430 and 390 px', async () => {
  const app = await start();
  const { page } = app;
  await begin(page);
  await H.logSet(page);
  const bad = [];
  for (const width of [430, 390]) {
    await page.setViewportSize({ width, height: width === 430 ? 932 : 844 });
    await H.goSlot(page, 1);
    for (const v of ['42.5', '122.5', '21.25', '102.25', '45', '120']) {
      // While typing: character by character, checked after every keystroke.
      await page.fill('.dock input[name=weight]', '');
      for (const ch of v) {
        await page.type('.dock input[name=weight]', ch);
        const f = await figureFits(page, '.dock input[name=weight]');
        if (f.scroll > f.client || f.text > f.client) bad.push(`${width}px dock typing ${f.value}: text ${f.text}, box ${f.client}, scroll ${f.scroll}`);
        if (f.size < 16) bad.push(`${width}px dock ${f.value}: font ${f.size}px < 16`);
      }
      const f = await figureFits(page, '.dock input[name=weight]');
      if (width === 430 && v.length <= 3 && f.size !== 38) bad.push(`430px: ${v} should be full size, is ${f.size}px`);
    }
    // Seconds on a time exercise, set with the buttons.
    await H.goSlot(page, 4);
    await page.fill('.dock input[name=seconds]', '115');
    await page.click('.dock [data-kind=secs] [data-step=plus]');
    let f = await figureFits(page, '.dock input[name=seconds]');
    assert.equal(f.value, '120');
    if (f.scroll > f.client || f.text > f.client) bad.push(`${width}px seconds 120 cut`);
    // Edit Set panel.
    await H.goSlot(page, 1);
    const setId = (await H.openSession(page)).doc.sets[0].set_id;
    await page.click(`[data-set="${setId}"]`);
    await page.waitForSelector('[data-sheet=edit]');
    for (const v of ['42.5', '122.5', '21.25', '102.25']) {
      await page.fill('[data-sheet=edit] input[name=edit-weight]', v);
      f = await figureFits(page, '[data-sheet=edit] input[name=edit-weight]');
      if (f.scroll > f.client || f.text > f.client) bad.push(`${width}px edit ${v}: text ${f.text}, box ${f.client}, scroll ${f.scroll}`);
    }
    // The + button never pushes the figure out either (42.5 → 45 → ... with 2.5 steps on 102.25).
    await page.fill('[data-sheet=edit] input[name=edit-weight]', '99.75');
    await page.click('[data-sheet=edit] [data-kind=weight] [data-step=plus]');
    f = await figureFits(page, '[data-sheet=edit] input[name=edit-weight]');
    if (f.scroll > f.client || f.text > f.client) bad.push(`${width}px edit after + ${f.value} cut`);
    await page.click('[data-sheet=edit] [data-action=cancel]');
    // The − and + buttons keep their size.
    const pm = await page.locator('.dock .pm').first().boundingBox();
    assert.deepEqual([pm.width, pm.height], [56, 56]);
  }
  assert.deepEqual(bad, []);
  await app.close();
});

test('Workout layout: the current exercise fills the middle; sets scroll inside it; Next line; Exercises panel', async () => {
  const app = await start();
  const { page } = app;
  await begin(page);
  // The current card fills the space between the strip and the dock; there is no list behind it.
  const geo = await page.evaluate(() => {
    const r = s => document.querySelector(s).getBoundingClientRect();
    return { strip: r('#strip').bottom, card: r('.ex.current'), dock: r('.dock').top, cards: document.querySelectorAll('#app .ex').length };
  });
  assert.equal(geo.cards, 1, 'only the current exercise is drawn');
  assert.ok(geo.card.top - geo.strip <= 16 && geo.dock - geo.card.bottom <= 16, `card fills the middle (${JSON.stringify(geo)})`);
  assert.equal(norm(await page.innerText('[data-action=exercises]')), 'Exercises 1 of 4 ▾');
  // Next line.
  assert.equal(norm(await page.innerText('[data-action=next]')), 'Next: Test Cable Row · 3 × 10–12 reps ›');
  await page.click('[data-action=next]');
  await page.waitForSelector('.ex.current[data-slot="2"]');
  assert.equal(norm(await page.innerText('[data-action=exercises]')), 'Exercises 2 of 4 ▾');
  assert.match(norm(await page.innerText('[data-action=next]')), /^Next: Test Assisted Pull-Up · 3 × 6–10 reps/);
  // Many sets: the list scrolls inside the card, the card and the Next line stay put.
  await H.goSlot(page, 1);
  for (let i = 0; i < 3; i++) await H.logSet(page);
  for (let i = 0; i < 6; i++) {
    await H.tapExtra(page);    // the exercise stays current: one tap for each further set
    await H.logSet(page);
  }
  assert.ok(await page.$('.ex.current[data-slot="1"]'));
  const inner = await page.evaluate(() => {
    const l = document.querySelector('.setlist');
    const card = document.querySelector('.ex.current').getBoundingClientRect();
    const next = document.querySelector('.next').getBoundingClientRect();
    const dock = document.querySelector('.dock').getBoundingClientRect();
    return { scrolls: l.scrollHeight > l.clientHeight, scrolled: l.scrollTop > 0, nextInCard: next.bottom <= card.bottom + 1, cardAboveDock: card.bottom <= dock.top, pageScroll: document.querySelector('#app .main').scrollHeight <= document.querySelector('#app .main').clientHeight + 1 };
  });
  assert.deepEqual(inner, { scrolls: true, scrolled: true, nextInCard: true, cardAboveDock: true, pageScroll: true });
  // Exercises panel: every exercise in order, progress, the current one marked; tap one; Cancel.
  const info = await H.panelInfo(page);
  assert.deepEqual(info.map(i => i.slot), [1, 2, 3, 4]);
  assert.match(info[0].text, /Test Machine Press\s*now 9 of 9 sets/);
  assert.equal(info[0].current, true);
  assert.equal(info[0].done, true);
  assert.match(info[1].text, /Test Cable Row 0?.*not started · 3 × 10–12 reps/);
  await page.click('[data-action=exercises]');
  await page.click('[data-sheet=exercises] [data-slot="3"]');
  await page.waitForSelector('[data-sheet=exercises]', { state: 'detached' });
  await page.waitForSelector('.ex.current[data-slot="3"]');
  // All planned sets logged: the Next line says so, and the dock offers + Set.
  for (const pos of [3, 4, 2]) {
    await H.goSlot(page, pos);
    for (let i = 0; i < 3; i++) await H.logSet(page);
  }
  await page.waitForSelector('[data-dock=complete]');
  assert.match(norm(await page.innerText('[data-next=none]')), /^Next: nothing left — all planned sets logged$/);
  assert.match(norm((await H.panelInfo(page)).map(i => i.text).join(' | ')), /3 of 3 sets.*3 of 3 sets.*3 of 3 sets/);
  // Free-form: the same layout; the panel lists the exercises added so far.
  await endWorkout(page);
  await begin(page, '');
  await page.click('[data-sheet=add] [data-group=Core]');
  await page.click('[data-sheet=add] [data-ex=D02]');
  await page.waitForSelector('.ex.current[data-slot="1"]');
  await page.click('[data-action=add-exercise]');
  await page.click('[data-sheet=add] [data-group=Push]');
  await page.click('[data-sheet=add] [data-ex=A01]');
  await page.waitForSelector('.ex.current[data-slot="2"]');
  const free = await H.panelInfo(page);
  assert.deepEqual(free.map(i => [i.slot, i.current]), [[1, false], [2, true]]);
  assert.match(free[0].text, /Test Bodyweight Crunch.*not started/);
  assert.match(norm(await page.innerText('[data-next=none]')), /^Next: add another exercise below when ready$/);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('Home during a workout: Home button keeps the session open; Resume card; starts disabled; auto-close still applies', async () => {
  const app = await start();
  const { page } = app;
  await begin(page);
  await H.logSet(page);
  const id = (await H.openSession(page)).id;
  const hb = await page.locator('[data-action=home]').boundingBox();
  assert.ok(hb.x < 40 && hb.y < 40 && hb.width >= 44 && hb.height >= 44, 'Home is at the top left, at least 44 × 44');
  await page.click('[data-action=home]');
  await page.waitForSelector('#app[data-view=home]');
  assert.equal(await page.$('#dialogs .box'), null, 'no confirmation box');
  assert.equal((await H.openSession(page)).id, id, 'the session is still open');
  assert.equal(norm(await page.innerText('[data-action=resume]')), 'Resume Test Upper 1 set logged · started 16:30 ›');
  const first = await page.evaluate(() => document.querySelector('#app .main').firstElementChild.dataset.action);
  assert.equal(first, 'resume', 'the Resume card is at the top');
  assert.ok(await page.$eval('[data-workout="Test Lower"]', b => b.disabled));
  assert.ok(await page.$eval('[data-workout=""]', b => b.disabled));
  assert.equal(norm(await page.innerText('[data-hint=one-open]')), 'End the open workout to start another.');
  // History and Settings are reachable.
  await page.click('[data-nav=history]');
  await page.waitForSelector('#app[data-view=history]');
  await page.click('[data-action=back]');
  await page.click('[data-nav=settings]');
  await page.waitForSelector('#app[data-view=settings]');
  await page.click('[data-action=back]');
  await page.waitForSelector('#app[data-view=home]');
  // Resume returns to the same workout and exercise.
  await page.click('[data-action=resume]');
  await page.waitForSelector('#app[data-view=workout]');
  assert.equal((await H.openSession(page)).doc.sets.length, 1);
  // A cold start with an open session goes straight to the workout.
  await page.click('[data-action=home]');
  await page.reload();
  await H.ready(page);
  assert.equal(await page.getAttribute('#app', 'data-view'), 'workout');
  // Auto-close applies while on Home.
  await page.click('[data-action=home]');
  await page.waitForSelector('[data-action=resume]');
  await page.clock.fastForward('02:01:00');
  await setVisibility(page, 'hidden');
  await setVisibility(page, 'visible');
  await page.waitForSelector('[data-action=resume]', { state: 'detached' });
  assert.equal((await H.readDB(page)).sessions.find(s => s.id === id).doc.status, 'auto_closed');
  assert.equal(await page.$eval('[data-workout="Test Lower"]', b => b.disabled), false);
  assert.equal(await page.$('[data-hint=one-open]'), null);
  assert.deepEqual(app.errors, []);
  await app.close();
});

// ---------------------------------------------------------------------------
// v1.0.1: no automatic jump after the last planned set.

test('Done state: after the last planned set the exercise stays; Next and + Extra set; nothing moves without a tap', async () => {
  const app = await start();
  const { page } = app;
  await begin(page);
  await H.logSet(page);
  await H.logSet(page);
  const logBox = await page.locator('[data-action=log]').boundingBox();
  await H.logSet(page);
  await page.waitForSelector('[data-dock=complete]');
  assert.ok(await page.$('.ex.current[data-slot="1"]'), 'still on the same exercise');
  assert.equal(await page.$('[data-action=log]'), null, 'no Log button in the done state');
  assert.equal(norm(await page.innerText('[data-done=next]')), '3 of 3 sets done · Test Machine Press');
  assert.equal(norm(await page.innerText('[data-action=next-dock]')), 'Next: Test Cable Row ›');
  assert.equal(norm(await page.innerText('[data-action=extra-set]')), '+ Extra set');
  // The Next button sits where the Log button was.
  const nextBox = await page.locator('[data-action=next-dock]').boundingBox();
  assert.ok(Math.abs(nextBox.y - logBox.y) < 2 && Math.abs(nextBox.height - logBox.height) < 2, `Next where Log was (${JSON.stringify([logBox, nextBox])})`);
  // Nothing on screen changes without a tap.
  const before = await page.innerHTML('#app .main');
  await page.clock.fastForward('05:00');
  assert.ok(await page.$('[data-dock=complete]') && await page.$('.ex.current[data-slot="1"]'));
  assert.equal((await page.innerHTML('#app .main')).replace(/\d+ min/g, ''), before.replace(/\d+ min/g, ''));
  // Next goes to the next exercise with sets left.
  await H.tapNext(page);
  assert.ok(await page.$('[data-dock=entry]'));
  // Sets before the last planned one keep moving within the exercise.
  await H.logSet(page);
  assert.ok(await page.$('.ex.current[data-slot="2"] ~ * , .ex.current[data-slot="2"]'));
  assert.match(await page.textContent('.dock .title b'), /^Set 2 of 3 · Test Cable Row$/);
  // No exercise left: "All planned sets logged" with + Extra set only.
  await H.logSet(page);
  await H.logSet(page);
  for (const pos of [3, 4]) {
    await H.goSlot(page, pos);
    for (let i = 0; i < 3; i++) await H.logSet(page);
  }
  await page.waitForSelector('[data-done=all]');
  assert.match(norm(await page.innerText('[data-done=all]')), /^All planned sets logged 3 of 3 sets done · Test Plank$/);
  assert.equal(await page.$('[data-action=next-dock]'), null);
  assert.ok(await page.$('[data-action=extra-set]'));
  assert.equal(await page.locator('[data-action=end]').count(), 1, 'End Workout only at the top');
  // Free-form exercises have no plan: after a set the dock is ready for the next one.
  await endWorkout(page);
  await begin(page, '');
  await page.click('[data-sheet=add] [data-group=Core]');
  await page.click('[data-sheet=add] [data-ex=D02]');
  await page.waitForSelector('[data-dock=entry]');
  // v1.1.0: they count as 3 planned sets inside the app, so after the third the done state appears.
  await H.setEntry(page, 0, 15);
  for (let i = 0; i < 2; i++) await H.logSet(page);
  assert.ok(await page.$('[data-dock=entry]'));
  assert.match(await page.textContent('.dock .title b'), /^Set 3 of 3 · Test Bodyweight Crunch$/);
  await H.logSet(page);
  await page.waitForSelector('[data-dock=complete]');
  assert.ok(await page.$('.ex.current[data-slot="1"]'), 'free-form stays on the same exercise');
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('Done state guard: a second tap within a second of logging the last set does not trigger Next', async () => {
  const app = await start();
  const { page } = app;
  await begin(page);
  await H.logSet(page);
  await H.logSet(page);
  await page.clock.fastForward(1100);
  const box = await page.locator('[data-action=log]').boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  // Double tap on the Log button: the first logs set 3, the second lands on Next.
  await page.mouse.click(x, y);
  await page.waitForSelector('[data-dock=complete] [data-action=next-dock]');
  await page.mouse.click(x, y);
  await page.waitForTimeout(300);
  assert.ok(await page.$('.ex.current[data-slot="1"]'), 'Next was not triggered');
  assert.equal((await H.openSession(page)).doc.sets.length, 3);
  // The same for + Extra set.
  await page.click('[data-action=extra-set]');
  await page.waitForTimeout(200);
  assert.ok(await page.$('[data-dock=complete]'), '+ Extra set ignored within the second as well');
  // After the second, Next works on one tap.
  await page.clock.fastForward(1100);
  await page.mouse.click(x, y);
  await page.waitForSelector('.ex.current[data-slot="2"]');
  await app.close();
});

test('Done state after reload: the done state comes back; an asked-for extra set comes back as its steppers', async () => {
  const app = await start();
  const { page } = app;
  await begin(page);
  for (let i = 0; i < 3; i++) await H.logSet(page);
  await page.waitForSelector('[data-dock=complete]');
  await page.reload();
  await H.ready(page);
  await page.waitForSelector('[data-dock=complete]');
  assert.ok(await page.$('.ex.current[data-slot="1"]'), 'done state of the same exercise, not the next one');
  // Chosen behaviour: after + Extra set and a reload before logging, the steppers for that set show.
  await H.tapExtra(page);
  await H.waitFor(async () => (await H.openSession(page)).slots[0].extra === 1, { message: 'extra saved' });
  await page.reload();
  await H.ready(page);
  await page.waitForSelector('[data-dock=entry]');
  assert.match(await page.textContent('.dock .title b'), /^Set 4 of 4 · Test Machine Press$/);
  const set3 = (await H.openSession(page)).doc.sets[2];
  const e = await H.entryValues(page);
  assert.deepEqual([e.weight, e.value], [String(set3.weight_kg), String(set3.reps)]);
  await app.close();
});

test('Done state corrections: Undo, Delete and Edit from the done state leave a coherent state', async () => {
  const app = await start();
  const { page } = app;
  await begin(page);
  for (let i = 0; i < 3; i++) await H.logSet(page);
  await page.waitForSelector('[data-dock=complete]');
  // Undo the last planned set: back to its steppers.
  await page.click('[data-action=undo]');
  await page.click('[data-dialog=undo] [data-role=ok]');
  await page.waitForSelector('[data-dock=entry]');
  assert.match(await page.textContent('.dock .title b'), /^Set 3 of 3 · Test Machine Press$/);
  await H.logSet(page);
  await page.waitForSelector('[data-dock=complete]');
  // Edit a set in the done state: still done.
  const sets = (await H.openSession(page)).doc.sets;
  await page.click(`[data-set="${sets[0].set_id}"]`);
  await page.click('[data-sheet=edit] [data-kind=reps] [data-step=plus]');
  await page.click('[data-sheet=edit] [data-action=save]');
  await page.waitForSelector('[data-sheet=edit]', { state: 'detached' });
  assert.ok(await page.$('[data-dock=complete]'));
  // Delete the last planned set: its steppers come back.
  await page.click(`[data-set="${sets[2].set_id}"]`);
  await page.click('[data-sheet=edit] [data-action=delete]');
  await page.click('[data-dialog=delete-set] [data-role=ok]');
  await page.waitForSelector('[data-dock=entry]');
  assert.match(await page.textContent('.dock .title b'), /^Set 3 of 3 · Test Machine Press$/);
  await H.logSet(page);
  // An extra set asked for but not logged goes away with an Undo: no phantom "Set 3 of 4".
  await H.tapExtra(page);
  await page.click('[data-action=undo]');
  await page.click('[data-dialog=undo] [data-role=ok]');
  await H.waitFor(async () => (await H.openSession(page)).doc.sets.length === 2, { message: 'undo saved' });
  await page.waitForSelector('[data-dock=entry]');
  assert.match(await page.textContent('.dock .title b'), /^Set 3 of 3 · Test Machine Press$/);
  const rec = await H.openSession(page);
  assert.equal(rec.slots[0].extra, 0);
  assert.deepEqual(rec.doc.sets.filter(s => s.position === 1).map(s => s.set_number), [1, 2]);
  assert.deepEqual(app.errors, []);
  await app.close();
});

// ---------------------------------------------------------------------------
// v1.1.0: reps in reserve (RIR) on the last set of an exercise.

const RIR = '.dock [data-kind=rir]';
const rirShown = page => page.textContent(`${RIR} output`);
/** Slot sets of the open session, in set order: [{n, rir, failed, hasRir, edited}] */
async function slotRir(page, pos) {
  const rec = await H.openSession(page);
  return rec.doc.sets.filter(s => s.position === pos).sort((a, b) => a.set_number - b.set_number)
    .map(s => ({ n: s.set_number, rir: s.rir, failed: s.failed, hasRir: 'rir' in s || 'failed' in s, edited: 'edited_at' in s }));
}
/** Tap a RIR button and wait until the stored value is the expected one. */
async function tapRir(page, step, pos, n, rir, failed) {
  await page.click(`${RIR} [data-step=${step}]`);
  await H.waitFor(async () => { const s = (await slotRir(page, pos)).find(x => x.n === n); return s.rir === rir && s.failed === failed; }, { message: `set ${n} rir ${rir}${failed ? ' F' : ''}` });
}

test('RIR (a): logging the last planned set stores rir 3, failed false, in the database and the uploaded file; earlier sets have none', async () => {
  const fake = new FakeGitHub();
  const app = await start({ fake });
  const { page } = app;
  await begin(page);
  await H.logSet(page);
  await H.logSet(page);
  assert.equal(await page.$(RIR), null, 'no RIR before the last planned set');
  await H.logSet(page);
  await page.waitForSelector('[data-dock=complete]');
  const sets = await slotRir(page, 1);
  assert.deepEqual(sets.map(s => [s.n, s.hasRir, s.rir, s.failed]), [[1, false, undefined, undefined], [2, false, undefined, undefined], [3, true, 3, false]]);
  assert.equal(sets[2].edited, false);
  // The RIR is part of the set's own write: one revision for the log.
  const rec = await H.openSession(page);
  assert.equal(rec.doc.revision, 4, 'start + three logs');
  // Layout per mockup frame B.
  assert.equal(await page.textContent(`${RIR} label`), 'RIR · Set 3');
  assert.equal(await page.innerText(`${RIR} label`), 'RIR · SET 3');
  assert.equal(await rirShown(page), '3');
  assert.equal(await page.textContent(`${RIR} small`), 'reps left in the tank');
  assert.equal(norm(await page.innerText('.dock .steps [data-action=extra-set]')), '+ Extra set');
  assert.equal(await page.locator('.dock [data-action=extra-set]').count(), 1, 'the old full-width button is gone');
  const geo = await page.evaluate(() => {
    const r = s => document.querySelector(s).getBoundingClientRect();
    return { rir: r('.dock [data-kind=rir]'), extra: r('.dock [data-action=extra-set]'), next: r('[data-action=next-dock]'), status: r('[data-done]') };
  });
  assert.ok(geo.rir.left < geo.extra.left && Math.abs(geo.rir.top - geo.extra.top) < 1 && Math.abs(geo.rir.height - geo.extra.height) < 1, `RIR left, + Extra set right, same height (${JSON.stringify(geo)})`);
  assert.ok(geo.status.bottom <= geo.rir.top && geo.rir.bottom <= geo.next.top, 'status, then the row, then Next');
  // The set row shows it.
  assert.match(norm(await page.innerText(`.ex.current [data-set="${rec.doc.sets[2].set_id}"]`)), /40 kg × 12 · RIR 3/);
  assert.doesNotMatch(norm(await page.innerText(`.ex.current [data-set="${rec.doc.sets[0].set_id}"]`)), /RIR/);
  await H.waitFor(() => fake.sessionPaths().length === 1 && fake.json(fake.sessionPaths()[0]).sets.length === 3, { message: 'uploaded' });
  const up = fake.json(fake.sessionPaths()[0]).sets.sort((a, b) => a.set_number - b.set_number);
  assert.deepEqual(up.map(s => [s.rir, s.failed]), [[undefined, undefined], [undefined, undefined], [3, false]]);
  assert.ok(!('rir' in up[0]) && !('failed' in up[0]));
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('RIR (b): minus to F stores rir 0 failed true; plus to 5+ stores 5 and stops; each tap one saved change', async () => {
  const fake = new FakeGitHub();
  const app = await start({ fake });
  const { page } = app;
  await begin(page);
  for (let i = 0; i < 3; i++) await H.logSet(page);
  await page.waitForSelector(RIR);
  await page.clock.fastForward(1100);
  const rev0 = (await H.openSession(page)).doc.revision;
  await tapRir(page, 'minus', 1, 3, 2, false);
  await tapRir(page, 'minus', 1, 3, 1, false);
  await tapRir(page, 'minus', 1, 3, 0, false);
  assert.equal(await rirShown(page), '0');
  await tapRir(page, 'minus', 1, 3, 0, true);
  assert.equal(await rirShown(page), 'F');
  assert.equal(await page.$eval(`${RIR} [data-step=minus]`, b => b.disabled), true, 'minus stops at F');
  await page.click(`${RIR} [data-step=minus]`, { force: true });
  await page.waitForTimeout(200);
  let rec = await H.openSession(page);
  assert.equal(rec.doc.revision, rev0 + 4, 'one revision per tap, none for the stopped tap');
  assert.deepEqual((await slotRir(page, 1))[2], { n: 3, rir: 0, failed: true, hasRir: true, edited: false });
  assert.match(norm(await page.innerText(`.ex.current [data-set="${rec.doc.sets[2].set_id}"]`)), /40 kg × 12 · F/);
  for (const v of [0, 1, 2, 3, 4]) await tapRir(page, 'plus', 1, 3, v, false);
  await tapRir(page, 'plus', 1, 3, 5, false);
  assert.equal(await rirShown(page), '5+');
  assert.equal(await page.$eval(`${RIR} [data-step=plus]`, b => b.disabled), true, 'plus stops at 5+');
  await page.click(`${RIR} [data-step=plus]`, { force: true });
  await page.waitForTimeout(200);
  rec = await H.openSession(page);
  assert.equal(rec.doc.revision, rev0 + 10);
  assert.equal(rec.doc.sets[2].rir, 5);
  assert.equal('edited_at' in rec.doc.sets[2], false, 'RIR in the done state is not a correction');
  assert.match(norm(await page.innerText(`.ex.current [data-set="${rec.doc.sets[2].set_id}"]`)), /· RIR 5\+/);
  // Uploaded: the latest value, one file.
  await H.waitFor(async () => { const r = await H.openSession(page); return !r.dirty && fake.sessionPaths().length === 1; }, { message: 'uploaded' });
  const up = fake.json(fake.sessionPaths()[0]);
  assert.equal(up.revision, rec.doc.revision);
  assert.deepEqual([up.sets[2].rir, up.sets[2].failed], [5, false]);
  // A reload shows the stored value.
  await page.reload();
  await H.ready(page);
  await page.waitForSelector(RIR);
  assert.equal(await rirShown(page), '5+');
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('RIR (c): extra set: the RIR moves to it; the earlier set loses it (changed or untouched) in the database and the uploaded file; again for a second extra set', async () => {
  const fake = new FakeGitHub();
  const app = await start({ fake });
  const { page } = app;
  await begin(page);
  for (let i = 0; i < 3; i++) await H.logSet(page);
  await page.waitForSelector(RIR);
  await page.clock.fastForward(1100);
  await tapRir(page, 'minus', 1, 3, 2, false);
  await tapRir(page, 'minus', 1, 3, 1, false);
  await H.tapExtra(page);
  assert.equal(await page.$(RIR), null, 'steppers for the extra set, no RIR');
  const rev = (await H.openSession(page)).doc.revision;
  await H.logSet(page);
  await page.waitForSelector(RIR);
  assert.equal(await page.textContent(`${RIR} label`), 'RIR · Set 4');
  assert.equal(await rirShown(page), '3');
  let sets = await slotRir(page, 1);
  assert.deepEqual(sets.map(s => [s.hasRir, s.rir, s.failed]), [[false, undefined, undefined], [false, undefined, undefined], [false, undefined, undefined], [true, 3, false]], 'set 3 lost its 1; set 4 has 3');
  assert.equal(sets[2].edited, false, 'the move is not a correction');
  assert.equal((await H.openSession(page)).doc.revision, rev + 1, 'one revision for the log and the move');
  const recA = await H.openSession(page);
  assert.doesNotMatch(norm(await page.innerText(`.ex.current [data-set="${recA.doc.sets[2].set_id}"]`)), /RIR|· F/);
  assert.match(norm(await page.innerText(`.ex.current [data-set="${recA.doc.sets[3].set_id}"]`)), /· RIR 3/);
  await page.clock.fastForward(1100);
  await tapRir(page, 'plus', 1, 4, 4, false);
  assert.deepEqual((await slotRir(page, 1)).map(s => s.rir), [undefined, undefined, undefined, 4], 'the control changes set 4 only');
  // A second extra set: set 4's value moves to set 5 the same way.
  await H.tapExtra(page);
  await H.logSet(page);
  await page.waitForSelector(RIR);
  assert.equal(await page.textContent(`${RIR} label`), 'RIR · Set 5');
  assert.deepEqual((await slotRir(page, 1)).map(s => [s.hasRir, s.rir]), [[false, undefined], [false, undefined], [false, undefined], [false, undefined], [true, 3]]);
  // Untouched default: set 3 loses its 3 as well.
  await H.tapNext(page);
  for (let i = 0; i < 3; i++) await H.logSet(page);
  await page.waitForSelector(RIR);
  assert.deepEqual((await slotRir(page, 2)).map(s => s.rir), [undefined, undefined, 3]);
  await H.tapExtra(page);
  await H.logSet(page);
  await page.waitForSelector(RIR);
  assert.deepEqual((await slotRir(page, 2)).map(s => [s.hasRir, s.rir, s.failed]), [[false, undefined, undefined], [false, undefined, undefined], [false, undefined, undefined], [true, 3, false]]);
  // The uploaded file says the same, and carries nothing of the phone-only memory.
  const rec = await H.openSession(page);
  await H.waitFor(async () => { const r = await H.openSession(page); return !r.dirty && fake.sessionPaths().length === 1; }, { message: 'uploaded' });
  const path = fake.sessionPaths()[0];
  const up = fake.json(path);
  assert.equal(up.revision, rec.doc.revision);
  const upRir = pos => up.sets.filter(s => s.position === pos).sort((a, b) => a.set_number - b.set_number).map(s => ('rir' in s || 'failed' in s) ? [s.rir, s.failed] : null);
  assert.deepEqual(upRir(1), [null, null, null, null, [3, false]]);
  assert.deepEqual(upRir(2), [null, null, null, [3, false]]);
  assert.doesNotMatch(fake.get(path).text, /rirMoved/);
  assert.ok(!('ui' in up) && up.format === 1, 'file format unchanged');
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('RIR (d): a timed exercise gets the RIR stepper with "time left in the tank"', async () => {
  const app = await start();
  const { page } = app;
  await begin(page);
  await H.goSlot(page, 4);
  await page.waitForSelector('.dock input[name=seconds]');
  await H.setEntry(page, 0, 45);
  for (let i = 0; i < 3; i++) await H.logSet(page);
  await page.waitForSelector(RIR);
  assert.equal(await page.textContent(`${RIR} small`), 'time left in the tank');
  assert.equal(await page.textContent(`${RIR} label`), 'RIR · Set 3');
  assert.deepEqual((await slotRir(page, 4)).map(s => [s.rir, s.failed]), [[undefined, undefined], [undefined, undefined], [3, false]]);
  await page.clock.fastForward(1100);
  await tapRir(page, 'minus', 4, 3, 2, false);
  // Edit Set on a timed set says the same.
  const id = (await H.openSession(page)).doc.sets.find(s => s.position === 4 && s.set_number === 1).set_id;
  await page.click(`[data-set="${id}"]`);
  await page.waitForSelector('[data-sheet=edit]');
  assert.equal(await page.textContent('[data-sheet=edit] [data-kind=rir] small'), 'time left in the tank');
  await page.click('[data-sheet=edit] [data-action=cancel]');
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('RIR (e): free-form and added exercises reach the done state after set 3; nothing about planned sets is written', async () => {
  const fake = new FakeGitHub();
  const app = await start({ fake });
  const { page } = app;
  // Free-form.
  await begin(page, '');
  await page.click('[data-sheet=add] [data-group=Core]');
  await page.click('[data-sheet=add] [data-ex=D02]');
  await page.waitForSelector('[data-dock=entry]');
  await H.setEntry(page, 0, 15);
  await H.logSet(page);
  assert.ok(await page.$('[data-dock=entry]'), 'sets 1 and 2: the panel stays on the same exercise, ready for the next set');
  assert.match(await page.textContent('.dock .title b'), /^Set 2 of 3 · Test Bodyweight Crunch$/);
  await H.logSet(page);
  assert.ok(await page.$('[data-dock=entry]'));
  await H.logSet(page);
  await page.waitForSelector('[data-dock=complete]');
  assert.ok(await page.$('.ex.current[data-slot="1"]'));
  assert.match(norm(await page.innerText('[data-done=all]')), /^All planned sets logged 3 of 3 sets done · Test Bodyweight Crunch$/);
  assert.equal(await rirShown(page), '3');
  assert.ok(await page.$('.dock [data-action=extra-set]'));
  assert.ok(await page.$('[data-action=undo]') && await page.$('[data-action=add-exercise]'), 'minor row');
  assert.equal(norm(await page.innerText('[data-action=exercises]')), 'Exercises 1 of 1 ▾');
  assert.match((await H.panelInfo(page))[0].text, /Test Bodyweight Crunch.*3 sets$/, 'the panel still shows no plan for it');
  // + Extra set works for it too.
  await H.tapExtra(page);
  assert.match(await page.textContent('.dock .title b'), /^Set 4 of 4 · Test Bodyweight Crunch$/);
  await H.logSet(page);
  await page.waitForSelector(RIR);
  assert.equal(norm(await page.innerText('[data-done=all] span')), '4 sets done (3 planned) · Test Bodyweight Crunch');
  assert.deepEqual((await slotRir(page, 1)).map(s => s.rir), [undefined, undefined, undefined, 3], 'the RIR moved to the extra set (v1.1.1)');
  const freeId = (await H.openSession(page)).id;
  await endWorkout(page);
  await H.waitFor(() => fake.sessionPaths().some(p => p.includes(freeId) && fake.json(p).status === 'closed'), { message: 'free-form uploaded' });
  const freePath = fake.sessionPaths().find(p => p.includes(freeId));
  const freeText = fake.get(freePath).text || JSON.stringify(fake.json(freePath));
  assert.doesNotMatch(freeText, /planned/, 'no planned exercise, no planned sets in the file');
  assert.deepEqual(Object.keys(fake.json(freePath)).sort(), Object.keys(H.fixtureDoc('a8b0b276')).sort(), 'no new top-level fields');

  // An exercise added during a preset workout.
  await begin(page);
  await page.click('[data-action=add-exercise]');
  await page.click('[data-sheet=add] [data-group=Legs]');
  await page.click('[data-sheet=add] [data-ex=C01]');
  await page.waitForSelector('.ex.current[data-slot="5"]');
  for (let i = 0; i < 2; i++) await H.logSet(page);
  assert.ok(await page.$('[data-dock=entry]'));
  await H.logSet(page);
  await page.waitForSelector('[data-dock=complete] [data-action=next-dock]');
  assert.equal(await page.getAttribute('[data-action=next-dock]', 'data-slot'), '1', 'Next goes to the first exercise with planned sets left');
  assert.equal(await rirShown(page), '3');
  assert.equal(norm(await page.innerText('[data-action=exercises]')), 'Exercises 5 of 5 ▾');
  const panel = await H.panelInfo(page);
  assert.match(panel.find(i => i.slot === 5).text, /3 sets · added$/);
  assert.match(panel.find(i => i.slot === 1).text, /not started · 3 × 8–12 reps/);
  const added = (await H.openSession(page)).doc.sets.filter(s => s.position === 5);
  assert.ok(added.every(s => !('planned_exercise_id' in s) && !('planned_exercise_name' in s)));
  assert.deepEqual(added.map(s => s.rir), [undefined, undefined, 3]);
  await H.tapNext(page);
  assert.ok(await page.$('[data-dock=entry]'));
  // Resume card unchanged.
  await page.click('[data-action=home]');
  assert.equal(norm(await page.innerText('[data-action=resume]')), 'Resume Test Upper 3 sets logged · started 16:30 ›');
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('RIR (f): Edit Set on a past session from History changes RIR, sets edited_at, raises the revision, uploads once; "–" removes it', async () => {
  const fake = new FakeGitHub();
  const app = await start({ fake });
  const { page } = app;
  const target = H.fixtureDoc('a8b0b276');
  const set1 = target.sets.find(s => s.position === 1 && s.set_number === 1);
  const set4 = target.sets.find(s => s.position === 1 && s.set_number === 4);
  const path = `sessions/2026/${target.date}_${target.session_id}.json`;
  const stored = async () => (await H.readDB(page)).sessions.find(s => s.id === target.session_id);
  await page.click('[data-nav=history]');
  await page.click(`[data-session="${target.session_id}"]`);
  await page.waitForSelector('#app[data-view=session]');
  // Rows show the RIR where recorded, and nothing where not.
  assert.match(norm(await page.innerText(`[data-set="${set4.set_id}"]`)), /42\.5 kg × 8 · RIR 1/);
  assert.doesNotMatch(norm(await page.innerText(`[data-set="${set1.set_id}"]`)), /RIR|· F/);
  // A set with no RIR: "–", then + gives F, 0, 1.
  await page.click(`[data-set="${set1.set_id}"]`);
  await page.waitForSelector('[data-sheet=edit]');
  const fig = () => page.textContent('[data-sheet=edit] [data-kind=rir] output');
  assert.equal(await fig(), '–');
  assert.equal(await page.$eval('[data-sheet=edit] [data-kind=rir] [data-step=minus]', b => b.disabled), true);
  for (const v of ['F', '0', '1']) { await page.click('[data-sheet=edit] [data-kind=rir] [data-step=plus]'); assert.equal(await fig(), v); }
  assert.equal(fake.puts.length, 0, 'nothing written before Save');
  await page.click('[data-sheet=edit] [data-action=save]');
  await page.waitForSelector('[data-sheet=edit]', { state: 'detached' });
  await H.waitFor(async () => { const r = await stored(); return r.doc.revision === target.revision + 1 && !r.dirty; }, { message: 'saved and uploaded' });
  let r = await stored();
  let s = r.doc.sets.find(x => x.set_id === set1.set_id);
  assert.deepEqual([s.rir, s.failed], [1, false]);
  assert.match(s.edited_at, ISO);
  assert.equal(s.weight_kg, set1.weight_kg);
  assert.equal(fake.puts.filter(p => p.path === path).length, 1, 'uploaded once');
  assert.deepEqual(fake.json(path), r.doc);
  assert.match(norm(await page.innerText(`[data-set="${set1.set_id}"]`)), /· RIR 1/);
  // Back to "–": both fields go.
  await page.click(`[data-set="${set1.set_id}"]`);
  await page.waitForSelector('[data-sheet=edit]');
  assert.equal(await fig(), '1');
  for (const v of ['0', 'F', '–']) { await page.click('[data-sheet=edit] [data-kind=rir] [data-step=minus]'); assert.equal(await fig(), v); }
  await page.click('[data-sheet=edit] [data-action=save]');
  await H.waitFor(async () => { const x = await stored(); return x.doc.revision === target.revision + 2 && !x.dirty; }, { message: 'second save uploaded' });
  r = await stored();
  s = r.doc.sets.find(x => x.set_id === set1.set_id);
  assert.ok(!('rir' in s) && !('failed' in s), 'not recorded: both fields removed');
  assert.equal(fake.puts.filter(p => p.path === path).length, 2);
  assert.ok(!('rir' in fake.json(path).sets.find(x => x.set_id === set1.set_id)));
  // Cancel and an unchanged Save write nothing.
  await page.click(`[data-set="${set4.set_id}"]`);
  await page.waitForSelector('[data-sheet=edit]');
  assert.equal(await fig(), '1');
  await page.click('[data-sheet=edit] [data-action=save]');
  await page.waitForSelector('[data-sheet=edit]', { state: 'detached' });
  await page.waitForTimeout(200);
  assert.equal((await stored()).doc.revision, target.revision + 2);
  // In the current session the Edit Set panel corrects RIR the same way (edited_at set).
  await page.click('[data-action=back]');
  await page.click('[data-action=back]');
  await begin(page);
  for (let i = 0; i < 3; i++) await H.logSet(page);
  const cur = (await H.openSession(page)).doc.sets[2];
  await page.click(`[data-set="${cur.set_id}"]`);
  await page.waitForSelector('[data-sheet=edit]');
  assert.equal(await fig(), '3');
  await page.click('[data-sheet=edit] [data-kind=rir] [data-step=minus]');
  await page.click('[data-sheet=edit] [data-action=save]');
  await H.waitFor(async () => (await slotRir(page, 1))[2].rir === 2, { message: 'edited in the open session' });
  assert.equal((await slotRir(page, 1))[2].edited, true);
  await page.waitForSelector('[data-sheet=edit]', { state: 'detached' });
  assert.equal(await rirShown(page), '2', 'the done state follows the correction');
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('RIR (g): double-tap guard: a second tap within a second of Log changes no RIR and adds no extra set', async () => {
  const app = await start();
  const { page } = app;
  await begin(page);
  await H.logSet(page);
  await H.logSet(page);
  await page.clock.fastForward(1100);
  await page.click('[data-action=log]');
  await page.waitForSelector(RIR);
  const rev = (await H.openSession(page)).doc.revision;
  // Second taps on every control of the RIR row, within the second.
  await page.click(`${RIR} [data-step=minus]`);
  await page.click(`${RIR} [data-step=plus]`);
  await page.click('.dock [data-action=extra-set]');
  await page.waitForTimeout(300);
  assert.equal(await rirShown(page), '3', 'the figure did not move');
  let rec = await H.openSession(page);
  assert.equal(rec.doc.revision, rev, 'nothing written');
  assert.equal(rec.doc.sets[2].rir, 3);
  assert.equal(rec.slots[0].extra, 0, 'no extra set');
  assert.ok(await page.$('[data-dock=complete]'));
  // A double tap where the Log button was lands on Next and is ignored as well (existing guard).
  // After the second, the RIR buttons work on one tap.
  await page.clock.fastForward(1100);
  await tapRir(page, 'plus', 1, 3, 4, false);
  rec = await H.openSession(page);
  assert.equal(rec.doc.revision, rev + 1);
  await app.close();
});

test('RIR (h): restored fixture sessions with and without RIR are stored and shown without error', async () => {
  const fake = new FakeGitHub();
  fake.put('setup.json', JSON.stringify(SETUP, null, 2));
  for (const s of H.FIXTURE_SESSIONS) fake.put(s.path, s.text);
  const app = await start({ fake, history: false });
  const { page } = app;
  await page.waitForSelector('[data-banner=restore]');
  await page.click('[data-banner=restore] [data-action=restore]');
  await page.waitForSelector('[data-banner=restore]', { state: 'detached' });
  await H.waitFor(async () => (await H.readDB(page)).sessions.length === H.FIXTURE_SESSIONS.length, { message: 'restored' });
  const db = await H.readDB(page);
  for (const id of ['a8b0b276', '1f246a0c', '2bd74d3b']) {
    const doc = H.fixtureDoc(id);
    assert.deepEqual(db.sessions.find(r => r.id === doc.session_id).doc, doc, `${id} stored exactly as downloaded`);
  }
  await page.click('[data-nav=history]');
  for (const id of ['a8b0b276', '1f246a0c', '4e418613', '2bd74d3b', 'c9d822f7']) {
    const doc = H.fixtureDoc(id);
    await page.click(`[data-session="${doc.session_id}"]`);
    await page.waitForSelector('#app[data-view=session]');
    const shown = await page.$$eval('#app .slotcard [data-set]', els => els.map(e => ({ id: e.dataset.set, rir: e.querySelector('.rir') ? e.querySelector('.rir').textContent : null })));
    assert.equal(shown.length, doc.sets.length);
    for (const s of doc.sets) {
      const want = !('rir' in s) ? null : s.failed ? ' · F' : ` · RIR ${s.rir >= 5 ? '5+' : s.rir}`;
      assert.equal(shown.find(x => x.id === s.set_id).rir, want, `${id} set ${s.position}/${s.set_number}`);
    }
    await page.click('[data-action=back]');
    await page.waitForSelector('#app[data-view=history]');
  }
  // The failed set reads "F"; a fixture with no RIR at all shows none.
  const failed = H.fixtureDoc('1f246a0c').sets.find(s => s.failed);
  await page.click(`[data-session="${H.fixtureDoc('1f246a0c').session_id}"]`);
  assert.match(norm(await page.innerText(`[data-set="${failed.set_id}"]`)), /· F/);
  await page.click(`[data-set="${failed.set_id}"]`);
  assert.equal(await page.textContent('[data-sheet=edit] [data-kind=rir] output'), 'F');
  await page.click('[data-sheet=edit] [data-action=cancel]');
  // Pre-fill and the "Last time" line are unaffected by RIR in the history.
  await page.click('[data-action=back]');
  await page.click('[data-action=back]');
  await begin(page, 'Test Lower');
  const e = await H.entryValues(page);
  assert.deepEqual([e.weight, e.value], ['130', '13']);
  assert.doesNotMatch(await page.textContent('.ex.current .lasttime'), /RIR/);
  assert.deepEqual(app.errors, []);
  assert.deepEqual(app.consoleErrors.filter(m => !/status of 404/.test(m)), []);
  await app.close();
});

// v1.1.1: the done-state RIR moves to an extra set, and comes back if that set is removed in the session.

async function undoLastSet(page) {
  const n = (await H.openSession(page)).doc.sets.length;
  await page.click('[data-action=undo]');
  await page.click('[data-dialog=undo] [data-role=ok]');
  await H.waitFor(async () => (await H.openSession(page)).doc.sets.length === n - 1, { message: 'undo saved' });
}
/** Edit Set on a set of the open session: delete it. */
async function deleteOpenSet(page, setId) {
  const n = (await H.openSession(page)).doc.sets.length;
  await page.click(`[data-set="${setId}"]`);
  await page.waitForSelector('[data-sheet=edit]');
  await page.click('[data-sheet=edit] [data-action=delete]');
  await page.click('[data-dialog=delete-set] [data-role=ok]');
  await page.waitForSelector('[data-sheet=edit]', { state: 'detached' });
  await H.waitFor(async () => (await H.openSession(page)).doc.sets.length === n - 1, { message: 'delete saved' });
}
const setIdOf = async (page, pos, n) => (await H.openSession(page)).doc.sets.find(s => s.position === pos && s.set_number === n).set_id;

test('RIR (i): tapping + Extra set without logging leaves the earlier value, also after a reload and an Undo of the request', async () => {
  const app = await start();
  const { page } = app;
  await begin(page);
  for (let i = 0; i < 3; i++) await H.logSet(page);
  await page.waitForSelector(RIR);
  await page.clock.fastForward(1100);
  await tapRir(page, 'minus', 1, 3, 2, false);
  await tapRir(page, 'minus', 1, 3, 1, false);
  const rev = (await H.openSession(page)).doc.revision;
  await H.tapExtra(page);
  await H.waitFor(async () => (await H.openSession(page)).slots[0].extra === 1, { message: 'extra saved' });
  let rec = await H.openSession(page);
  assert.deepEqual((await slotRir(page, 1)).map(s => [s.rir, s.failed]), [[undefined, undefined], [undefined, undefined], [1, false]]);
  assert.equal(rec.doc.revision, rev, 'the tap writes nothing to the session file');
  assert.equal(rec.ui.rirMoved, undefined, 'nothing moved, nothing remembered');
  await page.reload();
  await H.ready(page);
  await page.waitForSelector('[data-dock=entry]');
  assert.deepEqual((await slotRir(page, 1)).map(s => s.rir), [undefined, undefined, 1]);
  // Going on to the next exercise without logging the extra set: set 3 keeps its 1.
  await H.goSlot(page, 2);
  await H.logSet(page);
  assert.deepEqual((await slotRir(page, 1)).map(s => s.rir), [undefined, undefined, 1]);
  // Undo now removes the last logged set (slot 2's), which leaves slot 1 alone.
  await undoLastSet(page);
  assert.deepEqual((await slotRir(page, 1)).map(s => s.rir), [undefined, undefined, 1]);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('RIR (j): Undo of the extra set puts the earlier value back (1, and F), uploaded; the control applies to it again', async () => {
  const fake = new FakeGitHub();
  const app = await start({ fake });
  const { page } = app;
  await begin(page);
  for (let i = 0; i < 3; i++) await H.logSet(page);
  await page.waitForSelector(RIR);
  await page.clock.fastForward(1100);
  await tapRir(page, 'minus', 1, 3, 2, false);
  await tapRir(page, 'minus', 1, 3, 1, false);
  const set3 = await setIdOf(page, 1, 3);
  await H.tapExtra(page);
  await H.logSet(page);
  await page.waitForSelector(RIR);
  assert.deepEqual((await slotRir(page, 1)).map(s => s.rir), [undefined, undefined, undefined, 3]);
  assert.deepEqual((await H.openSession(page)).ui.rirMoved, { [set3]: 1 }, 'remembered on the phone');
  let rev = (await H.openSession(page)).doc.revision;
  await undoLastSet(page);
  await page.waitForSelector(RIR);
  assert.equal(await page.textContent(`${RIR} label`), 'RIR · Set 3');
  assert.equal(await rirShown(page), '1');
  let rec = await H.openSession(page);
  assert.deepEqual((await slotRir(page, 1)).map(s => [s.rir, s.failed, s.edited]), [[undefined, undefined, false], [undefined, undefined, false], [1, false, false]]);
  assert.equal(rec.doc.revision, rev + 1, 'the undo and the restore are one change');
  assert.deepEqual(rec.ui.rirMoved, {}, 'the remembered value is used up');
  await H.waitFor(async () => { const r = await H.openSession(page); return !r.dirty && fake.sessionPaths().length === 1; }, { message: 'uploaded' });
  let up = fake.json(fake.sessionPaths()[0]);
  assert.equal(up.revision, rec.doc.revision);
  assert.deepEqual(up.sets.filter(s => s.position === 1).map(s => [s.set_number, s.rir, s.failed]), [[1, undefined, undefined], [2, undefined, undefined], [3, 1, false]]);
  // The control applies to set 3 again.
  await page.clock.fastForward(1100);
  await tapRir(page, 'minus', 1, 3, 0, false);
  await tapRir(page, 'minus', 1, 3, 0, true);
  // F: moved by an extra set, and back with Undo.
  await H.tapExtra(page);
  await H.logSet(page);
  await page.waitForSelector(RIR);
  assert.deepEqual((await slotRir(page, 1)).map(s => [s.hasRir, s.rir, s.failed]), [[false, undefined, undefined], [false, undefined, undefined], [false, undefined, undefined], [true, 3, false]]);
  assert.deepEqual((await H.openSession(page)).ui.rirMoved, { [set3]: 'F' });
  await undoLastSet(page);
  await page.waitForSelector(RIR);
  assert.equal(await rirShown(page), 'F');
  assert.deepEqual((await slotRir(page, 1))[2], { n: 3, rir: 0, failed: true, hasRir: true, edited: false });
  rec = await H.openSession(page);
  await H.waitFor(async () => { const r = await H.openSession(page); return !r.dirty && fake.json(fake.sessionPaths()[0]).revision === r.doc.revision; }, { message: 'uploaded' });
  up = fake.json(fake.sessionPaths()[0]);
  assert.deepEqual(up.sets.filter(s => s.position === 1).map(s => [s.set_number, s.rir, s.failed]), [[1, undefined, undefined], [2, undefined, undefined], [3, 0, true]]);
  // The memory survives a reload (it is kept on the phone).
  await H.tapExtra(page);
  await H.logSet(page);
  await page.reload();
  await H.ready(page);
  await page.waitForSelector(RIR);
  await undoLastSet(page);
  await page.waitForSelector(RIR);
  assert.equal(await rirShown(page), 'F', 'restored after a reload');
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('RIR (k): Delete of the extra set in Edit Set (current session) puts the earlier value back, through two extra sets', async () => {
  const app = await start();
  const { page } = app;
  await begin(page);
  for (let i = 0; i < 3; i++) await H.logSet(page);
  await page.waitForSelector(RIR);
  await page.clock.fastForward(1100);
  for (const v of [2, 1, 0]) await tapRir(page, 'minus', 1, 3, v, false);
  await tapRir(page, 'minus', 1, 3, 0, true);
  await H.tapExtra(page);
  await H.logSet(page);
  await page.waitForSelector(RIR);
  await page.clock.fastForward(1100);
  await tapRir(page, 'plus', 1, 4, 4, false);
  await tapRir(page, 'plus', 1, 4, 5, false);
  await H.tapExtra(page);
  await H.logSet(page);
  await page.waitForSelector(RIR);
  assert.deepEqual((await slotRir(page, 1)).map(s => [s.rir, s.failed]), [[undefined, undefined], [undefined, undefined], [undefined, undefined], [undefined, undefined], [3, false]]);
  // Delete set 5: set 4 gets its 5+ back.
  const rev = (await H.openSession(page)).doc.revision;
  await deleteOpenSet(page, await setIdOf(page, 1, 5));
  await page.waitForSelector(RIR);
  assert.equal(await page.textContent(`${RIR} label`), 'RIR · Set 4');
  assert.equal(await rirShown(page), '5+');
  assert.deepEqual((await slotRir(page, 1)).map(s => [s.rir, s.failed]), [[undefined, undefined], [undefined, undefined], [undefined, undefined], [5, false]]);
  assert.equal((await H.openSession(page)).doc.revision, rev + 1, 'one change');
  // Delete set 4: set 3 gets its F back.
  await deleteOpenSet(page, await setIdOf(page, 1, 4));
  await page.waitForSelector(RIR);
  assert.equal(await page.textContent(`${RIR} label`), 'RIR · Set 3');
  assert.equal(await rirShown(page), 'F');
  assert.deepEqual((await slotRir(page, 1))[2], { n: 3, rir: 0, failed: true, hasRir: true, edited: false });
  assert.deepEqual((await H.openSession(page)).ui.rirMoved, {});
  // Deleting the set a value was remembered for drops the memory; nothing is invented.
  await H.tapExtra(page);
  await H.logSet(page);
  await page.waitForSelector(RIR);
  const set3 = await setIdOf(page, 1, 3);
  assert.deepEqual(Object.keys((await H.openSession(page)).ui.rirMoved), [set3]);
  await deleteOpenSet(page, set3);
  assert.deepEqual((await H.openSession(page)).ui.rirMoved, {});
  assert.deepEqual((await slotRir(page, 1)).map(s => [s.n, s.rir]), [[1, undefined], [2, undefined], [3, 3]], 'the extra set is now set 3 and keeps its own 3');
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('RIR (l): an RIR put on set 1 with Edit Set survives an extra set; only the previous last set loses its value', async () => {
  const app = await start();
  const { page } = app;
  await begin(page);
  for (let i = 0; i < 3; i++) await H.logSet(page);
  await page.waitForSelector(RIR);
  await page.click(`[data-set="${await setIdOf(page, 1, 1)}"]`);
  await page.waitForSelector('[data-sheet=edit]');
  for (let i = 0; i < 3; i++) await page.click('[data-sheet=edit] [data-kind=rir] [data-step=plus]');
  assert.equal(await page.textContent('[data-sheet=edit] [data-kind=rir] output'), '1');
  await page.click('[data-sheet=edit] [data-action=save]');
  await page.waitForSelector('[data-sheet=edit]', { state: 'detached' });
  await H.waitFor(async () => (await slotRir(page, 1))[0].rir === 1, { message: 'set 1 edited' });
  await H.tapExtra(page);
  await H.logSet(page);
  await page.waitForSelector(RIR);
  assert.deepEqual((await slotRir(page, 1)).map(s => [s.rir, s.failed]), [[1, false], [undefined, undefined], [undefined, undefined], [3, false]]);
  await H.tapExtra(page);
  await H.logSet(page);
  await page.waitForSelector(RIR);
  assert.deepEqual((await slotRir(page, 1)).map(s => s.rir), [1, undefined, undefined, undefined, 3]);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('RIR (m): "+ Set" from the exercise list before the slot is complete clears nothing', async () => {
  const app = await start();
  const { page } = app;
  await begin(page);
  await H.logSet(page);
  // An RIR on set 1 (Edit Set), so there is something that could be cleared.
  await page.click(`[data-set="${await setIdOf(page, 1, 1)}"]`);
  await page.waitForSelector('[data-sheet=edit]');
  for (let i = 0; i < 4; i++) await page.click('[data-sheet=edit] [data-kind=rir] [data-step=plus]');
  await page.click('[data-sheet=edit] [data-action=save]');
  await page.waitForSelector('[data-sheet=edit]', { state: 'detached' });
  await H.waitFor(async () => (await slotRir(page, 1))[0].rir === 2, { message: 'set 1 edited' });
  await page.clock.fastForward(1100);
  await page.click('.ex.current [data-action=add-set]');
  await H.waitFor(async () => (await H.openSession(page)).slots[0].extra === 1, { message: '+ Set saved' });
  assert.match(await page.textContent('.dock .title b'), /^Set 2 of 4 · Test Machine Press$/);
  await H.logSet(page);
  assert.deepEqual((await slotRir(page, 1)).map(s => s.rir), [2, undefined]);
  await H.logSet(page);
  assert.deepEqual((await slotRir(page, 1)).map(s => s.rir), [2, undefined, undefined]);
  assert.ok(await page.$('[data-dock=entry]'), 'not complete yet: 3 of 4');
  await H.logSet(page);
  await page.waitForSelector(RIR);
  assert.equal(await page.textContent(`${RIR} label`), 'RIR · Set 4');
  assert.deepEqual((await slotRir(page, 1)).map(s => [s.rir, s.failed]), [[2, false], [undefined, undefined], [undefined, undefined], [3, false]]);
  assert.equal((await H.openSession(page)).ui.rirMoved, undefined, 'nothing was moved');
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('RIR (n): a timed exercise follows the same rule: moved by an extra set, back with Undo', async () => {
  const app = await start();
  const { page } = app;
  await begin(page);
  await H.goSlot(page, 4);
  await page.waitForSelector('.dock input[name=seconds]');
  await H.setEntry(page, 0, 45);
  for (let i = 0; i < 3; i++) await H.logSet(page);
  await page.waitForSelector(RIR);
  await page.clock.fastForward(1100);
  await tapRir(page, 'plus', 4, 3, 4, false);
  await H.tapExtra(page);
  await H.logSet(page);
  await page.waitForSelector(RIR);
  assert.equal(await page.textContent(`${RIR} label`), 'RIR · Set 4');
  assert.equal(await page.textContent(`${RIR} small`), 'time left in the tank');
  assert.deepEqual((await slotRir(page, 4)).map(s => [s.rir, s.failed]), [[undefined, undefined], [undefined, undefined], [undefined, undefined], [3, false]]);
  await undoLastSet(page);
  await page.waitForSelector(RIR);
  assert.equal(await rirShown(page), '4');
  assert.deepEqual((await slotRir(page, 4)).map(s => s.rir), [undefined, undefined, 4]);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('RIR (o): deleting the last set of a closed session in History does not invent an RIR on the set before', async () => {
  const fake = new FakeGitHub();
  const app = await start({ fake });
  const { page } = app;
  await begin(page);
  for (let i = 0; i < 3; i++) await H.logSet(page);
  await page.waitForSelector(RIR);
  await page.clock.fastForward(1100);
  await tapRir(page, 'minus', 1, 3, 2, false);
  await H.tapExtra(page);
  await H.logSet(page);
  await page.waitForSelector(RIR);
  const rec = await H.openSession(page);
  const id = rec.id;
  const set4 = await setIdOf(page, 1, 4);
  const set3 = await setIdOf(page, 1, 3);
  await endWorkout(page);
  const stored = async () => (await H.readDB(page)).sessions.find(s => s.id === id);
  assert.equal((await stored()).ui.rirMoved, undefined, 'ending the session forgets the moved value');
  await page.click('[data-nav=history]');
  await page.click(`[data-session="${id}"]`);
  await page.waitForSelector('#app[data-view=session]');
  await page.click(`[data-set="${set4}"]`);
  await page.waitForSelector('[data-sheet=edit]');
  await page.click('[data-sheet=edit] [data-action=delete]');
  await page.click('[data-dialog=delete-set] [data-role=ok]');
  await H.waitFor(async () => { const r = await stored(); return r.doc.sets.length === 3 && !r.dirty; }, { message: 'deleted and uploaded' });
  const r = await stored();
  const s3 = r.doc.sets.find(s => s.set_id === set3);
  assert.equal(s3.set_number, 3);
  assert.ok(!('rir' in s3) && !('failed' in s3), 'set 3 stays unrecorded');
  assert.doesNotMatch(norm(await page.innerText(`[data-set="${set3}"]`)), /RIR|· F/);
  const path = fake.sessionPaths().find(p => p.includes(id));
  assert.ok(!('rir' in fake.json(path).sets.find(s => s.set_id === set3)));
  await page.click(`[data-set="${set3}"]`);
  await page.waitForSelector('[data-sheet=edit]');
  assert.equal(await page.textContent('[data-sheet=edit] [data-kind=rir] output'), '–');
  await page.click('[data-sheet=edit] [data-action=cancel]');
  assert.deepEqual(app.errors, []);
  await app.close();
});
