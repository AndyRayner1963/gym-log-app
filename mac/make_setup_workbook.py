#!/usr/bin/env python3
"""Generates the empty setup workbook: mac/templates/Gym Setup.xlsx (BRIEF.md section 4).

Headers, drop-downs and formatting only.  No exercises and no workouts: the Exercises sheet is Andy's alone.
Run:  python3 mac/make_setup_workbook.py [output path]
"""
import os
import sys

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Border, Font, PatternFill, Protection, Side
from openpyxl.utils import get_column_letter
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.datavalidation import DataValidation

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(HERE, "templates", "Gym Setup.xlsx")

FONT = "Lato"
VIOLET = "4B2C6B"
LAST = 500          # drop-downs and validation cover rows 2..LAST

TYPES = ["machine", "cable", "barbell", "dumbbell", "kettlebell", "bodyweight", "assisted"]
MEASURES = ["Reps", "Time"]

EXERCISES = [  # header, width, help text
    ("ID", 8, "A letter followed by a number, such as B03.  Unique.  Never change it and never reuse it, even if the exercise moves group."),
    ("Exercise", 34, "Name shown on the phone.  Unique.  You may rename it freely."),
    ("Group", 14, "Pick from the list.  Groups are kept on the Lists sheet."),
    ("Type", 14, "Pick from the list."),
    ("Measure", 11, "Reps or Time."),
    ("Increment (kg)", 13, "Step for the weight buttons.  Greater than zero, such as 2.5."),
    ("Note", 42, "Instruction note shown with the exercise.  May be blank."),
    ("Active", 9, "Y or N.  N hides the exercise on the phone; its history stays."),
    ("Target Min", 11, "Default target, in reps (seconds if Measure is Time), used where a workout sets no target.  May be blank."),
    ("Target Max", 11, "Default target, in reps (seconds if Measure is Time), used where a workout sets no target.  May be blank.  Not below Target Min."),
]
WORKOUTS = [
    ("Workout", 24, "Workout name.  Repeat it on each row of the workout."),
    ("Order", 8, "1, 2, 3 ...  Unique within the workout."),
    ("Exercise", 34, "Pick from the list of active exercises."),
    ("Sets", 8, "Planned sets: a whole number of 1 or more."),
    ("Target Min", 11, "Reps, or seconds if the exercise's Measure is Time.  May be blank."),
    ("Target Max", 11, "Reps, or seconds if the exercise's Measure is Time.  May be blank.  Not below Target Min."),
    ("Comment", 42, "Shown with the exercise in this workout.  May be blank."),
]
LISTS = [
    ("Types", 16, "Fixed.  The sheet is protected (no password) so these cannot be changed by accident."),
    ("Measures", 12, "Fixed."),
    ("Groups", 18, "Your groups, in the order you want them shown on the phone.  Type them here, from row 2."),
]


def style_header(ws, spec, height=30):
    side = Side(style="thin", color="808080")
    for c, (name, width, tip) in enumerate(spec, 1):
        cell = ws.cell(row=1, column=c, value=name)
        cell.font = Font(name=FONT, size=10, bold=True, color=VIOLET)
        cell.fill = PatternFill("solid", start_color="E2E6E4", end_color="E2E6E4")
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = Border(bottom=side, top=Side(style="medium", color=VIOLET))
        cell.comment = Comment(tip, "Gym setup", width=260, height=90)
        ws.column_dimensions[get_column_letter(c)].width = width
    ws.row_dimensions[1].height = height
    ws.freeze_panes = "A2"
    ws.sheet_view.zoomScale = 130
    ws.sheet_format.defaultRowHeight = 16
    ws.sheet_format.customHeight = True


def style_body(ws, ncols, rows, numeric_cols=(), text_cols=None):
    hair = Border(bottom=Side(style="hair", color="BFBFBF"))
    for r in range(2, rows + 1):
        for c in range(1, ncols + 1):
            cell = ws.cell(row=r, column=c)
            cell.font = Font(name=FONT, size=10, color="222222")
            cell.border = hair
            if c in numeric_cols:
                cell.alignment = Alignment(horizontal="right", vertical="center")
            else:
                cell.alignment = Alignment(horizontal="left", vertical="center", indent=1)


def add_list_validation(ws, col_letter, formula, title, prompt):
    dv = DataValidation(type="list", formula1=formula, allow_blank=True, showErrorMessage=True,
                        errorTitle=title, error="Please choose a value from the list.",
                        showInputMessage=False)
    dv.add("%s2:%s%d" % (col_letter, col_letter, LAST))
    ws.add_data_validation(dv)


def add_number_validation(ws, col_letter, kind, op, f1, title, msg):
    dv = DataValidation(type=kind, operator=op, formula1=f1, allow_blank=True, showErrorMessage=True,
                        errorTitle=title, error=msg)
    dv.add("%s2:%s%d" % (col_letter, col_letter, LAST))
    ws.add_data_validation(dv)


def build(path=DEFAULT_OUT):
    wb = Workbook()
    ws_ex = wb.active
    ws_ex.title = "Exercises"
    ws_wo = wb.create_sheet("Workouts")
    ws_li = wb.create_sheet("Lists")

    # Normal style: Lato 10, vertically centred (house style)
    normal = [s for s in wb._named_styles if s.name == "Normal"][0]
    normal.font = Font(name=FONT, size=10, color="222222")
    normal.alignment = Alignment(vertical="center")

    # Lists
    style_header(ws_li, LISTS, height=22)
    for i, t in enumerate(TYPES, 2):
        ws_li.cell(row=i, column=1, value=t)
    for i, m in enumerate(MEASURES, 2):
        ws_li.cell(row=i, column=2, value=m)
    style_body(ws_li, 3, 60)
    for r in range(2, 61):
        ws_li.cell(row=r, column=3).protection = Protection(locked=False)   # Groups stay editable
    ws_li.protection.sheet = True
    ws_li.protection.formatColumns = False
    ws_li.protection.formatRows = False

    # Named ranges that grow with the lists (OFFSET keeps blank rows out of the drop-downs)
    wb.defined_names["TypeList"] = DefinedName("TypeList", attr_text="OFFSET(Lists!$A$2,0,0,MAX(1,COUNTA(Lists!$A$2:$A$60)),1)")
    wb.defined_names["MeasureList"] = DefinedName("MeasureList", attr_text="OFFSET(Lists!$B$2,0,0,MAX(1,COUNTA(Lists!$B$2:$B$60)),1)")
    wb.defined_names["GroupList"] = DefinedName("GroupList", attr_text="OFFSET(Lists!$C$2,0,0,MAX(1,COUNTA(Lists!$C$2:$C$60)),1)")
    wb.defined_names["ExerciseList"] = DefinedName("ExerciseList", attr_text="OFFSET(Exercises!$B$2,0,0,MAX(1,COUNTA(Exercises!$B$2:$B$%d)),1)" % LAST)

    # Exercises
    style_header(ws_ex, EXERCISES)
    style_body(ws_ex, len(EXERCISES), LAST, numeric_cols=(6, 9, 10))
    add_list_validation(ws_ex, "C", "GroupList", "Group", "")
    add_list_validation(ws_ex, "D", "TypeList", "Type", "")
    add_list_validation(ws_ex, "E", "MeasureList", "Measure", "")
    add_list_validation(ws_ex, "H", '"Y,N"', "Active", "")
    add_number_validation(ws_ex, "F", "decimal", "greaterThan", "0", "Increment", "Enter a number greater than zero, such as 2.5.")
    add_number_validation(ws_ex, "I", "whole", "greaterThanOrEqual", "0", "Target", "Enter a whole number.")
    add_number_validation(ws_ex, "J", "whole", "greaterThanOrEqual", "0", "Target", "Enter a whole number.")

    # Workouts
    style_header(ws_wo, WORKOUTS)
    style_body(ws_wo, len(WORKOUTS), LAST, numeric_cols=(2, 4, 5, 6))
    add_list_validation(ws_wo, "C", "ExerciseList", "Exercise", "")
    add_number_validation(ws_wo, "B", "whole", "greaterThanOrEqual", "1", "Order", "Enter a whole number, 1 or more.")
    add_number_validation(ws_wo, "D", "whole", "greaterThanOrEqual", "1", "Sets", "Enter a whole number, 1 or more.")
    add_number_validation(ws_wo, "E", "whole", "greaterThanOrEqual", "0", "Target", "Enter a whole number.")
    add_number_validation(ws_wo, "F", "whole", "greaterThanOrEqual", "0", "Target", "Enter a whole number.")

    wb.properties.creator = "gymsync"
    wb.properties.title = "Gym Setup"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    wb.save(path)
    return path


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT
    print("Wrote", build(out))
