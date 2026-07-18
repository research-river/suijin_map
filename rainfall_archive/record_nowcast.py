#!/usr/bin/env python3
"""
気象庁 高解像度降水ナウキャストをポーリングし、指定リージョン(既定: 広域
133-144E/31.5-40.2N)のbboxに切り出したPNGフレームをライブ録画する。
台風接近が予報された時点で手動起動する運用を想定(Raspberry Pi 4上でのtmux実行)。

企画書(proposal_live_nowcast_recorder.html)のアーキテクチャを簡略化し、
「生タイル保存→事後整形」の2段階を経ず、取得したXYZタイルをその場で
bboxに合成・切り出して build_typhoon19_frames.py と同じ frames.json 形式で
直接出力する。GRIB2デコードが不要な分、後処理を省略できるため。

使い方:
    python3 record_nowcast.py --event typhoon9_2026 --label "台風9号(2026年7月)"
    python3 record_nowcast.py --event rehearsal --once   # リハーサル用に1回だけ取得して終了
    python3 record_nowcast.py --event test --region arakawa --once   # 従来の荒川流域bboxで取得

出力:
    rainfall_archive/events/{event}/frames/{validtime}.png
    rainfall_archive/events/{event}/frames.json
"""
import argparse
import io
import json
import math
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from PIL import Image

NOWCAST_BASE_URL = "https://www.jma.go.jp/bosai/jmatile/data/nowc"

# 録画範囲プリセット(東経/北緯)
# wide の緯度南寄せは台風の北上を南から長時間追うため。z10 での画像寸法は
# 約8,011×7,822px で、WebGLテクスチャ安全上限(8,192px)の範囲内に収める
REGIONS = {
    # 荒川流域 - build_typhoon19_frames.py と同一
    "arakawa": {"west": 138.3, "east": 140.2, "south": 35.6, "north": 36.4},
    # 広域(屋久島沖〜青森県南部)
    "wide": {"west": 133.0, "east": 144.0, "south": 31.5, "north": 40.2},
}

TILE_SIZE = 256
# 気象庁配信タイルは偶数ズーム(4,6,8,10)のみ実データ。奇数ズームは空PNGを返す
DEFAULT_ZOOM = 10
# 気象庁サーバへの配慮として並列数は増やさない
FETCH_WORKERS = 4

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def lon_to_xpix(lon_deg: float, zoom: int) -> float:
    n = 2 ** zoom
    return (lon_deg + 180.0) / 360.0 * n * TILE_SIZE


def lat_to_ypix(lat_deg: float, zoom: int) -> float:
    lat_rad = math.radians(lat_deg)
    n = 2 ** zoom
    y = (1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n
    return y * TILE_SIZE


def bbox_pixel_bounds(bbox: dict, zoom: int):
    return {
        "left": lon_to_xpix(bbox["west"], zoom),
        "right": lon_to_xpix(bbox["east"], zoom),
        "top": lat_to_ypix(bbox["north"], zoom),
        "bottom": lat_to_ypix(bbox["south"], zoom),
    }


def fetch_tile(basetime: str, validtime: str, elem: str, zoom: int, x: int, y: int):
    url = f"{NOWCAST_BASE_URL}/{basetime}/none/{validtime}/surf/{elem}/{zoom}/{x}/{y}.png"
    # 一時的な通信失敗で歯抜けフレームにならないよう1回だけリトライする
    for attempt in range(2):
        try:
            with urllib.request.urlopen(url, timeout=10) as res:
                return Image.open(io.BytesIO(res.read())).convert("RGBA")
        except Exception as e:
            if attempt == 0:
                time.sleep(1)
            else:
                print(f"  [skip tile] z{zoom}/{x}/{y}: {e}", file=sys.stderr)
    return None


def build_frame_image(basetime: str, validtime: str, elem: str, bbox: dict, zoom: int) -> Image.Image:
    px = bbox_pixel_bounds(bbox, zoom)
    tx_min, tx_max = int(px["left"] // TILE_SIZE), int(px["right"] // TILE_SIZE)
    ty_min, ty_max = int(px["top"] // TILE_SIZE), int(px["bottom"] // TILE_SIZE)

    # タイル全面キャンバス→cropの2バッファ方式だと広域bboxでPiのRAMを圧迫するため、
    # 最終寸法のキャンバスに直接pasteする(はみ出しはPILがクリップする)
    left, top = round(px["left"]), round(px["top"])
    canvas = Image.new("RGBA", (round(px["right"]) - left, round(px["bottom"]) - top), (0, 0, 0, 0))

    coords = [
        (tx, ty)
        for ty in range(ty_min, ty_max + 1)
        for tx in range(tx_min, tx_max + 1)
    ]
    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        tiles = pool.map(
            lambda c: (c, fetch_tile(basetime, validtime, elem, zoom, c[0], c[1])),
            coords,
        )
        for (tx, ty), tile in tiles:
            if tile is not None:
                canvas.paste(tile, (tx * TILE_SIZE - left, ty * TILE_SIZE - top))
    return canvas


def load_meta(event_dir: str, event: str, label: str, bbox: dict) -> dict:
    meta_path = os.path.join(event_dir, "frames.json")
    if os.path.exists(meta_path):
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        # 途中から別リージョンで再開すると既存フレームと位置がずれるため中断する
        if meta.get("bbox") != bbox:
            sys.exit(f"エラー: 既存イベントのbbox {meta.get('bbox')} と指定リージョンが一致しません")
        return meta
    return {
        "event": event,
        "label": label,
        "source": "気象庁 高解像度降水ナウキャスト(要素: hrpns) ライブ録画",
        "attribution": "©気象庁",
        "bbox": dict(bbox),
        "unit_note": "気象庁配信のレンダリング済みタイルをそのままbbox切り出し。着色は気象庁公式パレットに準拠",
        "frames": [],
    }


def save_meta(event_dir: str, meta: dict) -> None:
    with open(os.path.join(event_dir, "frames.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)


def poll_once(event_dir: str, frames_dir: str, meta: dict, elem: str, bbox: dict, zoom: int) -> int:
    known_validtimes = {f["validtime_raw"] for f in meta["frames"]}
    try:
        with urllib.request.urlopen(f"{NOWCAST_BASE_URL}/targetTimes_N1.json", timeout=10) as res:
            targets = json.load(res)
    except Exception as e:
        print(f"[targetTimes取得失敗] {e}", file=sys.stderr)
        return 0

    new_targets = [
        t for t in targets
        if elem in (t.get("elements") or []) and t["validtime"] not in known_validtimes
    ]
    new_targets.sort(key=lambda t: t["validtime"])

    added = 0
    for t in new_targets:
        basetime, validtime = t["basetime"], t["validtime"]
        img = build_frame_image(basetime, validtime, elem, bbox, zoom)
        filename = f"{validtime}.png"
        img.save(os.path.join(frames_dir, filename), optimize=True)

        dt = datetime.strptime(validtime, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
        meta["frames"].append({
            "time_utc": dt.strftime("%Y%m%dT%H%M%SZ"),
            "file": filename,
            "validtime_raw": validtime,
        })
        added += 1
        print(f"  [録画] {validtime} -> {filename}")

    if added:
        meta["frames"].sort(key=lambda f: f["validtime_raw"])
        save_meta(event_dir, meta)
    return added


def main():
    parser = argparse.ArgumentParser(description="降水ナウキャスト ライブ録画")
    parser.add_argument("--event", required=True, help="イベントID(例: typhoon9_2026)")
    parser.add_argument("--label", default=None, help="表示ラベル(省略時はeventと同じ)")
    parser.add_argument("--interval", type=int, default=120, help="ポーリング間隔(秒、既定120)")
    parser.add_argument("--region", default="wide", choices=sorted(REGIONS), help="録画範囲プリセット(既定: wide)")
    parser.add_argument("--zoom", type=int, default=DEFAULT_ZOOM, choices=[4, 6, 8, 10], help="取得ズームレベル")
    parser.add_argument("--element", default="hrpns", help="要素コード(既定: hrpns=高解像度降水ナウキャスト)")
    parser.add_argument("--once", action="store_true", help="1回だけポーリングして終了(リハーサル用)")
    args = parser.parse_args()

    label = args.label or args.event
    bbox = REGIONS[args.region]
    event_dir = os.path.join(SCRIPT_DIR, "events", args.event)
    frames_dir = os.path.join(event_dir, "frames")
    os.makedirs(frames_dir, exist_ok=True)

    meta = load_meta(event_dir, args.event, label, bbox)
    print(f"録画開始: event={args.event} region={args.region} zoom={args.zoom} interval={args.interval}s")
    print(f"保存先: {event_dir}")

    try:
        while True:
            added = poll_once(event_dir, frames_dir, meta, args.element, bbox, args.zoom)
            if added == 0:
                print(f"[{datetime.now().strftime('%H:%M:%S')}] 新規フレームなし(既存 {len(meta['frames'])} 枚)")
            if args.once:
                break
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n中断されました。ここまでの録画データは保存済みです。")
    finally:
        save_meta(event_dir, meta)
        print(f"完了: {len(meta['frames'])} フレーム保存済み ({frames_dir})")


if __name__ == "__main__":
    main()
