#!/usr/bin/env python3
"""
令和元年東日本台風(2019年10月, 台風19号)の降水フレームを
京都大学生存圏研究所アーカイブの気象庁合成レーダーGPVから生成する。

データ出典: 気象庁 全国合成レーダーGPV
           (京都大学生存圏研究所 生存圏データベースにアーカイブ)
           http://database.rish.kyoto-u.ac.jp/arch/jmadata/synthetic-original.html

出力: 荒川流域bboxに切り出した降水強度PNG(10分間隔) + フレーム時刻一覧JSON
"""
import json
import os
import subprocess
import sys
import tarfile
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np
from PIL import Image

WGRIB2 = os.path.expanduser("~/.local/bin/wgrib2")
BASE_URL = "http://database.rish.kyoto-u.ac.jp/arch/jmadata/data/jma-radar/synthetic/original"

# 荒川流域を包含するbbox(東経/北緯)
BBOX_WEST, BBOX_EAST = 138.3, 140.2
BBOX_SOUTH, BBOX_NORTH = 35.6, 36.4

# イベント範囲(UTC)。台風接近開始(10/12 03:00 JST)〜破堤後(10/13 12:00 JST)を包含
EVENT_START = datetime(2019, 10, 11, 18, 0, tzinfo=timezone.utc)
EVENT_END = datetime(2019, 10, 13, 3, 0, tzinfo=timezone.utc)
STEP = timedelta(minutes=10)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
EVENT_DIR = os.path.join(SCRIPT_DIR, "events", "typhoon19_2019")
FRAMES_DIR = os.path.join(EVENT_DIR, "frames")
WORK_DIR = os.path.join(SCRIPT_DIR, ".work")

# JMA風の降水強度カラーテーブル(mm/h換算)。0mm/hは透明
COLOR_STOPS = [
    (0, (0, 0, 0, 0)),
    (1, (0x9B, 0xE1, 0xFF, 190)),
    (5, (0x4D, 0xA8, 0xFF, 205)),
    (10, (0x3D, 0x63, 0xFF, 215)),
    (20, (0xF5, 0xCB, 0x00, 220)),
    (30, (0xFF, 0x96, 0x00, 225)),
    (50, (0xFF, 0x32, 0x00, 230)),
    (80, (0xB4, 0x00, 0x68, 235)),
]


def colorize(mmh: np.ndarray) -> np.ndarray:
    h, w = mmh.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    for (lo, lo_c), (hi, _) in zip(COLOR_STOPS, COLOR_STOPS[1:]):
        rgba[(mmh >= lo) & (mmh < hi)] = lo_c
    rgba[mmh >= COLOR_STOPS[-1][0]] = COLOR_STOPS[-1][1]
    return rgba


def fetch_frame(dt: datetime) -> bool:
    os.makedirs(WORK_DIR, exist_ok=True)
    os.makedirs(FRAMES_DIR, exist_ok=True)
    ts = dt.strftime("%Y%m%d%H%M%S")
    out_png = os.path.join(FRAMES_DIR, f"{ts}.png")
    if os.path.exists(out_png):
        return True

    url = f"{BASE_URL}/{dt:%Y/%m/%d}/Z__C_RJTD_{ts}_RDR_JMAGPV__grib2.tar"
    tar_path = os.path.join(WORK_DIR, f"{ts}.tar")
    try:
        urllib.request.urlretrieve(url, tar_path)
    except Exception as e:
        print(f"[skip] {ts}: ダウンロード失敗 ({e})", file=sys.stderr)
        return False

    try:
        with tarfile.open(tar_path) as tf:
            member = next(
                m for m in tf.getmembers() if "Ggis1km_Prr10lv" in m.name
            )
            tf.extract(member, path=WORK_DIR)
            bin_src = os.path.join(WORK_DIR, member.name)
    except Exception as e:
        print(f"[skip] {ts}: tar展開失敗 ({e})", file=sys.stderr)
        os.remove(tar_path)
        return False

    clip_grb2 = os.path.join(WORK_DIR, f"{ts}_clip.grb2")
    clip_bin = os.path.join(WORK_DIR, f"{ts}_clip.bin")
    try:
        subprocess.run(
            [WGRIB2, bin_src, "-small_grib",
             f"{BBOX_WEST}:{BBOX_EAST}", f"{BBOX_SOUTH}:{BBOX_NORTH}", clip_grb2],
            check=True, capture_output=True,
        )
        subprocess.run(
            [WGRIB2, clip_grb2, "-order", "we:sn", "-no_header", "-bin", clip_bin],
            check=True, capture_output=True,
        )
        data = np.fromfile(clip_bin, dtype="<f4")
        # bboxサイズは固定(152 x 96)。異常データはスキップ
        if data.size != 152 * 96:
            print(f"[skip] {ts}: 想定外のグリッドサイズ ({data.size})", file=sys.stderr)
            return False
        grid = np.flipud(data.reshape(96, 152))
        mmh = grid * 6.0  # 10分積算(mm) → mm/h相当に換算
        img = Image.fromarray(colorize(mmh), mode="RGBA")
        os.makedirs(FRAMES_DIR, exist_ok=True)
        img.save(out_png)
        return True
    except subprocess.CalledProcessError as e:
        print(f"[skip] {ts}: wgrib2処理失敗 ({e.stderr[:200]})", file=sys.stderr)
        return False
    finally:
        for p in (tar_path, bin_src, clip_grb2, clip_bin):
            if os.path.exists(p):
                os.remove(p)


def main():
    os.makedirs(WORK_DIR, exist_ok=True)
    os.makedirs(FRAMES_DIR, exist_ok=True)

    frames = []
    dt = EVENT_START
    total = int((EVENT_END - EVENT_START) / STEP) + 1
    done = 0
    while dt <= EVENT_END:
        ok = fetch_frame(dt)
        done += 1
        if ok:
            frames.append({
                "time_utc": dt.strftime("%Y%m%dT%H%M%SZ"),
                "file": f"{dt.strftime('%Y%m%d%H%M%S')}.png",
            })
        print(f"[{done}/{total}] {dt.isoformat()} {'OK' if ok else 'FAILED'}", flush=True)
        dt += STEP

    meta = {
        "event": "typhoon19_2019",
        "label": "令和元年東日本台風(2019年10月)",
        "source": "気象庁 全国合成レーダーGPV(京都大学生存圏研究所アーカイブより加工)",
        "attribution": "©気象庁 気象業務支援センター（京都大学生存圏研究所アーカイブより取得・加工）",
        "bbox": {"west": BBOX_WEST, "east": BBOX_EAST, "south": BBOX_SOUTH, "north": BBOX_NORTH},
        "unit_note": "10分積算降水量(mm)を6倍してmm/h相当に換算し着色。JMA公式パレットの完全な再現ではなく近似",
        "frames": frames,
    }
    with open(os.path.join(EVENT_DIR, "frames.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print(f"完了: {len(frames)}/{total} フレーム生成")


if __name__ == "__main__":
    main()
