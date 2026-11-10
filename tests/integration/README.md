# Integration Test

Runs the Mac sync script and the phone app together against a local stand-in for GitHub:

1. A bare git repository plays the private data repository, seeded with the fixture sessions.
2. `gymsync` publishes the fixture setup workbook.
3. The app (Chromium, 430 × 932) fetches that setup, restores the history, logs a workout including an extra set, and uploads it.
4. `gymsync` runs twice more: the new session must appear row for row in `Gym History.xlsx`, and the second run must change nothing.

Run from the repository root: `node tests/integration/integration.js`.  It prints one line per check; `FAILED` means a check failed.  Needs `python3` with openpyxl, `git`, Node and Playwright.
