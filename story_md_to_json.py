#!/usr/bin/env python3
"""ストーリーテリング・シナリオMD → story JSON 変換スクリプト

Obsidianのシナリオ表（時刻|タイトル|本文|出典|中心位置緯度経度）を読み、
story/story_typhoon19.json を再生成する。

役割分担:
  - MD側がマスター: time_label / title / text / source / camera.center
  - JSON側から引き継ぎ: camera.zoom / camera.pitch / marker / layers / time_utc
    （タイトル→時刻ラベルの順で既存ステップと照合。演出調整値を上書きしないため）
  - MDに新規追加された行: zoom 13 / pitch 0 / breach は直前ステップを継承、
    time_utc は時刻ラベルから自動計算（降水フレーム範囲外は null）

使い方:
  python3 story_md_to_json.py            # デフォルトパスで変換
  python3 story_md_to_json.py <md> <json>
"""

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_MD = Path(
  "/Users/kenji/Documents/ObsidianVault_local/03_Research_paper"
  "/◆参考資料群/ストーリーテリング/ストーリーテリング.md"
)
DEFAULT_JSON = Path(__file__).parent / "story" / "story_typhoon19.json"

# 降水プレイバックのフレーム範囲（この外のイベントは time_utc = null）
FRAME_START = datetime(2019, 10, 11, 18, 0, tzinfo=timezone.utc)
FRAME_END = datetime(2019, 10, 13, 3, 0, tzinfo=timezone.utc)
JST = timezone(timedelta(hours=9))
EVENT_YEAR = 2019

# 荒川流域〜台風経路の想定範囲（csv_to_geojson.py と同趣旨の座標検証）
LAT_RANGE = (5.0, 50.0)
LON_RANGE = (120.0, 175.0)

# 新規ステップのデフォルト演出値
DEFAULT_ZOOM = 13
DEFAULT_PITCH = 0

URL_RE = re.compile(r"https?://\S+")
FLOAT_RE = re.compile(r"\d{1,3}\.\d+")


def clean_cell(raw, br_to=" ", br2_to=None):
  """MDセルからHTMLタグを除去し、<br> を指定文字に変換する

  br2_to を指定すると連続する <br>（段落区切り）だけを別の文字に変換する。
  """
  s = raw
  s = re.sub(r"<rt>.*?</rt>", "", s)
  s = re.sub(r"<rp>.*?</rp>", "", s)
  s = re.sub(r"</?ruby>", "", s)
  if br2_to is not None:
    s = re.sub(r"(<br\s*/?>\s*){2,}", br2_to, s)
  s = re.sub(r"(<br\s*/?>\s*)+", br_to, s)
  s = re.sub(r"</?[a-zA-Z][^>]*>", "", s)
  s = re.sub(r"[ \t]+", " ", s)
  return s.strip(" ／")


def normalize_title(title):
  """照合用にタイトルを正規化する（全角空白の揺れを吸収）"""
  return title.replace("　", " ").replace(" ", "")


def normalize_text(text):
  s = text.replace("㎥", "m³").replace("。 ", "。")
  if s and not s.endswith(("。", "！", "？", "）")):
    s += "。"
  return s


def parse_center(raw):
  """座標セルから (lon, lat) を取り出す。URL中の数値は除外する"""
  s = URL_RE.sub(" ", raw)
  nums = [float(m) for m in FLOAT_RE.findall(s)]
  if len(nums) < 2:
    raise ValueError(f"座標が読み取れません: {raw[:60]}")
  # 表記順が緯度・経度/経度・緯度で混在しているため、値の大小で判定する
  a, b = nums[0], nums[1]
  lon, lat = max(a, b), min(a, b)
  if not (LAT_RANGE[0] <= lat <= LAT_RANGE[1] and LON_RANGE[0] <= lon <= LON_RANGE[1]):
    raise ValueError(f"座標が想定範囲外です: lat={lat}, lon={lon}")
  return [lon, lat]


def parse_time_utc(time_label):
  """時刻ラベル(JST)から降水同期用のUTC時刻を計算する。範囲外・解析不能は None"""
  m = re.match(r"(\d{1,2})月(\d{1,2})日(\d{1,2})時(?:(\d{1,2})分)?", time_label)
  if not m:
    return None
  month, day, hour = int(m.group(1)), int(m.group(2)), int(m.group(3))
  minute = int(m.group(4) or 0)
  dt = datetime(EVENT_YEAR, month, day, hour, minute, tzinfo=JST).astimezone(timezone.utc)
  if not (FRAME_START <= dt <= FRAME_END):
    return None
  return dt.strftime("%Y%m%dT%H%M%SZ")


def parse_md_table(md_path):
  """シナリオ表の行を辞書リストで返す"""
  rows = []
  for line in md_path.read_text(encoding="utf-8").splitlines():
    if not line.lstrip().startswith("|"):
      continue
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    if len(cells) < 5:
      continue
    time_label = clean_cell(cells[0], br_to="")
    # ヘッダ行（重複含む）と区切り行を除外
    if time_label in ("", "時刻") or set(time_label) <= set("-: "):
      continue
    rows.append({
      "time_label": time_label,
      "title": clean_cell(cells[1], br_to="／"),
      "text": normalize_text(clean_cell(cells[2], br_to=" ")),
      "source": clean_cell(cells[3], br_to=" ", br2_to=" ／ "),
      "center": parse_center(cells[4]),
    })
  return rows


def build_step_index(steps):
  """既存ステップをタイトル・時刻ラベルで引けるようにする（同名は出現順に消費）"""
  by_title = {}
  by_label = {}
  for step in steps:
    by_title.setdefault(normalize_title(step["title"]), []).append(step)
    by_label.setdefault(step["time_label"], []).append(step)
  return by_title, by_label


def main():
  md_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_MD
  json_path = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_JSON

  story = json.loads(json_path.read_text(encoding="utf-8"))
  by_title, by_label = build_step_index(story["steps"])
  rows = parse_md_table(md_path)
  if not rows:
    sys.exit(f"エラー: シナリオ表が見つかりません: {md_path}")

  new_steps = []
  added = []
  consumed = set()
  prev_breach = False
  for row in rows:
    candidates = by_title.get(normalize_title(row["title"])) or by_label.get(row["time_label"])
    old = candidates.pop(0) if candidates else None

    if old:
      consumed.add(id(old))
      step = {**old}
      step["time_label"] = row["time_label"]
      step["title"] = row["title"]
      step["text"] = row["text"]
      step["source"] = row["source"]
      step["camera"] = {**old["camera"], "center": row["center"]}
    else:
      step = {
        "time_utc": parse_time_utc(row["time_label"]),
        "time_label": row["time_label"],
        "title": row["title"],
        "text": row["text"],
        "source": row["source"],
        "camera": {"center": row["center"], "zoom": DEFAULT_ZOOM, "pitch": DEFAULT_PITCH},
        "layers": {"breach": prev_breach},
      }
      added.append(row["title"])
    prev_breach = step.get("layers", {}).get("breach", prev_breach)
    new_steps.append(step)

  dropped = [s["title"] for s in story["steps"] if id(s) not in consumed]

  story["steps"] = new_steps
  json_path.write_text(
    json.dumps(story, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
  )

  print(f"変換完了: {len(new_steps)}ステップ → {json_path}")
  for t in added:
    print(f"  新規追加（zoom等はデフォルト値、要調整）: {t}")
  for t in dropped:
    print(f"  警告: MDに存在しないため削除: {t}")
  labels = [r["time_label"] for r in rows]
  for label in labels:
    if not re.match(r"\d{1,2}月\d{1,2}日", label):
      print(f"  警告: 時刻ラベルの書式が不正です: {label}")


if __name__ == "__main__":
  main()
