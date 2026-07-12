# QGISで編集した破堤地点GeoPackageを、地図表示用のGeoJSONに変換する
# 使い方: python3 gpkg_to_breach_geojson.py
import json
import sqlite3
import struct
import sys
from pathlib import Path

BASE = Path(__file__).parent
INPUT = BASE / 'Toki_gawa_breach.gpkg'
OUTPUT = BASE / 'breach_typhoon2019_arakawa.geojson'
EVENT_NAME = '令和元年東日本台風（台風19号）'

# csv_to_geojson.py と同じ想定範囲チェック
LAT_RANGE = (34.0, 37.0)
LON_RANGE = (135.0, 141.0)


def parse_gpkg_point(blob):
  # GeoPackageバイナリヘッダ: magic(2) version(1) flags(1) srs_id(4) + envelope + WKB
  if blob[:2] != b'GP':
    raise ValueError('GeoPackageジオメトリではありません')
  flags = blob[3]
  envelope_sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
  offset = 8 + envelope_sizes[(flags >> 1) & 7]
  byte_order = '<' if blob[offset] == 1 else '>'
  geom_type = struct.unpack_from(byte_order + 'I', blob, offset + 1)[0]
  if geom_type != 1:
    raise ValueError(f'Point以外のジオメトリ: type={geom_type}')
  x, y = struct.unpack_from(byte_order + '2d', blob, offset + 5)
  return x, y


con = sqlite3.connect(f'file:{INPUT}?mode=ro', uri=True)
rows = con.execute(
  'SELECT fid, year, river, event, note, geometry FROM Toki_gawa_breach ORDER BY fid'
).fetchall()
con.close()

features = []
warnings = []
for i, (fid, year, river_bank, event, note, geom) in enumerate(rows):
  lon, lat = parse_gpkg_point(geom)
  if not (LAT_RANGE[0] <= lat <= LAT_RANGE[1]) or not (LON_RANGE[0] <= lon <= LON_RANGE[1]):
    warnings.append(f'  fid={fid}: {river_bank} {event} lat={lat} lon={lon}')
  bank = river_bank[-2:]
  river = river_bank[:-2]
  props = {
    'num': chr(0x2460 + i),  # ①②③…
    'text': f'{river_bank} {event}',
    'type': event,
    'river': river,
    'bank': bank,
    'color': '#FF0000' if event == '堤防決壊' else '#FFA500',
    'year': int(str(year).rstrip('年')),
    'event': EVENT_NAME,
    'note': note or '',
  }
  features.append({
    'type': 'Feature',
    'properties': props,
    'geometry': {'type': 'Point', 'coordinates': [round(lon, 6), round(lat, 6)]},
  })

# 既存ファイルと同じ「1地物1行」の形式で出力する（git diffを行単位で読めるようにするため）
lines = [
  '{',
  '"type": "FeatureCollection",',
  '"name": "typhoon2019_breach_WGS84",',
  '"crs": { "type": "name", "properties": { "name": "urn:ogc:def:crs:OGC:1.3:CRS84" } },',
  '"features": [',
]
body = [json.dumps(f, ensure_ascii=False, separators=(', ', ': ')) for f in features]
lines.append(',\n'.join(body))
lines += [']', '}', '']

OUTPUT.write_text('\n'.join(lines), encoding='utf-8')
print(f'{len(features)} 件を {OUTPUT.name} に出力しました')

if warnings:
  print(f'\n[警告] 座標が想定範囲外の地物が{len(warnings)}件あります:')
  print('\n'.join(warnings))
  sys.exit(1)
