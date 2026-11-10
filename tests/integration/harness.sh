#!/bin/bash
# Integration harness: fake GitHub (bare repo) + data clone + Gym Logging folder, seeded from fixtures.  Usage: harness.sh DIR
set -e
D="$1"; APP="$(cd "$(dirname "$0")/../.." && pwd)"
rm -rf "$D"; mkdir -p "$D/folder" "$D/seed"
git init -q --bare "$D/remote.git"
git clone -q "$D/remote.git" "$D/seed" 2>/dev/null
cp -r "$APP/fixtures/sessions" "$D/seed/"
(cd "$D/seed" && git add -A && git -c user.name=pm -c user.email=pm@x commit -qm seed && git push -q origin HEAD)
git clone -q "$D/remote.git" "$D/data"
cp "$APP/fixtures/Gym Setup (sample).xlsx" "$D/folder/Gym Setup.xlsx"
