"""Builds the shared fixtures (the data contract of BRIEF.md section 3).  Invented exercises only.
Run: python3 fixtures/make_fixtures.py   (from the repository root).  Deterministic."""
import json, hashlib, uuid, os, shutil
from datetime import datetime, timedelta, timezone
import openpyxl
HERE = os.path.dirname(os.path.abspath(__file__))
TZ = timezone(timedelta(hours=7))
NS = uuid.UUID('00000000-0000-0000-0000-000000000001')
def uid(label): return str(uuid.uuid5(NS, label))
def iso(d): return d.isoformat(timespec='seconds')

GROUPS = ['Push', 'Pull', 'Legs', 'Core']
EX = [  # id, name, group, type, measure, increment, note, active
 ('A01', 'Test Machine Press',   'Push', 'machine',    'reps', 5,    'Seat at position 5', True),
 ('A02', 'Test Cable Press',     'Push', 'cable',      'reps', 2.5,  '', True),
 ('A03', 'Test Dumbbell Press',  'Push', 'dumbbell',   'reps', 2,    'Neutral grip', True),
 ('B01', 'Test Cable Row',       'Pull', 'cable',      'reps', 2.5,  'Neutral V-handle.  Seat at position 3.', True),
 ('B02', 'Test Machine Row',     'Pull', 'machine',    'reps', 5,    '', True),
 ('B03', 'Test Assisted Pull-Up','Pull', 'assisted',   'reps', 5,    'Neutral handles', True),
 ('B04', 'Test Barbell Row',     'Pull', 'barbell',    'reps', 1.25, 'Plates only', True),
 ('B05', 'Test Retired Row',     'Pull', 'machine',    'reps', 5,    '', False),
 ('C01', 'Test Leg Press',       'Legs', 'machine',    'reps', 10,   'Back pad at 2', True),
 ('C02', 'Test Kettlebell Carry','Legs', 'kettlebell', 'time', 2,    '', True),
 ('D01', 'Test Plank',           'Core', 'bodyweight', 'time', 2.5,  '', True),
 ('D02', 'Test Bodyweight Crunch','Core','bodyweight', 'reps', 2.5,  '', True),
]
WORKOUTS = [
 ('Test Upper', [(1, 'A01', 3, 8, 12, 'Slow lowering'), (2, 'B01', 3, 10, 12, 'Pause at the chest'),
                 (3, 'B03', 3, 6, 10, ''), (4, 'D01', 3, 45, 60, '')]),
 ('Test Lower', [(1, 'C01', 3, 10, 15, ''), (2, 'C02', 3, 60, 75, 'Move up at 75 s'), (3, 'D02', 2, 15, 20, '')]),
]
# Exercise default targets (v1.2.0): optional Target Min / Target Max on the Exercises sheet, used
# where no workout target applies (free-form and added exercises).  Absent from setup.json when blank.
EX_TARGETS = {'A02': (8, 12), 'A03': (10, 15), 'B04': (6, None), 'C02': (60, 75)}
exercises = [dict(id=i, name=n, group=g, type=t, measure=m, increment_kg=inc, note=note, active=a) for i, n, g, t, m, inc, note, a in EX]
for e in exercises:
    lo, hi = EX_TARGETS.get(e['id'], (None, None))
    if lo is not None: e['target_min'] = lo
    if hi is not None: e['target_max'] = hi
workouts = [dict(name=w, items=[dict(order=o, exercise_id=e, sets=s, target_min=lo, target_max=hi, comment=c) for o, e, s, lo, hi, c in items]) for w, items in WORKOUTS]
content = dict(groups=GROUPS, exercises=exercises, workouts=workouts)
canon = json.dumps(content, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
PUBLISHED = '2026-11-02T08:15:00+07:00'
setup = dict(format=1, published_at=PUBLISHED, hash=hashlib.sha256(canon.encode('utf-8')).hexdigest(), **content)
json.dump(setup, open(os.path.join(HERE, 'setup.json'), 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
BYID = {e['id']: e for e in exercises}

def session(label, start, workout, status, slots, comment='', revision=None, ended=None, edits=(), rir=None):
    """slots: list of (planned_id or None, [(actual_id, weight, reps_or_seconds, minutes_after_start), ...])
    rir: {(position, set_number): 0-5 or 'F'}.  'F' (failure) is stored as rir 0 with failed true.
    Sets without an entry carry neither field (RIR not recorded, as in files made before 1.1.0)."""
    sid = uid(label); start = datetime.fromisoformat(start).replace(tzinfo=TZ); sets = []; last = start
    for pos, (planned, done) in enumerate(slots, 1):
        for n, (actual, w, val, mins) in enumerate(done, 1):
            e = BYID[actual]; t = start + timedelta(minutes=mins); last = max(last, t)
            s = dict(set_id=uid(f'{label}-{pos}-{n}'), position=pos, set_number=n,
                     exercise_id=actual, exercise_name=e['name'], group=e['group'], type=e['type'], measure=e['measure'],
                     weight_kg=w, logged_at=iso(t))
            if planned: s['planned_exercise_id'] = planned; s['planned_exercise_name'] = BYID[planned]['name']
            s['reps' if e['measure'] == 'reps' else 'duration_s'] = val
            if (pos, n) in edits: s['edited_at'] = iso(t + timedelta(days=1))
            if rir and (pos, n) in rir:
                v = rir[(pos, n)]; s['rir'] = 0 if v == 'F' else v; s['failed'] = v == 'F'
            sets.append(s)
    d = dict(format=1, session_id=sid, revision=revision or len(sets) + 2, status=status, date=start.date().isoformat(),
             started_at=iso(start), workout_name=workout, comment=comment, setup_published_at=PUBLISHED, app_version='1.0.0')
    if status == 'closed': d['ended_at'] = iso(datetime.fromisoformat(ended).replace(tzinfo=TZ))
    if status == 'auto_closed': d['ended_at'] = iso(last)
    d['updated_at'] = d.get('ended_at', iso(last))
    if edits: d['updated_at'] = iso(last + timedelta(days=1))
    if status == 'deleted': d['sets'] = []; d['ended_at'] = iso(start + timedelta(minutes=30)); d['updated_at'] = iso(start + timedelta(hours=5))
    else: d['sets'] = sets
    path = os.path.join(HERE, 'sessions', d['date'][:4], f"{d['date']}_{sid}.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(d, open(path, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    return d

shutil.rmtree(os.path.join(HERE, 'sessions'), ignore_errors=True)
# S1 plain preset: machine, cable, assisted, bodyweight+time
session('s1', '2026-11-03T16:40:00', 'Test Upper', 'closed', [
  ('A01', [('A01', 40, 12, 3), ('A01', 40, 11, 6), ('A01', 40, 9, 9)]),
  ('B01', [('B01', 45, 12, 13), ('B01', 45, 11, 16), ('B01', 45, 10, 19)]),
  ('B03', [('B03', 25, 8, 23), ('B03', 25, 7, 26), ('B03', 25, 6, 29)]),
  ('D01', [('D01', 0, 50, 33), ('D01', 0, 45, 36), ('D01', 0, 40, 39)])], comment='Felt good today', ended='2026-11-03T17:22:10')
# S2 plain preset: kettlebell+time with weight, bodyweight reps with added weight
session('s2', '2026-11-05T07:05:00', 'Test Lower', 'closed', [
  ('C01', [('C01', 120, 15, 4), ('C01', 130, 12, 8), ('C01', 130, 11, 12)]),
  ('C02', [('C02', 28, 70, 17), ('C02', 28, 66, 21), ('C02', 28, 61, 25)]),
  ('D02', [('D02', 0, 20, 29), ('D02', 2.5, 16, 32)])], ended='2026-11-05T07:40:30')
# S3 swap mid-exercise (slot 2: set 1 as planned, sets 2-3 swapped), extra set on slot 1, added exercise (slot 5, no planned)
session('s3', '2026-11-07T16:42:00', 'Test Upper', 'closed', [
  ('A01', [('A01', 40, 12, 3), ('A01', 42.5, 10, 6), ('A01', 42.5, 9, 9), ('A01', 42.5, 8, 12)]),
  ('B01', [('B01', 45, 12, 16), ('B02', 35, 12, 20), ('B02', 35, 11, 23)]),
  ('B03', [('B03', 25, 8, 27), ('B03', 20, 6, 30), ('B03', 20, 6, 33)]),
  ('D01', [('D01', 2.5, 45, 37), ('D01', 2.5, 45, 40), ('D01', 2.5, 41, 43)]),
  (None,  [('D02', 0, 20, 46), ('D02', 0, 18, 48)])], comment='Cable row station busy', ended='2026-11-07T17:33:00',
  rir={(1, 3): 3, (1, 4): 1, (2, 3): 2, (3, 3): 5, (4, 3): 2})
# S4 free-form, auto-closed: dumbbell (each), barbell (plates only, 1.25 steps)
session('s4', '2026-11-08T10:10:00', '', 'auto_closed', [
  (None, [('A03', 14, 12, 4), ('A03', 14, 12, 7), ('A03', 16, 9, 10)]),
  (None, [('B04', 21.25, 10, 15), ('B04', 22.5, 10, 18)])], rir={(1, 3): 1})
# S5 corrected later: one set edited the next day, revision raised
session('s5', '2026-11-09T16:30:00', 'Test Lower', 'closed', [
  ('C01', [('C01', 130, 13, 4), ('C01', 130, 12, 8), ('C01', 130, 12, 12)]),
  ('C02', [('C02', 28, 75, 17), ('C02', 30, 58, 21), ('C02', 30, 55, 25)]),
  ('D02', [('D02', 2.5, 18, 29), ('D02', 2.5, 17, 32)])], comment='Carry moved up to 30', revision=14, ended='2026-11-09T17:05:45', edits={(2, 2)},
  rir={(1, 3): 'F', (2, 3): 0, (3, 2): 4})
# S6 deleted session: file kept, no sets
session('s6', '2026-11-10T06:50:00', 'Test Upper', 'deleted', [], revision=5)
# S7 still open (uploaded mid-session): must be left out of the history
session('s7', '2026-11-10T16:42:00', 'Test Upper', 'open', [
  ('A01', [('A01', 42.5, 10, 3), ('A01', 42.5, 10, 6)])])

# sample setup workbook matching setup.json (plain, unstyled: it is a test input)
wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Exercises'
ws.append(['ID', 'Exercise', 'Group', 'Type', 'Measure', 'Increment (kg)', 'Note', 'Active', 'Target Min', 'Target Max'])
for e in exercises: ws.append([e['id'], e['name'], e['group'], e['type'], e['measure'].capitalize(), e['increment_kg'], e['note'] or None, 'Y' if e['active'] else 'N', e.get('target_min'), e.get('target_max')])
ws = wb.create_sheet('Workouts'); ws.append(['Workout', 'Order', 'Exercise', 'Sets', 'Target Min', 'Target Max', 'Comment'])
for w in workouts:
    for it in w['items']: ws.append([w['name'], it['order'], BYID[it['exercise_id']]['name'], it['sets'], it['target_min'], it['target_max'], it['comment'] or None])
ws = wb.create_sheet('Lists'); ws.append(['Types', 'Measures', 'Groups'])
T = ['machine', 'cable', 'barbell', 'dumbbell', 'kettlebell', 'bodyweight', 'assisted']; M = ['Reps', 'Time']
for i in range(max(len(T), len(GROUPS))): ws.append([T[i] if i < len(T) else None, M[i] if i < len(M) else None, GROUPS[i] if i < len(GROUPS) else None])
wb.save(os.path.join(HERE, 'Gym Setup (sample).xlsx'))
print('fixtures written')
