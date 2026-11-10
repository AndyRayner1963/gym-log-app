# Swole

A phone web app for logging gym sets, with a Mac script that syncs it to Excel.

- `docs/` is the app, served by GitHub Pages.  Plain HTML, CSS and JavaScript; no build step.
- `mac/` is the sync script (`gymsync.py`), its launcher and the Mac set-up script.
- `fixtures/` is the data contract shared by the app and the script.  The exercises in it are invented.
- `tests/` holds the tests: `node --test tests/app/app.test.js`, `python3 -m pytest tests/mac -q`, and the end-to-end `node tests/integration/integration.js`.
- Bump `docs/version.js` for every app change: phones fetch the new version in the background and use it from the next cold start.

This repository holds no exercise data, no session data and no credentials.  Those live in a separate private repository and on the phone.
