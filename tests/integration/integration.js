// Integration test (app + Mac script, end to end): script-made setup -> app; app-made session -> script -> Excel.
const { execSync } = require('child_process');
const fs = require('fs'), path = require('path');
const os = require('os');
const APP = path.resolve(__dirname, '..', '..');
const H = require(APP + '/tests/app/helpers.js');
const { FakeGitHub } = require(APP + '/tests/app/fake-github.js');
const D = path.join(os.tmpdir(), 'swole-integration');
const env = { ...process.env, GYMSYNC_FOLDER: D + '/folder', GYMSYNC_DATA_REPO: D + '/data' };
const sh = (c, o = {}) => execSync(c, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], ...o });
(async () => {
  sh(`bash ${path.join(__dirname, 'harness.sh')} ${D} 2>/dev/null`);
  console.log('SYNC 1:', sh(`python3 ${APP}/mac/gymsync.py`).trim().split('\n').pop());
  // GitHub as the phone sees it = the data repository's files
  const fake = new FakeGitHub();
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.name === '.git' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(D + '/data')) fake.put(path.relative(D + '/data', f), fs.readFileSync(f, 'utf8'));
  const scriptSetup = fake.json('setup.json');
  // phone: token only, no setup, no history
  const app = await H.openApp({ fake, seed: { settings: H.SETTINGS(fake) } });
  const { page } = app;
  await H.waitFor(async () => !!(await H.readDB(page)).kv.setup, { message: 'app to fetch the script-made setup' });
  const got = (await H.readDB(page)).kv.setup;
  console.log('APP HOLDS SCRIPT SETUP:', got.hash === scriptSetup.hash && got.published_at === scriptSetup.published_at);
  // restore history from the store if offered / via Settings
  await page.reload(); await H.ready(page);
  const body = await page.textContent('body');
  console.log('RESTORE OFFERED:', /download/i.test(body));
  await page.waitForSelector('[data-banner=restore]'); await page.click('[data-banner=restore] [data-action=restore]');
  await H.waitFor(async () => (await H.readDB(page)).sessions.length >= 7, { timeout: 15000, message: 'history restored' });
  console.log('SESSIONS ON PHONE AFTER RESTORE:', (await H.readDB(page)).sessions.length);
  await page.reload(); await H.ready(page);
  if (await page.$('[data-dialog] [data-role=cancel]')) await page.click('[data-dialog] [data-role=cancel]');
  await page.click('[data-workout="Test Lower"]'); await page.waitForSelector('#app[data-view=workout]');
  const pre = await H.entryValues(page); console.log('PREFILL set 1 (expect last time 130 x 13):', pre.weight, pre.value);
  await H.setEntry(page, 140, 12); await H.logSet(page);
  const p2 = await H.entryValues(page); console.log('PREFILL set 2 (expect today 140 x 12):', p2.weight, p2.value);
  await H.logSet(page); await H.setEntry(page, undefined, 10); await H.logSet(page);
  console.log('STAYS AFTER LAST PLANNED SET:', !!(await page.$('[data-dock=complete]')));
  await H.tapNext(page);
  const p3 = await H.entryValues(page); console.log('NEXT EXERCISE prefill (carry, expect 28 x 75):', p3.weight, p3.value, p3.logText);
  await H.setEntry(page, 30, 62); await H.logSet(page); await H.logSet(page); await H.logSet(page);
  await H.tapExtra(page); const px = await H.entryValues(page); console.log('EXTRA SET prefill (expect 30 x 62):', px.weight, px.value); await H.logSet(page);
  await H.tapNext(page);
  await H.logSet(page); await H.logSet(page);   // crunch 2 sets, pre-filled from history
  await page.click('[data-action=end]'); await page.waitForSelector('[data-dialog=end]');
  await page.fill('[data-dialog=end] textarea', 'Integration run');
  await page.click('[data-dialog=end] [data-role=ok]'); await page.waitForSelector('#app[data-view=home]');
  await H.waitFor(async () => (await H.readDB(page)).sessions.every(s => !s.dirty), { timeout: 15000, message: 'upload' });
  const mine = (await H.readDB(page)).sessions.map(s => s.doc).find(d => d.comment === 'Integration run');
  console.log('APP SESSION:', mine.date, mine.status, mine.sets.length, 'sets, revision', mine.revision, '| strip:', await H.strip(page));
  console.log('STORE FILES:', fake.sessionPaths().length, '| page errors:', app.errors.length);
  // push what the phone uploaded into the real (bare) store, as GitHub would hold it
  for (const p of fake.sessionPaths()) { const f = path.join(D, 'seed', p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, fake.get(p).text); }
  sh(`cd ${D}/seed && git add -A && git -c user.name=phone -c user.email=p@x commit -qm phone && git -c user.name=phone -c user.email=p@x pull -q --rebase && git push -q origin HEAD 2>&1`);
  console.log('SYNC 2:', sh(`python3 ${APP}/mac/gymsync.py`).trim().split('\n').pop());
  console.log('SYNC 3:', sh(`python3 ${APP}/mac/gymsync.py`).trim().split('\n').pop());
  fs.writeFileSync(D + '/mine.json', JSON.stringify(mine));
  await app.close(); await H.closeEnv();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
