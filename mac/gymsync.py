#!/usr/bin/env python3
"""gymsync: syncs the gym logging system on the Mac (BRIEF.md section 7).

  Excel setup workbook -> setup.json in the data repository -> GitHub (phone reads it)
  session files in the data repository (phone writes them) -> Gym History.xlsx

Run with no arguments.  Exit code 0 = ok, 1 = needs attention, 2 = error.
Environment overrides (used by the tests):
  GYMSYNC_FOLDER     the Gym Logging folder (default: iCloud Drive/Health & Exercise/Gym Logging)
  GYMSYNC_DATA_REPO  the clone of gym-log-data (default: ~/gym-log-data)
  GYMSYNC_GIT        the git program to run (default: git)
Python 3.9+, standard library plus openpyxl only.
"""
import argparse
import datetime as dt
import hashlib
import json
import math
import os
import re
import socket
import subprocess
import sys
import traceback
import zipfile

SETUP_FILE = "Gym Setup.xlsx"
HISTORY_FILE = "Gym History.xlsx"
DEFAULT_FOLDER = "~/Library/Mobile Documents/com~apple~CloudDocs/Health & Exercise/Gym Logging"
DEFAULT_REPO = "~/gym-log-data"

SESSION_COLS = ["Session ID", "Date", "Start", "End", "Minutes", "Workout", "Comment", "Status", "Sets", "Revision"]
SET_COLS = ["Session ID", "Date", "Workout", "Exercise Order", "Set", "Planned Exercise ID", "Planned Exercise",
            "Exercise ID", "Exercise", "Group", "Type", "Measure", "Weight (kg)", "Reps", "Duration (s)",
            "Time Logged", "Swapped"]

EX_COLS = ["ID", "Exercise", "Group", "Type", "Measure", "Increment (kg)", "Note", "Active"]
WO_COLS = ["Workout", "Order", "Exercise", "Sets", "Target Min", "Target Max", "Comment"]
LIST_COLS = ["Types", "Measures", "Groups"]


class Stop(Exception):
    """A step failed in a way that ends the run (exit code 2)."""


# --------------------------------------------------------------------------- small helpers

def folder_path():
    return os.path.expanduser(os.environ.get("GYMSYNC_FOLDER") or DEFAULT_FOLDER)


def repo_path():
    return os.path.expanduser(os.environ.get("GYMSYNC_DATA_REPO") or DEFAULT_REPO)


def now_local():
    return dt.datetime.now().astimezone().replace(microsecond=0)


def iso(d):
    return d.isoformat(timespec="seconds")


def parse_iso(s):
    """ISO 8601 with offset -> aware datetime (works on Python 3.9)."""
    if not isinstance(s, str):
        raise ValueError("not text")
    s = s.strip()
    if s.endswith("Z") or s.endswith("z"):
        s = s[:-1] + "+00:00"
    try:
        return dt.datetime.fromisoformat(s)
    except ValueError:
        m = re.match(r"^(.*?T\d\d:\d\d:\d\d)(?:\.(\d+))?(.*)$", s)
        if not m:
            raise
        frac = ((m.group(2) or "") + "000000")[:6]
        return dt.datetime.fromisoformat(m.group(1) + "." + frac + m.group(3))


def norm_header(s):
    return re.sub(r"\s+", " ", str(s)).strip().casefold()


def text(v):
    """Cell value -> trimmed text ('' when empty)."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "Y" if v else "N"
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).strip()


def number(v):
    """Cell value -> int/float, or None if it is not a finite number.  Whole numbers become int."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, str):
        v = v.strip()
        if not v:
            return None
        try:
            v = float(v)
        except ValueError:
            return None
    if not isinstance(v, (int, float)) or not math.isfinite(v):
        return None
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def atomic_write_text(path, data):
    tmp = os.path.join(os.path.dirname(path), "." + os.path.basename(path) + ".tmp-%d" % os.getpid())
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(data)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


# --------------------------------------------------------------------------- run state

class Run(object):
    def __init__(self, debug):
        self.debug = debug
        self.messages = []
        self.attention = False
        self.error = None
        self.steps_ok = True
        self.setup_text = None       # part of the summary line
        self.counts = None           # (total, new, changed) or None
        self.history_updated = None
        self.setup_published_at = None
        self.total = 0
        self.new = 0
        self.changed = 0

    def say(self, line):
        self.messages.append(line)
        print(line)
        sys.stdout.flush()

    def flag(self, line):
        """A line that needs the user's attention."""
        self.attention = True
        self.say(line)


# --------------------------------------------------------------------------- git

def git_bin():
    return os.environ.get("GYMSYNC_GIT") or "git"


def git(repo, args, identity=False):
    cmd = [git_bin()]
    if identity:
        cmd += ["-c", "user.name=gymsync", "-c", "user.email=gymsync@localhost"]
    cmd += list(args)
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    p = subprocess.run(cmd, cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       universal_newlines=True, env=env)
    return p.returncode, p.stdout.strip()


def last_line(out):
    lines = [l for l in out.splitlines() if l.strip()]
    return lines[-1] if lines else "no details given"


def has_upstream(repo):
    rc, _ = git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
    return rc == 0


def git_pull(run, repo, what):
    if not has_upstream(repo):
        rc, out = git(repo, ["ls-remote", "--heads", "origin"])
        if rc == 0 and not out.strip():
            return  # brand-new empty store: nothing to pull yet
    rc, out = git(repo, ["pull", "--rebase", "--autostash"], identity=not has_identity(repo))
    if rc != 0:
        git(repo, ["rebase", "--abort"])
        raise Stop("Could not update %s from GitHub (%s).  Check the internet connection and that "
                   "you are signed in to GitHub, then press Sync again." % (what, last_line(out)))


def ahead_count(repo):
    if not has_upstream(repo):
        rc, _ = git(repo, ["rev-parse", "--verify", "-q", "HEAD"])
        return 1 if rc == 0 else 0
    rc, out = git(repo, ["rev-list", "--count", "@{u}..HEAD"])
    try:
        return int(out) if rc == 0 else 0
    except ValueError:
        return 0


def has_identity(repo):
    rn, on = git(repo, ["config", "user.name"])
    re_, oe = git(repo, ["config", "user.email"])
    return rn == 0 and on.strip() != "" and re_ == 0 and oe.strip() != ""


def step_commit_push(run, repo, published):
    """Step 5.  Commit setup.json if it differs from the last commit; push if there is anything to push."""
    rc, out = git(repo, ["status", "--porcelain", "--", "setup.json"])
    if rc != 0:
        raise Stop("Could not check the data folder with git (%s)." % last_line(out))
    if out.strip():
        ident = not has_identity(repo)
        rc, out = git(repo, ["add", "--", "setup.json"])
        if rc == 0:
            rc, out = git(repo, ["commit", "-m", "Publish setup (%s)" % published, "--", "setup.json"], identity=ident)
        if rc != 0:
            raise Stop("Could not save the new setup with git (%s)." % last_line(out))
    if ahead_count(repo) == 0:
        return
    rc, out = git(repo, ["push", "-u", "origin", "HEAD"])
    if rc != 0:
        # The store may have moved on (the other Mac, or the phone).  Pull and try once more.
        git_pull(run, repo, "the data folder")
        rc, out = git(repo, ["push", "-u", "origin", "HEAD"])
        if rc != 0:
            raise Stop("Could not send the setup to GitHub (%s).  Press Sync again in a minute." % last_line(out))


# --------------------------------------------------------------------------- step 1

def step_check_files(run, folder, repo):
    problems = []
    if not os.path.isdir(os.path.join(repo, ".git")):
        problems.append("The data repository is missing at %s.  Run setup.command on this Mac." % repo)
    if not os.path.isdir(folder):
        problems.append("The Gym Logging folder is missing: %s." % folder)
    else:
        for name in (SETUP_FILE, HISTORY_FILE):
            path = os.path.join(folder, name)
            placeholder = os.path.join(folder, "." + name + ".icloud")
            if not os.path.exists(path) and os.path.exists(placeholder):
                problems.append("%s is in iCloud but not downloaded to this Mac yet.  Open the Gym Logging "
                                "folder in Finder, wait for the download to finish, then press Sync again." % name)
            elif not os.path.exists(path) and name == SETUP_FILE:
                problems.append("%s is missing from the Gym Logging folder." % SETUP_FILE)
    if problems:
        for p in problems:
            run.say(p)
        raise Stop(problems[0] if len(problems) == 1 else "%d things are missing" % len(problems))


# --------------------------------------------------------------------------- steps 3-5: setup workbook

def find_table(ws, required):
    """Locate the header row (within the first 10 rows).  Returns (header_row, {name: col_index}, missing)."""
    wanted = [norm_header(c) for c in required]
    best = None
    for r in range(1, min(ws.max_row, 10) + 1):
        cols = {}
        for c in range(1, ws.max_column + 1):
            v = ws.cell(row=r, column=c).value
            if v is not None and text(v):
                cols.setdefault(norm_header(v), c)
        found = [w for w in wanted if w in cols]
        if len(found) == len(wanted):
            return r, cols, []
        if best is None or len(found) > best[0]:
            best = (len(found), r, cols)
    if best is None or best[0] == 0:
        return 1, {}, list(required)
    return best[1], best[2], [c for c in required if norm_header(c) not in best[2]]


def read_rows(ws, required):
    """Returns (rows, missing); rows = [(excel_row_number, {header: raw value})] with blank rows dropped."""
    hr, cols, missing = find_table(ws, required)
    if missing:
        return [], missing
    rows = []
    for r in range(hr + 1, ws.max_row + 1):
        rec = {}
        for name in required:
            rec[name] = ws.cell(row=r, column=cols[norm_header(name)]).value
        if all(text(v) == "" for v in rec.values()):
            continue
        rows.append((r, rec))
    return rows, []


def read_list_column(ws, name):
    hr, cols, missing = find_table(ws, [name])
    if missing:
        return []
    out = []
    for r in range(hr + 1, ws.max_row + 1):
        t = text(ws.cell(row=r, column=cols[norm_header(name)]).value)
        if t:
            out.append(t)
    return out


def compute_hash(content):
    canon = json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


def check_setup(path, old_exercises):
    """Reads and checks the setup workbook.  Returns (content or None, faults, warnings)."""
    import openpyxl
    faults, warnings = [], []
    wb = openpyxl.load_workbook(path, data_only=True, read_only=False)
    sheets = {}
    for name in ("Exercises", "Workouts", "Lists"):
        match = [s for s in wb.sheetnames if s.strip().casefold() == name.casefold()]
        if match:
            sheets[name] = wb[match[0]]
        else:
            faults.append("Sheet %s: the sheet is missing from the workbook." % name)

    # ---- Lists
    types, measures, groups = [], [], []
    if "Lists" in sheets:
        ws = sheets["Lists"]
        for col in LIST_COLS:
            hr, cols, missing = find_table(ws, [col])
            if missing:
                faults.append("Lists row 1: required column '%s' not found." % col)
        seen = set()
        for g in read_list_column(ws, "Groups"):
            if g.casefold() not in seen:
                seen.add(g.casefold())
                groups.append(g)
        types = read_list_column(ws, "Types")
        measures = read_list_column(ws, "Measures")
    type_map = dict((t.casefold(), t.casefold()) for t in types)
    measure_map = dict((m.casefold(), m.casefold()) for m in measures)
    group_map = dict((g.casefold(), g) for g in groups)
    list_missing = set()
    if "Lists" in sheets:
        for col in LIST_COLS:
            if find_table(sheets["Lists"], [col])[2]:
                list_missing.add(col)

    # ---- Exercises
    exercises = []
    lookup_ok = "Exercises" in sheets
    if "Exercises" in sheets:
        rows, missing = read_rows(sheets["Exercises"], EX_COLS)
        if missing:
            lookup_ok = False
        for m in missing:
            faults.append("Exercises row 1: required column '%s' not found." % m)
        if not rows and not missing:
            faults.append("Exercises: the sheet has no exercises yet.  Add at least one exercise before pressing Sync.")
        ids, names = {}, {}
        for r, rec in rows:
            where = "Exercises row %d: " % r
            before = len(faults)
            raw_id = text(rec["ID"])
            ex_id = raw_id.upper()
            if not raw_id:
                faults.append(where + "ID is missing.")
            elif not re.match(r"^[A-Z][0-9]+$", ex_id):
                faults.append(where + "ID '%s' must be a letter followed by a number, such as B03." % raw_id)
            elif ex_id in ids:
                faults.append(where + "ID '%s' is already used on row %d." % (raw_id, ids[ex_id]))
            else:
                ids[ex_id] = r
            name = text(rec["Exercise"])
            if not name:
                faults.append(where + "Exercise name is missing.")
            elif name.casefold() in names:
                faults.append(where + "Exercise name '%s' is already used on row %d." % (name, names[name.casefold()]))
            else:
                names[name.casefold()] = r
            vals = {}
            for col, mapping, label in (("Group", group_map, "Group"), ("Type", type_map, "Type"),
                                        ("Measure", measure_map, "Measure")):
                t = text(rec[col])
                if (col + "s") in list_missing:
                    vals[col] = t       # the Lists column is itself missing; that fault is already listed
                elif not t:
                    faults.append(where + "%s is missing." % label)
                elif t.casefold() not in mapping:
                    faults.append(where + "%s '%s' is not in the Lists sheet." % (label, t))
                else:
                    vals[col] = mapping[t.casefold()]
            inc = number(rec["Increment (kg)"])
            if inc is None or inc <= 0:
                faults.append(where + "Increment (kg) must be a number greater than zero (found '%s')." % text(rec["Increment (kg)"]))
            act = text(rec["Active"]).upper()
            if act not in ("Y", "N"):
                faults.append(where + "Active must be Y or N (found '%s')." % text(rec["Active"]))
            if len(faults) == before:
                exercises.append({"id": ex_id, "name": name, "group": vals["Group"], "type": vals["Type"],
                                  "measure": vals["Measure"], "increment_kg": inc, "note": text(rec["Note"]),
                                  "active": act == "Y"})
            elif raw_id and name:
                # still usable for the Workouts checks
                exercises.append({"id": ex_id, "name": name, "active": (act == "Y") if act in ("Y", "N") else None,
                                  "_bad": True})

    # ---- Workouts
    workouts = []
    if "Workouts" in sheets:
        rows, missing = read_rows(sheets["Workouts"], WO_COLS)
        for m in missing:
            faults.append("Workouts row 1: required column '%s' not found." % m)
        by_name = {}
        for e in exercises:
            by_name.setdefault(e["name"].casefold(), e)
        index = {}      # workout key -> workout dict
        orders = {}     # (workout key, order) -> row
        for r, rec in rows:
            where = "Workouts row %d: " % r
            wname = text(rec["Workout"])
            if not wname:
                faults.append(where + "Workout name is missing.")
                continue
            key = wname.casefold()
            if key not in index:
                index[key] = {"name": wname, "items": []}
                workouts.append(index[key])
            order = number(rec["Order"])
            if order is None or order != int(order) or order < 1:
                faults.append(where + "Order must be a whole number of 1 or more (found '%s')." % text(rec["Order"]))
                order = None
            elif (key, order) in orders:
                faults.append(where + "Order %d is used twice in workout '%s' (also row %d)." % (order, wname, orders[(key, order)]))
            else:
                orders[(key, order)] = r
            ex_name = text(rec["Exercise"])
            ex = None
            if not ex_name:
                faults.append(where + "Exercise is missing.")
            elif not lookup_ok:
                pass    # the Exercises sheet is unusable; that fault is already listed
            elif ex_name.casefold() not in by_name:
                faults.append(where + "Exercise '%s' does not exist on the Exercises sheet." % ex_name)
            else:
                ex = by_name[ex_name.casefold()]
                if ex["active"] is False:
                    faults.append(where + "Exercise '%s' is not active (Active is N)." % ex_name)
            sets = number(rec["Sets"])
            if sets is None or sets != int(sets) or sets < 1:
                faults.append(where + "Sets must be a whole number of 1 or more (found '%s')." % text(rec["Sets"]))
                sets = None
            targets = {}
            for col, key2 in (("Target Min", "target_min"), ("Target Max", "target_max")):
                if text(rec[col]) == "":
                    continue
                n = number(rec[col])
                if n is None or n != int(n) or n < 0:
                    faults.append(where + "%s must be a whole number (found '%s')." % (col, text(rec[col])))
                else:
                    targets[key2] = int(n)
            if "target_min" in targets and "target_max" in targets and targets["target_min"] > targets["target_max"]:
                faults.append(where + "Target Min (%d) is greater than Target Max (%d)." % (targets["target_min"], targets["target_max"]))
            if ex is not None and order is not None and sets is not None:
                item = {"order": int(order), "exercise_id": ex["id"], "sets": int(sets)}
                item.update(targets)
                item["comment"] = text(rec["Comment"])
                index[key]["items"].append(item)
        for w in workouts:
            w["items"].sort(key=lambda i: i["order"])

    # ---- Rule 9: removed exercises (a warning only)
    now_ids = set(e["id"] for e in exercises)
    for old_id, old_name in sorted(old_exercises.items()):
        if old_id not in now_ids:
            warnings.append("Warning: %s %s has been removed; set Active to N instead if it has history." % (old_id, old_name))

    if faults:
        return None, faults, warnings
    content = {"groups": groups, "exercises": exercises, "workouts": workouts}
    return content, faults, warnings


def read_published_setup(repo):
    path = os.path.join(repo, "setup.json")
    if not os.path.exists(path):
        return None, "missing"
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        if not isinstance(d, dict):
            raise ValueError("not an object")
    except (ValueError, OSError):
        return None, "unreadable"
    if not isinstance(d.get("format"), int) or d["format"] > 1:
        return d, "newer"
    return d, "ok"


def step_setup(run, folder, repo):
    """Steps 3, 4 and 5.  Returns True if the setup was checked and is good (published or unchanged)."""
    published, state = read_published_setup(repo)
    old_exercises = {}
    if published and state == "ok":
        for e in published.get("exercises", []):
            try:
                old_exercises[str(e["id"]).upper()] = e.get("name", "")
            except (TypeError, KeyError, AttributeError):
                pass
    run.setup_published_at = published.get("published_at") if published and state == "ok" else None
    path = os.path.join(folder, SETUP_FILE)
    try:
        content, faults, warnings = check_setup(path, old_exercises)
    except Exception as e:  # unreadable workbook
        if run.debug:
            raise
        run.flag("%s could not be read (%s).  If it is open in Excel, save and close it; "
                 "if it is damaged, restore it from iCloud Drive's recently deleted or earlier versions." % (SETUP_FILE, e))
        run.setup_text = "setup NOT published: workbook unreadable"
        return False
    for w in warnings:
        run.say(w)
    if faults:
        for f in faults:
            run.say("Setup fault - " + f)
        run.attention = True
        run.say("The setup was NOT published.  Fix the %d fault%s in %s and press Sync again; the phone keeps the old setup."
                % (len(faults), "" if len(faults) == 1 else "s", SETUP_FILE))
        run.setup_text = "setup NOT published: %d fault%s" % (len(faults), "" if len(faults) == 1 else "s")
        return False
    if state == "newer":
        run.flag("setup.json in the data repository has a newer format than this script understands.  "
                 "Update the script (run setup.command) and press Sync again.")
        run.setup_text = "setup NOT published: newer format in store"
        return False
    new_hash = compute_hash(content)
    if state == "ok" and published.get("hash") == new_hash:
        run.say("Setup is unchanged; nothing to publish.")
        run.setup_text = "setup unchanged"
    else:
        stamp = now_local()
        doc = {"format": 1, "published_at": iso(stamp), "hash": new_hash}
        doc.update(content)
        atomic_write_text(os.path.join(repo, "setup.json"), json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
        run.setup_published_at = doc["published_at"]
        run.say("Setup published (%d exercises, %d workouts)." % (len(content["exercises"]), len(content["workouts"])))
        run.setup_text = "setup published %s" % stamp.strftime("%H:%M")
    # step 5 runs whether or not the file changed now, so an earlier unfinished commit or push is completed
    step_commit_push(run, repo, run.setup_published_at or "")
    return True


# --------------------------------------------------------------------------- step 6: sessions

REQUIRED_SESSION = ["format", "session_id", "revision", "status", "date", "started_at", "sets"]
REQUIRED_SET = ["position", "set_number", "exercise_id", "exercise_name", "group", "type", "measure",
                "weight_kg", "logged_at"]
STATUSES = ("open", "closed", "auto_closed", "deleted")


def validate_session(d):
    """Raises ValueError with a plain reason if the session file is unusable."""
    if not isinstance(d, dict):
        raise ValueError("it does not hold a session")
    fmt = d.get("format")
    if isinstance(fmt, bool) or not isinstance(fmt, int):
        raise ValueError("it has no format number")
    if fmt > 1:
        raise ValueError("it uses format %d, which is newer than this script understands (update the script)" % fmt)
    for k in REQUIRED_SESSION:
        if k not in d or d[k] is None:
            raise ValueError("it lacks the required field '%s'" % k)
    if d["status"] not in STATUSES:
        raise ValueError("its status '%s' is not recognised" % d["status"])
    if isinstance(d["revision"], bool) or not isinstance(d["revision"], int):
        raise ValueError("its revision is not a whole number")
    if not isinstance(d["sets"], list):
        raise ValueError("its sets are not a list")
    try:
        parse_iso(d["started_at"])
        dt.date.fromisoformat(str(d["date"]))
        if d["status"] in ("closed", "auto_closed"):
            if not d.get("ended_at"):
                raise ValueError("it is closed but has no ended_at")
            parse_iso(d["ended_at"])
    except ValueError as e:
        raise ValueError("a date or time in it cannot be read (%s)" % e)
    if d["status"] in ("closed", "auto_closed"):
        for i, s in enumerate(d["sets"], 1):
            if not isinstance(s, dict):
                raise ValueError("set %d is not a set" % i)
            for k in REQUIRED_SET:
                if k not in s or s[k] is None:
                    raise ValueError("set %d lacks the required field '%s'" % (i, k))
            if s["measure"] not in ("reps", "time"):
                raise ValueError("set %d has an unknown measure '%s'" % (i, s["measure"]))
            need = "reps" if s["measure"] == "reps" else "duration_s"
            if s.get(need) is None:
                raise ValueError("set %d lacks '%s'" % (i, need))
            try:
                parse_iso(s["logged_at"])
            except ValueError:
                raise ValueError("set %d has a time that cannot be read" % i)
            for k in ("weight_kg", "position", "set_number"):
                if isinstance(s[k], bool) or not isinstance(s[k], (int, float)):
                    raise ValueError("set %d has a non-numeric '%s'" % (i, k))


def step_read_sessions(run, repo):
    sessions = {}
    root = os.path.join(repo, "sessions")
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for fn in sorted(filenames):
            if fn.endswith(".json") and not fn.startswith("."):
                files.append(os.path.join(dirpath, fn))
    bad = 0
    for path in files:
        rel = os.path.relpath(path, repo)
        try:
            with open(path, encoding="utf-8") as f:
                d = json.load(f)
        except (ValueError, OSError):
            run.flag("Skipped %s: it is not a readable session file (not valid JSON)." % rel)
            bad += 1
            continue
        try:
            validate_session(d)
        except ValueError as e:
            run.flag("Skipped %s: %s." % (rel, e))
            bad += 1
            continue
        sid = d["session_id"]
        if sid in sessions and sessions[sid]["revision"] >= d["revision"]:
            continue
        sessions[sid] = d
    return sessions


# --------------------------------------------------------------------------- step 7: history workbook

VIOLET = "4B2C6B"
HEADER_FILL = "E2E6E4"
FONT = "Lato"


def local_naive(s):
    return parse_iso(s).replace(tzinfo=None)


def history_rows(sessions):
    included = [d for d in sessions.values() if d["status"] in ("closed", "auto_closed")]
    included.sort(key=lambda d: (parse_iso(d["started_at"]), d["session_id"]))
    srows, trows = [], []
    for d in included:
        start = local_naive(d["started_at"])
        end = local_naive(d["ended_at"])
        minutes = max(0, int((end - start).total_seconds() // 60))
        date = dt.date.fromisoformat(str(d["date"]))
        workout = d.get("workout_name") or None
        sets = sorted(d["sets"], key=lambda s: (s["position"], s["set_number"], s["logged_at"]))
        srows.append([d["session_id"], date, start, end, minutes, workout, d.get("comment") or None,
                      d["status"], len(sets), d["revision"]])
        for s in sets:
            planned = s.get("planned_exercise_id")
            swapped = "Y" if planned and str(planned).upper() != str(s["exercise_id"]).upper() else "N"
            trows.append([d["session_id"], date, workout, s["position"], s["set_number"], planned or None,
                          s.get("planned_exercise_name") or None, s["exercise_id"], s["exercise_name"],
                          s["group"], s["type"], s["measure"], s["weight_kg"], s.get("reps"), s.get("duration_s"),
                          local_naive(s["logged_at"]), swapped])
    return srows, trows


def style_history_sheet(ws, columns, nrows, formats, widths):
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter
    from openpyxl.worksheet.table import Table, TableStyleInfo
    last_col = get_column_letter(len(columns))
    last_row = max(nrows, 1) + 1
    body_font = Font(name=FONT, size=10, color="222222")
    hair = Border(bottom=Side(style="hair", color="BFBFBF"))
    head_border = Border(bottom=Side(style="thin", color="808080"))
    for c, name in enumerate(columns, 1):
        cell = ws.cell(row=1, column=c)
        cell.font = Font(name=FONT, size=10, bold=True, color=VIOLET)
        cell.fill = PatternFill("solid", start_color=HEADER_FILL, end_color=HEADER_FILL)
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = head_border
        ws.column_dimensions[get_column_letter(c)].width = widths[c - 1]
    for r in range(2, last_row + 1):
        ws.row_dimensions[r].height = 16
        for c in range(1, len(columns) + 1):
            cell = ws.cell(row=r, column=c)
            cell.font = body_font
            cell.border = hair
            fmt = formats[c - 1]
            if fmt == "text":
                cell.alignment = Alignment(horizontal="left", vertical="center", indent=1)
            else:
                cell.number_format = fmt[0]
                cell.alignment = Alignment(horizontal=fmt[1], vertical="center")
    ws.row_dimensions[1].height = 22
    ws.sheet_format.defaultRowHeight = 16
    ws.sheet_format.customHeight = True
    ws.freeze_panes = "A2"
    ws.sheet_view.zoomScale = 130
    tab = Table(displayName="tblSessions" if columns is SESSION_COLS else "tblSets", ref="A1:%s%d" % (last_col, last_row))
    tab.tableStyleInfo = TableStyleInfo(name=None, showFirstColumn=False, showLastColumn=False,
                                        showRowStripes=False, showColumnStripes=False)
    ws.add_table(tab)


def build_history_workbook(srows, trows, path):
    import openpyxl
    wb = openpyxl.Workbook()
    try:
        normal = [s for s in wb._named_styles if s.name == "Normal"][0]
        normal.font = openpyxl.styles.Font(name=FONT, size=10, color="222222")
        normal.alignment = openpyxl.styles.Alignment(vertical="center")
    except Exception:
        pass
    ws = wb.active
    ws.title = "Sessions"
    ws.append(SESSION_COLS)
    for row in (srows or [[None] * len(SESSION_COLS)]):
        ws.append(row)
    DATE, DT = ("d mmm yy", "center"), ("d mmm yy hh:mm", "center")
    INT, DEC = ("#,##0", "right"), ("#,##0.0#", "right")
    style_history_sheet(
        ws, SESSION_COLS, len(srows), ["text", DATE, DT, DT, INT, "text", "text", "text", INT, INT],
        [38, 12, 17, 17, 9, 22, 34, 12, 7, 9])
    ws2 = wb.create_sheet("Sets")
    ws2.append(SET_COLS)
    for row in (trows or [[None] * len(SET_COLS)]):
        ws2.append(row)
    DTS = ("d mmm yy hh:mm:ss", "center")
    CEN = ("General", "center")
    style_history_sheet(
        ws2, SET_COLS, len(trows),
        ["text", DATE, "text", INT, INT, "text", "text", "text", "text", "text", "text", "text", DEC, INT, INT, DTS, CEN],
        [38, 12, 22, 10, 6, 12, 26, 11, 26, 10, 12, 10, 12, 8, 12, 19, 9])
    wb.properties.creator = "gymsync"
    wb.properties.title = "Gym History"
    fixed = dt.datetime(2026, 1, 1)
    wb.properties.created = fixed
    wb.properties.modified = fixed
    wb.save(path)
    normalise_zip(path)


def normalise_zip(path):
    """Re-pack the xlsx with fixed timestamps so two runs on the same data give identical bytes."""
    with zipfile.ZipFile(path) as zin:
        items = []
        for info in zin.infolist():
            data = zin.read(info.filename)
            if info.filename == "docProps/core.xml":
                data = re.sub(rb"(<dcterms:(?:created|modified)[^>]*>)[^<]*", rb"\g<1>2026-01-01T00:00:00Z", data)
            items.append((info.filename, data))
    tmp = path + ".norm"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for name, data in items:
            zi = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o600 << 16
            zout.writestr(zi, data)
    os.replace(tmp, path)


def read_old_revisions(path):
    """Session ID -> revision from the workbook about to be replaced.  {} if none or unreadable."""
    if not os.path.exists(path):
        return {}
    try:
        import openpyxl
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
        ws = wb["Sessions"]
        rows = ws.iter_rows(values_only=True)
        head = [norm_header(h) if h is not None else "" for h in next(rows)]
        i_id, i_rev = head.index("session id"), head.index("revision")
        out = {}
        for r in rows:
            if r[i_id]:
                out[str(r[i_id])] = r[i_rev]
        wb.close()
        return out
    except Exception:
        return {}


def step_history(run, folder, sessions):
    path = os.path.join(folder, HISTORY_FILE)
    srows, trows = history_rows(sessions)
    run.total = len(srows)
    old = read_old_revisions(path)
    run.new = sum(1 for r in srows if r[0] not in old)
    run.changed = sum(1 for r in srows if r[0] in old and old[r[0]] != r[9])
    lock = os.path.join(folder, "~$" + HISTORY_FILE)
    if os.path.exists(lock):
        run.flag("Close %s in Excel and press Sync again." % HISTORY_FILE)
        run.history_updated = False
        return
    tmp = os.path.join(folder, ".gymsync-%d.tmp" % os.getpid())
    try:
        build_history_workbook(srows, trows, tmp)
        if os.path.exists(path):
            with open(tmp, "rb") as a, open(path, "rb") as b:
                same = a.read() == b.read()
            if same:
                run.say("%s is already up to date (%d sessions)." % (HISTORY_FILE, run.total))
                run.history_updated = True
                return
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    run.history_updated = True
    run.say("%s updated: %d sessions, %d sets." % (HISTORY_FILE, len(srows), len(trows)))


# --------------------------------------------------------------------------- steps 8 and 9

def summary_line(run):
    if run.error:
        return "Sync failed \u00b7 %s" % run.error
    head = "Sync needs attention" if run.attention else "Sync ok"
    parts = [head]
    if run.setup_text:
        parts.append(run.setup_text)
    if run.history_updated is False:
        parts.append("history NOT updated \u00b7 %d sessions" % run.total)
    elif run.history_updated:
        c = "%d new" % run.new
        if run.changed:
            c += ", %d corrected" % run.changed
        parts.append("%d sessions (%s)" % (run.total, c))
    return " \u00b7 ".join(parts)


def step_status(run, folder, summary, result):
    status_dir = os.path.join(folder, "Status")
    if not os.path.isdir(folder):
        return
    os.makedirs(status_dir, exist_ok=True)
    path = os.path.join(status_dir, "last-sync.json")
    previous = {}
    try:
        with open(path, encoding="utf-8") as f:
            previous = json.load(f)
    except (OSError, ValueError):
        pass
    attempt = iso(now_local())
    doc = {
        "synced": previous.get("synced"),
        "last_attempt": attempt,
        "result": result,
        "host": socket.gethostname(),
        "setup_published_at": run.setup_published_at or previous.get("setup_published_at"),
        "sessions_total": run.total,
        "sessions_new": run.new,
        "sessions_changed": run.changed,
        "messages": run.messages + [summary],
    }
    if result == "ok":
        doc["synced"] = attempt
    atomic_write_text(path, json.dumps(doc, indent=2, ensure_ascii=False) + "\n")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Sync the gym logging setup and history.")
    ap.add_argument("--debug", action="store_true", help="show full error details")
    args = ap.parse_args(argv)
    run = Run(args.debug)
    folder, repo = folder_path(), repo_path()
    try:
        try:
            step_check_files(run, folder, repo)                  # step 1
            run.say("Updating the store from GitHub...")
            git_pull(run, repo, "the data folder")                # step 2
            setup_ok = step_setup(run, folder, repo)              # steps 3-5
            sessions = step_read_sessions(run, repo)              # step 6
            step_history(run, folder, sessions)                   # step 7
            if not setup_ok:
                run.attention = True
        except Stop as e:
            run.error = str(e)
        except Exception as e:
            if args.debug:
                traceback.print_exc()
            run.error = "Something unexpected went wrong (%s).  Run 'gymsync --debug' for details." % e
    finally:
        pass
    summary = summary_line(run)
    result = "error" if run.error else ("attention" if run.attention else "ok")
    try:
        step_status(run, folder, summary, result)                 # step 8
    except Exception as e:
        if args.debug:
            traceback.print_exc()
        run.say("Could not write the status file (%s)." % e)
        if result == "ok":
            result = "attention"
            summary = summary.replace("Sync ok", "Sync needs attention", 1)
    print(summary)                                                # step 9
    return {"ok": 0, "attention": 1, "error": 2}[result]


if __name__ == "__main__":
    sys.exit(main())
