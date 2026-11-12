# App Tests

Run everything (from the repository root):

```
node --test tests/app/app.test.js
```

Needs Node 18 or later and the `playwright` package with its Chromium (already installed in the build environment).  Nothing else.

- `app.test.js`: the 14 App tests of BRIEF.md 10.3 (named "App 1" to "App 14"), plus the session-file contract check against `fixtures/`, the offline shell (service worker cache list, manifest, icons, CSP, relative URLs, tap-target and font sizes), restore, export, a storage-write failure, the cold-start update reload, and a 44 × 44 tap-target check on every screen.
- The v1.0.1 done state (no automatic move after the last planned set), and the eight "RIR (a)" to "RIR (h)" tests for v1.1.0: reps in reserve on the last set of an exercise (default 3, the F to 5+ stepper, extra sets, timed exercises, free-form and added exercises with 3 sets inside the app, Edit Set from History with "–" for not recorded, the double-tap guard, and restored fixtures with and without RIR).
- The v1.1.1 rule that the done-state RIR lives on the exercise's final set only: "RIR (c)" (a logged extra set takes it over and the earlier set loses it, changed or left on 3, in the database and the uploaded file; again for a second extra set) and "RIR (i)" to "RIR (o)": tapping + Extra set without logging changes nothing; Undo, or Delete in Edit Set, of the extra set in the open session puts the earlier value back (including F); an Edit Set RIR on an earlier set survives; "+ Set" before the planned sets are done clears nothing; a timed exercise behaves the same; deleting the last set of a closed session in History leaves the set before it unrecorded.
- v1.2.0 (exercise default targets, step-up indicator, performance against last time; the calculations are in `docs/js/progress.js`):
  - "Step-up (a)": the pure functions, imported straight into Node: the hand-worked cases (40 × 12 at RIR 2, step 2.5, min 10 → 9.41 reps, no signal; 40 × 14 → e1RM 58.67, 11.41 reps, signal), no RIR and F counting as 0, every load type against bodyweight and assisted, the timed rule, W 0, increment 0, no target, the cue's tolerance at W + i, the effective target (slot's own, each of min and max on its own, else the exercise default), and the performance bands at 103 and 97 %.
  - "Step-up (b)" to "(d)": the violet weight figure and ▲ on + in the entry dock (pre-fill unchanged; gone at W + i; back below it; after a reload), the ▲ in the Exercises panel only for slots with no set today, preset workouts (workout targets, a kettlebell carry by time, a failed set, assisted and bodyweight never), and the Settings switch (on by default, off hides every cue, kept after a reload, 44 × 44).
  - "Performance (a)" and "(b)": the done-state line ("e1RM 60.0 · 102% of last time") in muted, violet and amber, following the RIR stepper at once (F and "–" count as 0), the dock's buttons still in the lower third at 44 × 44; no line without history or for assisted, bodyweight or timed exercises; after a swap, against the actual exercise's history.  Nothing extra in the uploaded file.
  - "Targets (a)" and "(b)": free-form and added exercises show their default ("10–15 reps", "6+ reps", "60–75 s"); a workout target wins after a swap; the snapshot carries the fields; a setup.json without targets works, and a session keeps its snapshot when a setup with targets arrives.
  - `start({history})` in `app.test.js` also takes an array of session docs (`pastSession()` builds one), and `start({setup})` another setup.
- `server.js`: serves `docs/` at `http://localhost:<port>/gym-log-app/`, so a root-relative URL fails.  A test can replace a published file (`overrides`) to publish a "new version".
- `fake-github.js`: an in-memory GitHub contents API behind `page.route('https://api.github.com/**')`: 404 when absent, sha checked on update (409 on mismatch, 422 when missing), 401 for a bad token, git blob shas, directory listings, and a "commit then drop the reply" mode for the cut-connection test.
- `helpers.js`: browser, app page (430 × 932, Bangkok time, Playwright clock), IndexedDB seeding and reading.

Other scripts:

```
node tests/app/screenshots.js   # PNGs of every screen at 2x into tests/app/screenshots/
node tests/app/make-icons.js    # re-renders docs/icons/icon-180|192|512.png
```
