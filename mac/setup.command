#!/bin/bash
# setup.command: sets up the gym logging sync on this Mac.  Safe to run twice.
# Steps: check git and gh, find the GitHub login, clone/update both repositories, build the private
# Python environment (openpyxl), write the gymsync launcher, create the Status folder.
set -u
TOTAL=8
GYM_FOLDER="${GYMSYNC_FOLDER:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/Health & Exercise/Gym Logging}"
APP_DIR="$HOME/gym-log-app"
DATA_DIR="$HOME/gym-log-data"
VENV="$APP_DIR/mac/.venv"
LAUNCHER="$HOME/.local/bin/gymsync"
DID=()

step() { echo "-- $1/$TOTAL $2"; }
die() { echo; echo "STOPPED: $1"; echo "Fix that, then run setup.command again.  Nothing already done will be undone."; exit 1; }

# 1 git
step 1 "Checking git"
command -v git >/dev/null 2>&1 || die "git is not installed.  Open Terminal, type: xcode-select --install   and let it finish."
git --version >/dev/null 2>&1 || die "git does not run.  Open Terminal, type: xcode-select --install   and let it finish."
DID+=("git found")

# 2 gh
step 2 "Checking the GitHub command (gh) and sign-in"
if command -v gh >/dev/null 2>&1; then GH="$(command -v gh)"
elif [ -x "$HOME/bin/gh" ]; then GH="$HOME/bin/gh"
else die "gh (the GitHub command) was not found on PATH or at ~/bin/gh.  Run Helm's setup first."; fi
"$GH" auth status >/dev/null 2>&1 || die "gh is not signed in to GitHub.  Open Terminal, type: $GH auth login   and follow the prompts."
DID+=("gh found at $GH and signed in")

# 3 login
step 3 "Reading your GitHub login"
LOGIN="$("$GH" api user -q .login 2>/dev/null)" || LOGIN=""
[ -n "$LOGIN" ] || die "could not read your GitHub login with 'gh api user'.  Check the internet connection."
echo "   GitHub login: $LOGIN"
# let git use the gh sign-in for github.com, only if nothing is set up yet
if ! git config --global --get-all credential.https://github.com.helper >/dev/null 2>&1; then
  "$GH" auth setup-git >/dev/null 2>&1 && DID+=("connected git to the gh sign-in")
fi

# 4 + 5 clones
clone_or_pull() { # name dir
  local name="$1" dir="$2"
  if [ -d "$dir/.git" ]; then
    git -C "$dir" pull --rebase --autostash >/dev/null 2>&1 || die "could not update $dir from GitHub.  Check the internet connection."
    DID+=("updated $dir")
  elif [ -e "$dir" ]; then
    die "$dir exists but is not a git clone.  Move it away, then run this again."
  else
    "$GH" repo clone "$LOGIN/$name" "$dir" >/dev/null 2>&1 || die "could not clone $LOGIN/$name to $dir.  Check that the repository exists and the internet is on."
    DID+=("cloned $LOGIN/$name to $dir")
  fi
}
step 4 "Getting the app repository (gym-log-app)"
clone_or_pull gym-log-app "$APP_DIR"
step 5 "Getting the data repository (gym-log-data)"
clone_or_pull gym-log-data "$DATA_DIR"

# 6 venv
step 6 "Building the Python environment (this takes a minute the first time)"
PY=/usr/bin/python3
[ -x "$PY" ] || PY="$(command -v python3 || true)"
[ -n "$PY" ] || die "python3 was not found.  Open Terminal, type: xcode-select --install   and let it finish."
if [ ! -x "$VENV/bin/python" ]; then
  "$PY" -m venv "$VENV" || die "could not create the Python environment at $VENV."
  DID+=("created the Python environment")
fi
"$VENV/bin/python" -m pip install --quiet --disable-pip-version-check "openpyxl==3.1.5" || die "could not install openpyxl.  Check the internet connection."
"$VENV/bin/python" -c "import openpyxl" || die "openpyxl did not install correctly."
DID+=("openpyxl ready")

# 7 launcher
step 7 "Writing the gymsync launcher"
[ -f "$APP_DIR/mac/gymsync.launcher" ] || die "$APP_DIR/mac/gymsync.launcher is missing from the app repository."
mkdir -p "$HOME/.local/bin"
cp "$APP_DIR/mac/gymsync.launcher" "$LAUNCHER" && chmod +x "$LAUNCHER" || die "could not write $LAUNCHER."
DID+=("wrote $LAUNCHER")

# 8 Status folder
step 8 "Creating the Status folder"
mkdir -p "$GYM_FOLDER/Status" || die "could not create $GYM_FOLDER/Status."
DID+=("Status folder ready in the Gym Logging folder")

echo
echo "Done.  What was done on this Mac:"
for d in "${DID[@]}"; do echo "  - $d"; done
echo "Next: put Gym Setup.xlsx in the Gym Logging folder (if it is not there), then press Sync in Helm."
exit 0
