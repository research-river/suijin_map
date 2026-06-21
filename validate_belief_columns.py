#!/usr/bin/env python3
# 使用法: python validate_belief_columns.py
# flood_related / belief_function / belief_function_sub / relocated の表記揺れを検出する

import csv
import sys
from pathlib import Path

CSV_PATH = Path(__file__).parent / "monuments_suijin.csv"

TRI_STATE = {"", "yes", "no", "unclear"}

BELIEF_FUNCTIONS = {
    "",
    "disaster_flood",
    "accident_water",
    "gratitude_water",
    "irrigation",
    "fishing",
    "dragon_palace",
    "unclear",
}


def check_tri_state(value, column, row_label, errors):
    if value not in TRI_STATE:
        errors.append(f"{row_label}: {column} に不正な値 '{value}'（許容値: yes/no/unclear/空欄）")


def check_belief_function(value, row_label, errors):
    if value not in BELIEF_FUNCTIONS:
        errors.append(f"{row_label}: belief_function に不正な値 '{value}'")


def check_belief_function_sub(value, row_label, errors):
    # セミコロン区切りの複数タグ。各タグを belief_function と同じ値リストで検証する
    if not value:
        return
    for tag in value.split(";"):
        tag = tag.strip()
        if tag not in BELIEF_FUNCTIONS or tag == "":
            errors.append(f"{row_label}: belief_function_sub に不正なタグ '{tag}'")


def main():
    with open(CSV_PATH, encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))

    errors = []
    for i, row in enumerate(rows, start=2):  # ヘッダが1行目なのでデータは2行目から
        row_label = f"{i}行目「{row.get('name', '')}」"
        check_tri_state(row.get("flood_related", "").strip(), "flood_related", row_label, errors)
        check_belief_function(row.get("belief_function", "").strip(), row_label, errors)
        check_belief_function_sub(row.get("belief_function_sub", "").strip(), row_label, errors)
        check_tri_state(row.get("relocated", "").strip(), "relocated", row_label, errors)

    if errors:
        print(f"{len(errors)} 件の問題が見つかりました:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)

    print(f"OK: {len(rows)} 件すべて表記に問題ありません")


if __name__ == "__main__":
    main()
