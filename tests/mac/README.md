# Tests for the Mac Side (gymsync)

Run everything, from the repository root:

    python3 -m pytest tests/mac -v

Each test builds its own temporary folder, a local bare git repository standing in for GitHub, and a clone of it
standing in for `~/gym-log-data`.  Nothing outside the temp folders is touched and no network is used.
Needs `pytest` and `openpyxl`; the LibreOffice check is skipped if `soffice` is not installed.
`setup.command` can only be syntax-checked here (it needs macOS, `gh` and a GitHub login).
