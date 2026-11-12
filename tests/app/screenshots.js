// Saves PNG screenshots (430 × 932 points at 2×) of every screen into tests/app/screenshots/.
// Run from the repository root:  node tests/app/screenshots.js
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const OUT = path.join(__dirname, 'screenshots');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const fake = new H.FakeGitHub();
  fake.put('setup.json', JSON.stringify(H.SETUP, null, 2));
  for (const s of H.FIXTURE_SESSIONS.filter(x => !x.text.includes('"status": "open"'))) fake.put(s.path, s.text);
  const app = await H.openApp({
    fake, dsf: 2, time: new Date('2026-11-12T16:42:00+07:00'),
    seed: { settings: H.SETTINGS(fake), setup: H.SETUP, sessions: H.closedFixtureDocs() },
  });
  const { page } = app;
  const shot = async (name, { clearToast = false } = {}) => {
    if (clearToast) await page.clock.fastForward(3000);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log('saved', name);
  };
  await H.waitFor(async () => /All uploaded/.test(await H.strip(page)), { message: 'connected' });
  await shot('01-home');

  // Active workout, reps exercise mid-way (as the mockup): offline, one exercise done, set 2 of the row.
  fake.mode = 'offline';
  await page.click('[data-workout="Test Upper"]');
  await page.waitForSelector('#app[data-view=workout]');
  for (let i = 0; i < 3; i++) await H.logSet(page, { advance: 180000 });
  // Done state: the exercise stays after its last planned set (v1.0.1).
  await page.waitForSelector('[data-dock=complete]');
  await shot('02c-done-state');
  // v1.1.0: the RIR of the last set, set to 2 (one tap of minus), as in mockup frame B.
  await page.clock.fastForward(1100);
  await page.click('.dock [data-kind=rir] [data-step=minus]');
  await H.waitFor(async () => (await H.openSession(page)).doc.sets[2].rir === 2, { message: 'RIR saved' });
  await page.waitForSelector('.ex.current .set .rir');
  await shot('02d-done-state-rir');
  await H.tapNext(page);
  await H.logSet(page, { advance: 240000 });
  await page.clock.fastForward(120000);
  await H.setEntry(page, 42.5);
  await shot('02-active-workout');

  // Exercises panel.
  await page.click('[data-action=exercises]');
  await page.waitForSelector('[data-sheet=exercises]');
  await shot('02b-exercises-panel');
  await page.click('[data-sheet=exercises] [data-action=cancel]');

  // Home with the workout still open.
  await page.click('[data-action=home]');
  await page.waitForSelector('[data-action=resume]');
  await shot('01b-home-workout-open');
  await page.click('[data-action=resume]');
  await page.waitForSelector('#app[data-view=workout]');

  // Swap panel.
  await page.click('[data-action=swap]');
  await page.waitForSelector('[data-sheet=swap]');
  await shot('04-swap-panel');
  await page.click('[data-sheet=swap] [data-action=cancel]');

  // Edit Set panel.
  const setId = (await H.openSession(page)).doc.sets.find(s => s.position === 2).set_id;
  await page.click(`[data-set="${setId}"]`);
  await page.waitForSelector('[data-sheet=edit]');
  await page.fill('[data-sheet=edit] input[name=edit-weight]', '102.25');
  await shot('06-edit-set-panel');
  await page.click('[data-sheet=edit] [data-action=cancel]');
  // Edit Set on the set that carries the RIR (v1.1.0).
  const rirSet = (await H.openSession(page)).doc.sets.find(s => s.position === 1 && s.set_number === 3).set_id;
  await H.goSlot(page, 1);
  await page.click(`[data-set="${rirSet}"]`);
  await page.waitForSelector('[data-sheet=edit]');
  await shot('06b-edit-set-rir');
  await page.click('[data-sheet=edit] [data-action=cancel]');
  await H.goSlot(page, 2);

  // Add Exercise panel: groups, then the exercises in one group.
  await page.click('[data-action=add-exercise]');
  await page.waitForSelector('[data-sheet=add] [data-group]');
  await shot('05a-add-exercise-groups');
  await page.click('[data-sheet=add] [data-group=Pull]');
  await shot('05b-add-exercise-panel');
  await page.click('[data-sheet=add] [data-action=cancel]');

  // Time exercise with the stopwatch running.
  await H.goSlot(page, 4);
  await page.waitForSelector('[data-action=stopwatch]');
  await page.click('[data-action=stopwatch]');
  await page.clock.fastForward(42000);
  await shot('03-active-workout-time-stopwatch');
  await page.click('[data-action=stopwatch]');

  // End Workout box.
  await page.click('[data-action=end]');
  await page.waitForSelector('[data-dialog=end]');
  await shot('07-end-workout-box');
  await page.fill('[data-dialog=end] textarea', 'Felt strong');
  await page.click('[data-dialog=end] [data-role=ok]');
  await page.waitForSelector('#app[data-view=home]');

  // History, and one session opened.
  await page.click('[data-nav=history]');
  await page.waitForSelector('#app[data-view=history]');
  await shot('08-history', { clearToast: true });
  await page.click('[data-session^="a8b0b276"]');
  await page.waitForSelector('#app[data-view=session]');
  await shot('08b-history-session', { clearToast: true });

  // Settings, connected.
  fake.mode = 'online';
  await page.click('[data-action=back]');
  await page.click('[data-action=back]');
  await page.click('[data-nav=settings]');
  await page.waitForSelector('#conn-status.ok');
  await H.waitFor(async () => /All uploaded/.test(await H.strip(page)), { message: 'uploaded' });
  await page.waitForSelector('#persist-status[data-persisted]');
  await shot('09-settings', { clearToast: true });
  await page.evaluate(() => document.querySelector('#app .main').scrollTo(0, 99999));
  await shot('09b-settings-lower');
  // v1.2.0: the step-up indicator's switch.
  await page.evaluate(() => document.querySelector('[data-group=workout]').scrollIntoView({ block: 'center' }));
  await shot('09c-settings-step-up');

  // v1.2.0: step-up cue and the done state's line against last time.  Test Barbell Row (B04): last
  // time (8 Nov) ends 22.5 × 10, e1RM 30.0, which predicts 7.9 reps at 23.75 against its default 6+.
  await page.click('[data-action=back]');
  await page.waitForSelector('#app[data-view=home]');
  await page.click('[data-workout=""]');
  await page.waitForSelector('[data-sheet=add] [data-group]');
  await page.click('[data-sheet=add] [data-group=Push]');
  await page.click('[data-sheet=add] [data-ex=A01]');
  await page.click('[data-action=add-exercise]');
  await page.click('[data-sheet=add] [data-group=Pull]');
  await page.click('[data-sheet=add] [data-ex=B04]');
  await page.waitForSelector('.dock [data-kind=weight][data-cue=up]');
  await shot('10-step-up-cue');
  await page.click('[data-action=exercises]');
  await page.waitForSelector('[data-sheet=exercises] [data-up]');
  await shot('10b-exercises-panel-step-up');
  await page.click('[data-sheet=exercises] [data-action=cancel]');
  // 21.25 × 10 three times: RIR 3 gives 30.5, 102 % (muted).
  for (let i = 0; i < 3; i++) await H.logSet(page, { advance: 150000 });
  await page.waitForSelector('[data-dock=complete] [data-perf]');
  await shot('11a-done-perf-same');
  const rirTap = async (step, times) => {
    await page.clock.fastForward(1100);
    for (let i = 0; i < times; i++) await page.click(`.dock [data-kind=rir] [data-step=${step}]`);
  };
  await rirTap('plus', 2);   // 5+: 31.9, 106 % (violet)
  await page.waitForSelector('.dock [data-perf][data-band=up]');
  await shot('11b-done-perf-up');
  await rirTap('minus', 6);  // F: 28.3, 94 % (amber)
  await page.waitForSelector('.dock [data-perf][data-band=down]');
  await shot('11c-done-perf-down');

  if (app.errors.length) console.log('page errors:', app.errors);
  await app.close();
  await H.closeEnv();
})().catch(async e => { console.error(e); await H.closeEnv(); process.exit(1); });
