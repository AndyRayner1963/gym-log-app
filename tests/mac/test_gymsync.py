import datetime as dt
import json
import os
import re
import shutil
import stat
import subprocess
import zipfile

import openpyxl
import pytest

from conftest import FIXTURES, ROOT, SAMPLE, git

FIX_SETUP = json.load(open(os.path.join(FIXTURES, "setup.json"), encoding="utf-8"))
SUMMARY_RE = re.compile(r"^Sync (ok|needs attention|failed) \u00b7 ")


def edit_setup(env, fn):
    wb = openpyxl.load_workbook(SAMPLE)
    fn(wb)
    wb.save(env.setup_xlsx)


def sessions_rows(path):
    ws = openpyxl.load_workbook(path)["Sessions"]
    return [[c.value for c in r] for r in ws.iter_rows(min_row=2)]


def sets_rows(path):
    ws = openpyxl.load_workbook(path)["Sets"]
    return [[c.value for c in r] for r in ws.iter_rows(min_row=2)]


def last_sync(env):
    return json.load(open(os.path.join(env.folder, "Status", "last-sync.json"), encoding="utf-8"))


# ---------------------------------------------------------------- brief 10.3 script test 1

def test_1_valid_workbook_publishes_and_second_run_publishes_nothing(env):
    before = env.origin_head()
    p = env.run()
    assert p.returncode == 0, p.stdout + p.stderr
    after = env.origin_head()
    assert after != before
    published = json.loads(env.origin_file("setup.json"))
    assert published["hash"] == FIX_SETUP["hash"]
    assert "setup published" in p.summary
    setup_bytes = open(os.path.join(env.data, "setup.json"), "rb").read()

    p2 = env.run()
    assert p2.returncode == 0, p2.stdout
    assert env.origin_head() == after                      # no new commit
    assert open(os.path.join(env.data, "setup.json"), "rb").read() == setup_bytes
    assert "setup unchanged" in p2.summary
    assert git(env.data, "status", "--porcelain") == ""


def test_unchanged_when_fixture_setup_already_published(env_seeded):
    before = env_seeded.origin_head()
    p = env_seeded.run()
    assert p.returncode == 0, p.stdout
    assert env_seeded.origin_head() == before
    assert "setup unchanged" in p.summary


def test_sample_workbook_produces_fixture_setup_json(env):
    assert env.run().returncode == 0
    got = json.loads(open(os.path.join(env.data, "setup.json"), encoding="utf-8").read())
    assert got["format"] == 1
    for k in ("hash", "groups", "exercises", "workouts"):
        assert got[k] == FIX_SETUP[k], k
    # whole numbers are integers in the raw text, not 5.0
    raw = open(os.path.join(env.data, "setup.json"), encoding="utf-8").read()
    assert '"increment_kg": 5,' in raw and '"increment_kg": 2.5,' in raw and '"increment_kg": 1.25,' in raw
    assert not re.search(r"\d\.0[,\s]", raw)
    assert dt.datetime.fromisoformat(got["published_at"]).utcoffset() is not None


def test_commit_uses_fallback_identity_and_respects_configured_one(env):
    assert env.run().returncode == 0
    assert git(env.data, "log", "-1", "--format=%an <%ae>") == "gymsync <gymsync@localhost>"


def test_commit_respects_repository_identity(env):
    git(env.data, "config", "user.name", "Someone")
    git(env.data, "config", "user.email", "someone@example.com")
    assert env.run().returncode == 0
    assert git(env.data, "log", "-1", "--format=%an <%ae>") == "Someone <someone@example.com>"


# ---------------------------------------------------------------- brief 10.3 script test 2: each 4.4 fault

def set_cell(sheet, ref, value):
    def fn(wb):
        wb[sheet][ref] = value
    return fn


def drop_header(sheet, ref):
    return set_cell(sheet, ref, "Nonsense")


def two(*fns):
    def fn(wb):
        for f in fns:
            f(wb)
    return fn


FAULT_CASES = [
    # id, edit, expected text in output (must include sheet name and row number)
    ("rule1-missing-exercises-column", drop_header("Exercises", "F1"), ["Exercises row 1", "Increment (kg)"]),
    ("rule1-missing-workouts-column", drop_header("Workouts", "E1"), ["Workouts row 1", "Target Min"]),
    ("rule1-missing-lists-column", drop_header("Lists", "C1"), ["Lists row 1", "Groups"]),
    ("rule2-id-missing", set_cell("Exercises", "A4", None), ["Exercises row 4", "ID is missing"]),
    ("rule2-id-form", set_cell("Exercises", "A4", "AB1"), ["Exercises row 4", "letter followed by a number"]),
    ("rule2-id-duplicate-case-insensitive", set_cell("Exercises", "A4", "a01"), ["Exercises row 4", "already used on row 2"]),
    ("rule3-name-missing", set_cell("Exercises", "B3", None), ["Exercises row 3", "name is missing"]),
    ("rule3-name-duplicate", set_cell("Exercises", "B3", "Test Machine Press"), ["Exercises row 3", "already used on row 2"]),
    ("rule4-group", set_cell("Exercises", "C5", "Nope"), ["Exercises row 5", "Group 'Nope'"]),
    ("rule4-type", set_cell("Exercises", "D5", "spaceship"), ["Exercises row 5", "Type 'spaceship'"]),
    ("rule4-measure", set_cell("Exercises", "E5", "Furlongs"), ["Exercises row 5", "Measure 'Furlongs'"]),
    ("rule4-active", set_cell("Exercises", "H5", "Maybe"), ["Exercises row 5", "Active must be Y or N"]),
    ("rule5-increment-zero", set_cell("Exercises", "F6", 0), ["Exercises row 6", "Increment"]),
    ("rule5-increment-text", set_cell("Exercises", "F6", "heavy"), ["Exercises row 6", "Increment"]),
    ("rule5-increment-negative", set_cell("Exercises", "F6", -2.5), ["Exercises row 6", "Increment"]),
    ("rule6-unknown-exercise", set_cell("Workouts", "C3", "Test Imaginary Lift"), ["Workouts row 3", "does not exist"]),
    ("rule6-inactive-exercise", set_cell("Workouts", "C3", "Test Retired Row"), ["Workouts row 3", "not active"]),
    ("rule6-exercise-blank", set_cell("Workouts", "C3", None), ["Workouts row 3", "Exercise is missing"]),
    ("rule7-order-duplicate", set_cell("Workouts", "B3", 1), ["Workouts row 3", "Order 1 is used twice"]),
    ("rule7-order-not-number", set_cell("Workouts", "B3", "two"), ["Workouts row 3", "Order must be"]),
    ("rule7-sets-zero", set_cell("Workouts", "D3", 0), ["Workouts row 3", "Sets must be"]),
    ("rule7-sets-fraction", set_cell("Workouts", "D3", 2.5), ["Workouts row 3", "Sets must be"]),
    ("rule8-target-fraction", set_cell("Workouts", "E4", 8.5), ["Workouts row 4", "Target Min must be a whole number"]),
    ("rule8-target-text", set_cell("Workouts", "F4", "lots"), ["Workouts row 4", "Target Max must be a whole number"]),
    ("rule8-min-above-max", two(set_cell("Workouts", "E4", 20), set_cell("Workouts", "F4", 10)), ["Workouts row 4", "greater than Target Max"]),
]


@pytest.mark.parametrize("name,edit,expected", FAULT_CASES, ids=[c[0] for c in FAULT_CASES])
def test_2_fault_is_caught_named_and_blocks_publishing(env, name, edit, expected):
    edit_setup(env, edit)
    before = env.origin_head()
    p = env.run()
    assert p.returncode == 1, p.stdout + p.stderr
    for fragment in expected:
        assert fragment in p.stdout, (fragment, p.stdout)
    assert env.origin_head() == before
    assert not os.path.exists(os.path.join(env.data, "setup.json"))
    assert "setup NOT published: 1 fault" in p.summary
    assert p.summary.startswith("Sync needs attention")
    # history is still built from the sessions (step 6 and 7 continue)
    assert os.path.exists(env.history)


def test_2_several_faults_are_counted_and_all_listed(env):
    edit_setup(env, two(set_cell("Exercises", "C5", "Nope"), set_cell("Workouts", "D3", 0)))
    p = env.run()
    assert p.returncode == 1
    assert "setup NOT published: 2 faults" in p.summary
    assert "Exercises row 5" in p.stdout and "Workouts row 3" in p.stdout


def test_columns_in_any_order_case_insensitive_blank_rows_and_trimming(env):
    def fn(wb):
        ws = wb["Exercises"]
        rows = [[c.value for c in r] for r in ws.iter_rows()]
        ws.delete_rows(1, ws.max_row)
        order = [7, 6, 5, 4, 3, 2, 1, 0]                       # reverse column order
        hdr = [rows[0][i] for i in order]
        hdr = [h.upper() if h != "Exercise" else "  exercise " for h in hdr]
        ws.append(hdr)
        ws.append([None] * 8)                                  # blank row
        for r in rows[1:]:
            vals = [r[i] for i in order]
            vals = [("  %s " % v if isinstance(v, str) else v) for v in vals]
            vals[order.index(0)] = "  " + r[0].lower() + " "    # ids in lower case, padded
            ws.append(vals)
    edit_setup(env, fn)
    p = env.run()
    assert p.returncode == 0, p.stdout
    got = json.loads(open(os.path.join(env.data, "setup.json"), encoding="utf-8").read())
    assert got["hash"] == FIX_SETUP["hash"]


def test_rule9_removed_exercise_is_a_warning_and_does_not_block(env_seeded):
    def fn(wb):
        ws = wb["Exercises"]
        ws.delete_rows(9)       # B05 Test Retired Row (not used in any workout)
    edit_setup(env_seeded, fn)
    p = env_seeded.run()
    assert p.returncode == 0, p.stdout
    assert "B05 Test Retired Row has been removed; set Active to N instead if it has history." in p.stdout
    got = json.loads(env_seeded.origin_file("setup.json"))
    assert "B05" not in [e["id"] for e in got["exercises"]]
    assert "setup published" in p.summary


def test_workouts_keep_first_appearance_order_and_items_sorted_by_order(env):
    def fn(wb):
        ws = wb["Workouts"]
        rows = [[c.value for c in r] for r in ws.iter_rows(min_row=2)]
        ws.delete_rows(2, ws.max_row)
        # Lower first, and Upper's items reversed
        for r in rows[4:] + list(reversed(rows[:4])):
            ws.append(r)
    edit_setup(env, fn)
    assert env.run().returncode == 0
    got = json.loads(open(os.path.join(env.data, "setup.json"), encoding="utf-8").read())
    assert [w["name"] for w in got["workouts"]] == ["Test Lower", "Test Upper"]
    assert [i["order"] for i in got["workouts"][1]["items"]] == [1, 2, 3, 4]


def test_blank_target_is_absent_and_comment_is_empty_string(env):
    def fn(wb):
        ws = wb["Workouts"]
        ws["E2"] = None
        ws["G2"] = None
    edit_setup(env, fn)
    assert env.run().returncode == 0
    got = json.loads(open(os.path.join(env.data, "setup.json"), encoding="utf-8").read())
    item = got["workouts"][0]["items"][0]
    assert "target_min" not in item and item["target_max"] == 12 and item["comment"] == ""


def test_workbook_never_modified(env):
    before = open(env.setup_xlsx, "rb").read()
    mtime = os.stat(env.setup_xlsx).st_mtime_ns
    env.run()
    env.run()
    assert open(env.setup_xlsx, "rb").read() == before
    assert os.stat(env.setup_xlsx).st_mtime_ns == mtime


# ---------------------------------------------------------------- brief 10.3 script test 3

def test_3_two_runs_give_identical_history_workbook(env):
    assert env.run().returncode == 0
    first = open(env.history, "rb").read()
    mtime = os.stat(env.history).st_mtime_ns
    assert env.run().returncode == 0
    assert open(env.history, "rb").read() == first      # byte-identical
    assert os.stat(env.history).st_mtime_ns == mtime    # and not even rewritten


# ---------------------------------------------------------------- history content

def test_history_has_5_sessions_48_sets_in_order_with_swapped_flags(env):
    assert env.run().returncode == 0
    wb = openpyxl.load_workbook(env.history)
    assert wb.sheetnames == ["Sessions", "Sets"]
    s_hdr = [c.value for c in wb["Sessions"][1]]
    t_hdr = [c.value for c in wb["Sets"][1]]
    assert s_hdr == ["Session ID", "Date", "Start", "End", "Minutes", "Workout", "Comment", "Status", "Sets", "Revision"]
    assert t_hdr == ["Session ID", "Date", "Workout", "Exercise Order", "Set", "Planned Exercise ID", "Planned Exercise",
                     "Exercise ID", "Exercise", "Group", "Type", "Measure", "Weight (kg)", "Reps", "Duration (s)",
                     "Time Logged", "Swapped", "RIR", "Failure"]
    srows, trows = sessions_rows(env.history), sets_rows(env.history)
    assert len(srows) == 5 and len(trows) == 48
    assert [r[1].date() if hasattr(r[1], "date") else r[1] for r in srows] == [
        dt.date(2026, 11, 3), dt.date(2026, 11, 5), dt.date(2026, 11, 7), dt.date(2026, 11, 8), dt.date(2026, 11, 9)]
    assert [r[7] for r in srows] == ["closed", "closed", "closed", "auto_closed", "closed"]
    assert [r[8] for r in srows] == [12, 8, 15, 5, 8]
    assert sum(r[8] for r in srows) == 48
    assert [r[4] for r in srows] == [42, 35, 51, 18, 35]        # whole minutes start to end
    assert srows[0][5] == "Test Upper" and srows[3][5] is None  # free-form: blank workout
    assert srows[0][6] == "Felt good today"
    assert srows[4][9] == 14                                     # revision
    # order inside the Sets sheet: session, then exercise order, then set
    keys = [(r[0], r[3], r[4]) for r in trows]
    sid_order = [r[0] for r in srows]
    assert keys == sorted(keys, key=lambda k: (sid_order.index(k[0]), k[1], k[2]))
    # swapped flags: only session 3 slot 2 sets 2 and 3
    sid3 = srows[2][0]
    swapped = [(r[0], r[3], r[4]) for r in trows if r[16] == "Y"]
    assert swapped == [(sid3, 2, 2), (sid3, 2, 3)]
    row = [r for r in trows if (r[0], r[3], r[4]) == (sid3, 2, 2)][0]
    assert (row[5], row[6], row[7], row[8]) == ("B01", "Test Cable Row", "B02", "Test Machine Row")
    # an added exercise has no planned exercise and is not 'swapped'
    added = [r for r in trows if r[0] == sid3 and r[3] == 5]
    assert len(added) == 2 and all(r[5] is None and r[16] == "N" for r in added)
    # measure columns: reps for reps, duration for time
    plank = [r for r in trows if r[7] == "D01"][0]
    assert plank[13] is None and plank[14] == 50 and plank[11] == "time"
    press = trows[0]
    assert press[13] == 12 and press[14] is None and press[12] == 40


def test_history_datetimes_are_local_wall_clock_not_converted(env):
    p = env.run(extra_env={"TZ": "America/New_York"})
    assert p.returncode == 0
    srows = sessions_rows(env.history)
    assert srows[2][2] == dt.datetime(2026, 11, 7, 16, 42, 0)
    assert srows[2][3] == dt.datetime(2026, 11, 7, 17, 33, 0)
    trows = sets_rows(env.history)
    first_of_s3 = [r for r in trows if r[0] == srows[2][0]][0]
    assert first_of_s3[15] == dt.datetime(2026, 11, 7, 16, 45, 0)
    assert isinstance(srows[2][1], (dt.date, dt.datetime))


def test_history_tables_are_valid_and_match_data_ranges(env):
    assert env.run().returncode == 0
    wb = openpyxl.load_workbook(env.history)
    for sheet, table, ncols in (("Sessions", "tblSessions", 10), ("Sets", "tblSets", 19)):
        ws = wb[sheet]
        assert list(ws.tables) == [table]
        ref = ws.tables[table].ref
        assert ref == "A1:%s%d" % (openpyxl.utils.get_column_letter(ncols), ws.max_row)
        names = [c.name for c in ws.tables[table].tableColumns]
        assert names == [c.value for c in ws[1]]
    # real dates / times, not text
    ws = wb["Sessions"]
    assert isinstance(ws["C2"].value, dt.datetime) and ws["C2"].number_format != "General"


def test_history_with_zero_sessions_is_still_a_valid_table(env):
    for root, dirs, files in os.walk(os.path.join(env.data, "sessions")):
        for f in files:
            os.remove(os.path.join(root, f))
    git(env.data, "add", "-A")
    git(env.data, "commit", "-q", "-m", "empty")
    git(env.data, "push", "-q", "origin", "HEAD:main")
    p = env.run()
    assert p.returncode == 0, p.stdout
    wb = openpyxl.load_workbook(env.history)
    assert wb["Sessions"].tables["tblSessions"].ref == "A1:J2"
    assert wb["Sets"].tables["tblSets"].ref == "A1:S2"
    assert "0 sessions (0 new)" in p.summary


def test_history_house_style_basics(env):
    assert env.run().returncode == 0
    ws = openpyxl.load_workbook(env.history)["Sessions"]
    assert ws["A1"].font.name == "Lato" and ws["A1"].font.bold and ws["A1"].fill.start_color.rgb.endswith("E2E6E4")
    assert ws.freeze_panes == "A2" and ws.sheet_view.zoomScale == 130


# ---------------------------------------------------------------- brief 10.3 script test 4

def test_4_corrected_session_replaces_rows_deleted_disappears_open_left_out(env):
    assert env.run().returncode == 0
    base_sets = sets_rows(env.history)
    srows = sessions_rows(env.history)
    sid_s1, sid_s3 = srows[0][0], srows[2][0]

    def change(other):
        # correct session 1: revision up, one set changed, comment changed
        p = env.session_path(other, "2026-11-03")
        d = json.load(open(p, encoding="utf-8"))
        d["revision"] += 1
        d["comment"] = "Corrected comment"
        d["sets"][0]["reps"] = 99
        json.dump(d, open(p, "w", encoding="utf-8"), indent=2)
        # delete session 3
        p = env.session_path(other, "2026-11-07")
        d = json.load(open(p, encoding="utf-8"))
        d["status"] = "deleted"
        d["sets"] = []
        d["revision"] += 1
        json.dump(d, open(p, "w", encoding="utf-8"), indent=2)
        # the open session (11-10 16:42) is still open: change its revision only
        p = env.session_path(other, "2026-11-10_f271")
        d = json.load(open(p, encoding="utf-8"))
        d["revision"] += 1
        json.dump(d, open(p, "w", encoding="utf-8"), indent=2)

    env.push_change(change)
    p = env.run()
    assert p.returncode == 0, p.stdout
    srows2 = sessions_rows(env.history)
    assert len(srows2) == 4
    assert sid_s3 not in [r[0] for r in srows2]
    s1 = [r for r in srows2 if r[0] == sid_s1][0]
    assert s1[6] == "Corrected comment" and s1[9] == srows[0][9] + 1
    sets2 = sets_rows(env.history)
    assert len(sets2) == 48 - 15
    assert [r[13] for r in sets2 if r[0] == sid_s1][0] == 99
    assert sum(1 for r in sets2 if r[0] == sid_s1) == 12            # replaced, not duplicated
    assert "4 sessions (0 new, 1 corrected)" in p.summary
    assert last_sync(env)["sessions_changed"] == 1 and last_sync(env)["sessions_new"] == 0


def test_4_open_session_that_closes_counts_as_new(env):
    assert env.run().returncode == 0

    def close_it(other):
        p = env.session_path(other, "2026-11-10_f271")
        d = json.load(open(p, encoding="utf-8"))
        d["status"] = "closed"
        d["ended_at"] = "2026-11-10T17:10:00+07:00"
        d["revision"] += 1
        json.dump(d, open(p, "w", encoding="utf-8"), indent=2)

    env.push_change(close_it)
    p = env.run()
    assert p.returncode == 0
    assert "6 sessions (1 new)" in p.summary
    assert len(sets_rows(env.history)) == 50


# ---------------------------------------------------------------- brief 10.3 script test 5

def test_5_unreadable_session_files_are_skipped_and_reported(env):
    def add_bad(other):
        d = os.path.join(other, "sessions", "2026")
        open(os.path.join(d, "2026-11-11_broken.json"), "w").write("{ not json at all")
        open(os.path.join(d, "2026-11-12_missingfields.json"), "w").write(json.dumps({"format": 1, "session_id": "x"}))
    env.push_change(add_bad)
    p = env.run()
    assert p.returncode == 1
    assert "2026-11-11_broken.json" in p.stdout and "2026-11-12_missingfields.json" in p.stdout
    assert "required field" in p.stdout
    assert len(sessions_rows(env.history)) == 5 and len(sets_rows(env.history)) == 48
    assert p.summary.startswith("Sync needs attention")
    assert "setup published" in p.summary           # the setup step is unaffected


def test_higher_format_session_is_skipped_with_a_message(env):
    def add_new_format(other):
        p = env.session_path(other, "2026-11-09")
        d = json.load(open(p, encoding="utf-8"))
        d["format"] = 2
        json.dump(d, open(p, "w", encoding="utf-8"))
    env.push_change(add_new_format)
    p = env.run()
    assert p.returncode == 1
    assert "format 2" in p.stdout and "2026-11-09" in p.stdout
    assert len(sessions_rows(env.history)) == 4


def test_session_with_bad_set_is_skipped(env):
    def damage(other):
        p = env.session_path(other, "2026-11-05")
        d = json.load(open(p, encoding="utf-8"))
        del d["sets"][1]["exercise_id"]
        json.dump(d, open(p, "w", encoding="utf-8"))
    env.push_change(damage)
    p = env.run()
    assert p.returncode == 1 and "2026-11-05" in p.stdout and "set 2" in p.stdout
    assert len(sessions_rows(env.history)) == 4


# ---------------------------------------------------------------- brief 10.3 script test 6

def test_6_lock_file_stops_step_7_and_leaves_old_workbook_untouched(env):
    assert env.run().returncode == 0
    old = open(env.history, "rb").read()
    mtime = os.stat(env.history).st_mtime_ns

    def change(other):
        p = env.session_path(other, "2026-11-03")
        d = json.load(open(p, encoding="utf-8"))
        d["revision"] += 1
        d["comment"] = "changed"
        json.dump(d, open(p, "w", encoding="utf-8"))
    env.push_change(change)
    open(os.path.join(env.folder, "~$Gym History.xlsx"), "w").write("lock")
    p = env.run()
    assert p.returncode == 1
    assert "Close Gym History.xlsx in Excel and press Sync again" in p.stdout
    assert open(env.history, "rb").read() == old
    assert os.stat(env.history).st_mtime_ns == mtime
    assert [f for f in os.listdir(env.folder) if f.endswith(".tmp")] == []
    assert last_sync(env)["result"] == "attention"
    # after Excel is closed the next run succeeds and picks the change up
    os.remove(os.path.join(env.folder, "~$Gym History.xlsx"))
    p = env.run()
    assert p.returncode == 0 and "1 corrected" in p.summary


def test_6_lock_file_with_no_workbook_yet_creates_nothing(env):
    open(os.path.join(env.folder, "~$Gym History.xlsx"), "w").write("lock")
    p = env.run()
    assert p.returncode == 1
    assert not os.path.exists(env.history)


# ---------------------------------------------------------------- brief 10.3 script test 7

def test_7_push_refused_because_store_moved_on_succeeds_second_attempt(env, tmp_path):
    other = os.path.join(env.tmp, "rival")
    subprocess.check_call(["git", "clone", "-q", env.origin, other], stderr=subprocess.DEVNULL)
    marker = os.path.join(env.tmp, "rival-pushed")
    wrapper = os.path.join(env.tmp, "gitwrap.sh")
    open(wrapper, "w").write("""#!/bin/bash
for a in "$@"; do
  if [ "$a" = "push" ] && [ ! -e "%(marker)s" ]; then
    touch "%(marker)s"
    echo rival > "%(other)s/rival.txt"
    git -C "%(other)s" add -A
    git -C "%(other)s" -c user.name=R -c user.email=r@x commit -q -m rival
    git -C "%(other)s" push -q origin HEAD:main
  fi
done
exec git "$@"
""" % {"marker": marker, "other": other})
    os.chmod(wrapper, 0o755)
    p = env.run(extra_env={"GYMSYNC_GIT": wrapper})
    assert p.returncode == 0, p.stdout + p.stderr
    assert os.path.exists(marker)                                  # the first push really was refused
    assert env.origin_file("rival.txt") == "rival\n"
    assert json.loads(env.origin_file("setup.json"))["hash"] == FIX_SETUP["hash"]
    assert git(env.data, "rev-list", "--count", "@{u}..HEAD") == "0"
    assert "setup published" in p.summary


def test_7_push_refused_twice_is_an_error(env):
    wrapper = os.path.join(env.tmp, "gitwrap.sh")
    open(wrapper, "w").write("""#!/bin/bash
for a in "$@"; do [ "$a" = "push" ] && { echo "rejected" >&2; exit 1; }; done
exec git "$@"
""")
    os.chmod(wrapper, 0o755)
    p = env.run(extra_env={"GYMSYNC_GIT": wrapper})
    assert p.returncode == 2
    assert p.summary.startswith("Sync failed")


def test_unpublished_commit_is_pushed_on_next_run(env):
    wrapper = os.path.join(env.tmp, "gitwrap.sh")
    open(wrapper, "w").write("""#!/bin/bash
for a in "$@"; do [ "$a" = "push" ] && { echo "offline" >&2; exit 1; }; done
exec git "$@"
""")
    os.chmod(wrapper, 0o755)
    assert env.run(extra_env={"GYMSYNC_GIT": wrapper}).returncode == 2
    assert env.origin_file("setup.json") is None
    p = env.run()                                                  # real git now
    assert p.returncode == 0
    assert json.loads(env.origin_file("setup.json"))["hash"] == FIX_SETUP["hash"]


# ---------------------------------------------------------------- brief 10.3 script test 8

def test_8_exit_codes_and_summary_lines(env):
    p = env.run()
    assert p.returncode == 0
    assert re.match(r"^Sync ok \u00b7 setup published \d\d:\d\d \u00b7 5 sessions \(5 new\)$", p.summary), p.summary
    p = env.run()
    assert p.returncode == 0
    assert p.summary == "Sync ok \u00b7 setup unchanged \u00b7 5 sessions (0 new)"
    edit_setup(env, two(set_cell("Exercises", "C5", "Nope"), set_cell("Workouts", "D3", 0)))
    p = env.run()
    assert p.returncode == 1
    assert p.summary == "Sync needs attention \u00b7 setup NOT published: 2 faults \u00b7 5 sessions (0 new)"
    shutil.rmtree(env.data)
    p = env.run()
    assert p.returncode == 2
    assert SUMMARY_RE.match(p.summary) and p.summary.startswith("Sync failed")
    assert all(line == "" or not line.startswith("Traceback") for line in p.lines)
    assert "Traceback" not in p.stderr


def test_8_last_line_is_always_the_summary(env):
    for _ in range(2):
        p = env.run()
        assert SUMMARY_RE.match(p.lines[-1])


# ---------------------------------------------------------------- step 1 and 2 failures

def test_missing_setup_workbook_is_error_naming_it(env):
    os.remove(env.setup_xlsx)
    p = env.run()
    assert p.returncode == 2 and "Gym Setup.xlsx is missing" in p.stdout


def test_icloud_placeholder_means_not_downloaded_yet(env):
    os.remove(env.setup_xlsx)
    open(os.path.join(env.folder, ".Gym Setup.xlsx.icloud"), "w").write("x")
    p = env.run()
    assert p.returncode == 2
    assert "not downloaded" in p.stdout and "Gym Setup.xlsx" in p.stdout


def test_missing_folder_and_repo_are_errors(env):
    shutil.rmtree(env.folder)
    shutil.rmtree(env.data)
    p = env.run()
    assert p.returncode == 2
    assert "Gym Logging folder is missing" in p.stdout and "data repository is missing" in p.stdout


def test_pull_failure_stops_everything(env):
    os.rename(env.origin, env.origin + ".gone")
    p = env.run()
    assert p.returncode == 2
    assert "Could not update" in p.stdout
    assert not os.path.exists(env.history)
    assert not os.path.exists(os.path.join(env.data, "setup.json"))


def test_empty_remote_store_first_publish(env, tmp_path):
    # a brand-new empty private repository: no commits yet
    empty = os.path.join(env.tmp, "empty.git")
    subprocess.check_call(["git", "init", "--bare", "-q", "-b", "main", empty])
    shutil.rmtree(env.data)
    subprocess.check_call(["git", "clone", "-q", empty, env.data], stderr=subprocess.DEVNULL)
    p = env.run()
    assert p.returncode == 0, p.stdout
    out = subprocess.run(["git", "show", "main:setup.json"], cwd=empty, stdout=subprocess.PIPE, universal_newlines=True)
    assert json.loads(out.stdout)["hash"] == FIX_SETUP["hash"]


def test_unreadable_setup_workbook_is_attention_not_a_crash(env):
    open(env.setup_xlsx, "wb").write(b"this is not an xlsx file")
    p = env.run()
    assert p.returncode == 1 and "could not be read" in p.stdout
    assert "Traceback" not in p.stdout + p.stderr


def test_debug_option_shows_traceback_otherwise_plain_sentence(env):
    os.remove(env.setup_xlsx)
    os.mkdir(env.setup_xlsx)            # a folder where the workbook should be: openpyxl cannot open it
    p = env.run()
    assert p.returncode == 1 and "Traceback" not in p.stdout + p.stderr
    p = env.run("--debug")
    assert p.returncode == 2 and "Traceback" in p.stderr


# ---------------------------------------------------------------- never writes where it must not

def test_never_touches_sessions_or_deletes_and_leaves_tree_clean(env):
    def snapshot():
        out = {}
        for root, dirs, files in os.walk(env.data):
            dirs[:] = [d for d in dirs if d != ".git"]
            for f in files:
                p = os.path.join(root, f)
                out[os.path.relpath(p, env.data)] = open(p, "rb").read()
        return out
    before = snapshot()
    env.run()
    env.run()
    after = snapshot()
    assert set(before) <= set(after)
    for k in before:
        assert after[k] == before[k], k
    assert set(after) - set(before) == {"setup.json"}


# ---------------------------------------------------------------- last-sync.json (brief 3.5)

def test_last_sync_json_fields_and_synced_updated_on_success(env):
    p = env.run()
    d = last_sync(env)
    assert set(d) == {"synced", "last_attempt", "result", "host", "setup_published_at", "sessions_total",
                      "sessions_new", "sessions_changed", "messages"}
    assert d["result"] == "ok" and d["synced"] == d["last_attempt"]
    assert d["sessions_total"] == 5 and d["sessions_new"] == 5 and d["sessions_changed"] == 0
    assert d["setup_published_at"] == json.loads(open(os.path.join(env.data, "setup.json")).read())["published_at"]
    assert d["messages"][-1] == p.summary
    assert dt.datetime.fromisoformat(d["synced"]).utcoffset() is not None
    assert [f for f in os.listdir(os.path.join(env.folder, "Status"))] == ["last-sync.json"]


def test_last_sync_keeps_old_synced_after_failed_or_attention_run(env):
    assert env.run().returncode == 0
    good = last_sync(env)
    import time
    time.sleep(1.1)
    edit_setup(env, set_cell("Exercises", "C5", "Nope"))
    assert env.run().returncode == 1
    d = last_sync(env)
    assert d["result"] == "attention" and d["synced"] == good["synced"] and d["last_attempt"] != good["last_attempt"]
    time.sleep(1.1)
    os.rename(env.origin, env.origin + ".gone")
    assert env.run().returncode == 2
    d2 = last_sync(env)
    assert d2["result"] == "error" and d2["synced"] == good["synced"]
    assert d2["setup_published_at"] == good["setup_published_at"]


# ---------------------------------------------------------------- the empty setup workbook

def test_empty_setup_workbook_template(tmp_path):
    out = str(tmp_path / "Gym Setup.xlsx")
    subprocess.check_call(["python3", os.path.join(ROOT, "mac", "make_setup_workbook.py"), out], stdout=subprocess.DEVNULL)
    committed = os.path.join(ROOT, "mac", "templates", "Gym Setup.xlsx")
    for path in (out, committed):
        wb = openpyxl.load_workbook(path)
        assert wb.sheetnames == ["Exercises", "Workouts", "Lists"]
        assert [c.value for c in wb["Exercises"][1]] == ["ID", "Exercise", "Group", "Type", "Measure", "Increment (kg)", "Note", "Active"]
        assert [c.value for c in wb["Workouts"][1]] == ["Workout", "Order", "Exercise", "Sets", "Target Min", "Target Max", "Comment"]
        # no exercises, no workouts
        assert all(c.value is None for r in wb["Exercises"].iter_rows(min_row=2) for c in r)
        assert all(c.value is None for r in wb["Workouts"].iter_rows(min_row=2) for c in r)
        lists = wb["Lists"]
        assert [lists.cell(row=r, column=1).value for r in range(2, 9)] == [
            "machine", "cable", "barbell", "dumbbell", "kettlebell", "bodyweight", "assisted"]
        assert [lists.cell(row=r, column=2).value for r in (2, 3)] == ["Reps", "Time"]
        assert all(lists.cell(row=r, column=3).value is None for r in range(2, 61))      # Groups left empty
        dv = dict((str(d.sqref), d.formula1) for d in wb["Exercises"].data_validations.dataValidation)
        assert dv["C2:C500"] == "GroupList" and dv["D2:D500"] == "TypeList"
        assert dv["E2:E500"] == "MeasureList" and dv["H2:H500"] == '"Y,N"'
        dvw = dict((str(d.sqref), d.formula1) for d in wb["Workouts"].data_validations.dataValidation)
        assert dvw["C2:C500"] == "ExerciseList"
        assert set(wb.defined_names) >= {"GroupList", "TypeList", "MeasureList", "ExerciseList"}
        assert wb["Lists"].protection.sheet
        assert wb["Exercises"]["A1"].font.name == "Lato"


def test_setup_with_no_exercises_is_a_fault_and_history_still_runs(env):
    shutil.copy(os.path.join(ROOT, "mac", "templates", "Gym Setup.xlsx"), env.setup_xlsx)
    before = env.origin_head()
    p = env.run()
    assert p.returncode == 1, p.stdout
    assert "Exercises: the sheet has no exercises yet.  Add at least one exercise before pressing Sync." in p.stdout
    assert "setup NOT published: 1 fault" in p.summary and p.summary.startswith("Sync needs attention")
    assert env.origin_head() == before and not os.path.exists(os.path.join(env.data, "setup.json"))
    assert len(sessions_rows(env.history)) == 5


def test_setup_with_exercises_but_no_workouts_is_valid(env):
    def fn(wb):
        ws = wb["Workouts"]
        ws.delete_rows(2, ws.max_row)
    edit_setup(env, fn)
    p = env.run()
    assert p.returncode == 0, p.stdout
    got = json.loads(env.origin_file("setup.json"))
    assert got["workouts"] == [] and len(got["exercises"]) == 12


def test_filled_template_works_end_to_end(env):
    """Fill the empty template with the fixture's invented data, as Andy would, and compare with the fixture hash."""
    wb = openpyxl.load_workbook(os.path.join(ROOT, "mac", "templates", "Gym Setup.xlsx"))
    sample = openpyxl.load_workbook(SAMPLE)
    for name in ("Exercises", "Workouts"):
        for r, row in enumerate(sample[name].iter_rows(min_row=2, values_only=True), 2):
            for c, v in enumerate(row, 1):
                wb[name].cell(row=r, column=c, value=v)
    for r, row in enumerate(sample["Lists"].iter_rows(min_row=2, values_only=True), 2):
        wb["Lists"].cell(row=r, column=3, value=row[2])
    wb.save(env.setup_xlsx)
    p = env.run()
    assert p.returncode == 0, p.stdout
    assert json.loads(env.origin_file("setup.json"))["hash"] == FIX_SETUP["hash"]


# ---------------------------------------------------------------- opens in a real spreadsheet program

@pytest.mark.skipif(shutil.which("soffice") is None, reason="LibreOffice (soffice) not installed")
def test_libreoffice_opens_generated_workbooks(env, tmp_path):
    assert env.run().returncode == 0
    out = tmp_path / "pdf"
    out.mkdir()
    for path in (env.history, os.path.join(ROOT, "mac", "templates", "Gym Setup.xlsx")):
        p = subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir", str(out), path],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=180,
                           env=dict(os.environ, HOME=str(tmp_path)))
        pdf = out / (os.path.splitext(os.path.basename(path))[0] + ".pdf")
        assert p.returncode == 0 and pdf.exists() and pdf.stat().st_size > 1000, p.stdout + p.stderr


# ---------------------------------------------------------------- setup.command and launcher

def test_setup_command_syntax_and_launcher_template():
    cmd = os.path.join(ROOT, "mac", "setup.command")
    assert subprocess.run(["bash", "-n", cmd]).returncode == 0
    assert os.stat(cmd).st_mode & stat.S_IXUSR
    text = open(cmd).read()
    for n in range(1, 9):
        assert "step %d " % n in text
    assert "api user -q .login" in text and "auth status" in text and "osascript" not in text
    launcher = open(os.path.join(ROOT, "mac", "gymsync.launcher")).read().strip().splitlines()
    assert len(launcher) == 2 and launcher[0].startswith("#!")
    assert 'exec "$HOME/gym-log-app/mac/.venv/bin/python" "$HOME/gym-log-app/mac/gymsync.py" "$@"' == launcher[1]
    assert subprocess.run(["bash", "-n", os.path.join(ROOT, "mac", "gymsync.launcher")]).returncode == 0


def test_script_uses_nothing_beyond_stdlib_and_openpyxl():
    src = open(os.path.join(ROOT, "mac", "gymsync.py")).read()
    mods = set(re.findall(r"^\s*(?:import|from)\s+([a-zA-Z_]+)", src, re.M))
    allowed = {"argparse", "datetime", "hashlib", "json", "math", "os", "re", "socket", "subprocess", "sys",
               "traceback", "zipfile", "openpyxl"}
    assert mods <= allowed, mods - allowed


# ---------------------------------------------------------------- reps in reserve (app 1.1.0, history format 2)

def rir_of(trows, sid, slot, setno):
    row = [r for r in trows if (r[0], r[3], r[4]) == (sid, slot, setno)][0]
    return row[17], row[18]


def test_rir_and_failure_columns_sit_after_swapped_with_correct_values(env):
    assert env.run().returncode == 0
    ws = openpyxl.load_workbook(env.history)["Sets"]
    head = [c.value for c in ws[1]]
    assert head[16:] == ["Swapped", "RIR", "Failure"] and len(head) == 19
    srows, trows = sessions_rows(env.history), sets_rows(env.history)
    s07, s09 = srows[2][0], srows[4][0]
    assert rir_of(trows, s07, 1, 3) == (3, None)
    assert rir_of(trows, s07, 1, 4) == (1, None)
    assert rir_of(trows, s09, 1, 3) == (0, "Y")
    assert rir_of(trows, s09, 2, 3) == (0, None)
    # sets without the fields: both blank; any RIR present is an integer and Y only ever sits with RIR 0
    recorded = [r for r in trows if r[17] is not None]
    assert 0 < len(recorded) < len(trows)
    assert all(r[17] is None and r[18] is None for r in trows if r[17] is None)
    assert all(isinstance(r[17], int) and 0 <= r[17] <= 5 for r in recorded)
    assert all(r[17] == 0 for r in trows if r[18] == "Y")
    # styling matches Swapped
    assert ws["R2"].alignment.horizontal == ws["Q2"].alignment.horizontal == "center"
    assert ws["S2"].alignment.horizontal == "center"
    assert ws["R1"].font.bold and ws["R1"].fill.start_color.rgb == ws["Q1"].fill.start_color.rgb
    assert ws.column_dimensions["R"].width and ws.column_dimensions["S"].width


@pytest.mark.parametrize("label,fields", [
    ("six", {"rir": 6, "failed": False}),
    ("negative", {"rir": -1, "failed": False}),
    ("text", {"rir": "2", "failed": False}),
    ("float", {"rir": 2.5, "failed": False}),
    ("bool", {"rir": True, "failed": False}),
    ("failed_not_bool", {"rir": 0, "failed": "yes"}),
    ("rir_without_failed", {"rir": 2}),
    ("failed_without_rir", {"failed": True}),
])
def test_malformed_rir_skips_that_file_only(env, label, fields):
    def poison(other):
        p = env.session_path(other, "2026-11-07")
        d = json.load(open(p, encoding="utf-8"))
        for s in d["sets"]:
            s.pop("rir", None)
            s.pop("failed", None)
        d["sets"][2].update(fields)
        json.dump(d, open(p, "w", encoding="utf-8"), indent=2)
    env.push_change(poison)
    p = env.run()
    assert p.returncode == 1, p.stdout
    assert "2026-11-07_" in p.stdout and "Skipped" in p.stdout
    assert p.summary.startswith("Sync needs attention")
    assert len(sessions_rows(env.history)) == 4            # the other four are processed
    assert last_sync(env)["result"] == "attention"


def test_history_records_format_number_2_invisibly(env):
    assert env.run().returncode == 0
    wb = openpyxl.load_workbook(env.history)
    assert wb.sheetnames == ["Sessions", "Sets"]
    props = {p.name: p.value for p in wb.custom_doc_props.props}
    assert props == {"Swole history format": 2}


def test_second_run_with_rir_data_is_identical(env):
    assert env.run().returncode == 0
    first = open(env.history, "rb").read()
    assert env.run().returncode == 0
    assert open(env.history, "rb").read() == first


def write_format_1_history(env):
    """Build a history workbook as the pre-change script did: 17 Sets columns, no format property."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("gymsync_fmt1", os.path.join(ROOT, "mac", "gymsync.py"))
    g = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(g)
    sessions = g.step_read_sessions(type("R", (), {"flag": lambda *a: None})(), env.data)
    srows, trows = g.history_rows(sessions)
    g.SET_COLS = g.SET_COLS[:17]
    tmp = env.history + ".tmp"
    g.build_history_workbook(srows, [r[:17] for r in trows], tmp)
    with zipfile.ZipFile(tmp) as zin, zipfile.ZipFile(env.history, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            if "custom" in info.filename:
                continue
            data = zin.read(info.filename)
            if info.filename == "[Content_Types].xml":
                data = re.sub(rb"<Override[^>]*custom\.xml[^>]*/>", b"", data)
            if info.filename == "_rels/.rels":
                data = re.sub(rb"<Relationship [^>]*custom\.xml[^>]*/>", b"", data)
            zout.writestr(info, data)
    os.remove(tmp)


def test_upgrade_from_a_format_1_history_written_by_the_old_layout(env):
    write_format_1_history(env)
    wb = openpyxl.load_workbook(env.history)
    assert [c.value for c in wb["Sets"][1]][-1] == "Swapped" and not wb.custom_doc_props.props
    p = env.run()
    assert p.returncode == 0, p.stdout + p.stderr
    assert "5 sessions (0 new)" in p.summary and "corrected" not in p.summary
    assert "upgraded to history format 2" in p.stdout
    assert last_sync(env)["sessions_changed"] == 0 and last_sync(env)["sessions_new"] == 0
    assert [c.value for c in openpyxl.load_workbook(env.history)["Sets"][1]][-2:] == ["RIR", "Failure"]
    p3 = env.run()
    assert "upgraded" not in p3.stdout and "already up to date" in p3.stdout
