// ---- プレイスカード ----

const placeCard      = document.getElementById("place-card");
const placePhoto     = document.getElementById("place-photo");
const placePhotoWrap = document.getElementById("place-photo-wrap");
const placeName      = document.getElementById("place-name");
const placeRows      = document.getElementById("place-rows");

function openPlaceCard(p) {
  placeCard.classList.remove("type-water", "type-dragon", "type-benten", "type-other");
  placeCard.classList.add(`type-${p.type}`);

  placeName.textContent = p.name;

  if (p.photo_filename) {
    placePhoto.src = `monumentphoto/medium_res/${p.photo_filename}`;
    placePhoto.alt = p.name;
    placePhotoWrap.style.display = "";
    placePhoto.onerror = () => { placePhotoWrap.style.display = "none"; };
    // 縦型写真（調査時点では未撮り直し）は cover だと上下が大きく切れるため、
    // 縮尺判定して全体が見える contain に切り替える。横型に差し替われば自動で通常表示に戻る
    placePhoto.onload = () => {
      placePhoto.classList.toggle("is-portrait", placePhoto.naturalHeight > placePhoto.naturalWidth);
    };
  } else {
    placePhotoWrap.style.display = "none";
  }

  const fields = [
    ["建立年", p.year],
    ["サイズ",   p.size],
    ["所在地",   p.address],
    ["座標",     p.coordinates_dd],
    ["銘文",     p.inscription],
    ["コメント", p.Condition_comment],
    ["保存状態", p.Condition_level],
    ["調査日",   p.Survey_date],
  ];

  placeRows.innerHTML = fields
    .filter(([, v]) => v)
    .map(([k, v]) => `<div class="place-row"><span class="place-key">${k}</span><span class="place-val">${v}</span></div>`)
    .join("");

  placeCard.classList.add("open");
  placeCard.setAttribute("aria-hidden", "false");
  document.body.classList.add("place-card-active");
}

function closePlaceCard() {
  document.activeElement?.blur();
  placeCard.classList.remove("open");
  placeCard.setAttribute("aria-hidden", "true");
  document.body.classList.remove("place-card-active");
}

document.getElementById("place-card-close").addEventListener("click", closePlaceCard);

function createMarkerEl(p) {
  const el = document.createElement("div");
  el.className = `marker marker-${p.type}`;
  return el;
}

// ---- 色別標高図 ----

// 荒川低地向けデフォルト色帯（0〜42m）
let elevBands = [
  { upper: 0,    color: "#cce1f0" },
  { upper: 3,    color: "#c8e6f0" },
  { upper: 5,    color: "#b2cff0" },
  { upper: 7,    color: "#d7f55d" },
  { upper: 14,   color: "#b5f03e" },
  { upper: 21,   color: "#5ae06c" },
  { upper: 24,   color: "#8ef07a" },
  { upper: 28,   color: "#33b81f" },
  { upper: 42,   color: "#f7cd9e" },
  { upper: null, color: "#ffea00" },
];
let elevTileRev = 0;
let elevationActive = false;

function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

// 標高値を色帯に当てはめてRGBを返す
function getElevColor(elev) {
  for (let i = elevBands.length - 1; i >= 0; i--) {
    const lower = i === 0 ? -Infinity : (elevBands[i - 1].upper ?? Infinity);
    if (elev >= lower) return hexToRgb(elevBands[i].color);
  }
  return hexToRgb(elevBands[0].color);
}

// PMTilesプロトコル登録（pmtiles.js が window.pmtiles をグローバルに提供）
const _pmtilesProtocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", _pmtilesProtocol.tile.bind(_pmtilesProtocol));

// DEMタイルをCanvas上でデコード・着色するカスタムプロトコル
maplibregl.addProtocol("colordem", async (params, abortController) => {
  const tileUrl = params.url.replace("colordem://", "https://").replace(/\?v=\d+$/, "");
  try {
    const resp = await fetch(tileUrl, { signal: abortController.signal, mode: "cors" });
    if (!resp.ok) return { data: new ArrayBuffer(0) };
    const img = await createImageBitmap(await resp.blob());
    const canvas = new OffscreenCanvas(256, 256);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const imgData = ctx.getImageData(0, 0, 256, 256);
    const d = imgData.data;
    for (let px = 0; px < d.length; px += 4) {
      const r = d[px], g = d[px + 1], b = d[px + 2];
      // nodata（R=128,G=0,B=0）は透明化
      if (r === 128 && g === 0 && b === 0) { d[px + 3] = 0; continue; }
      // GSI DEM PNGデコード: u値→標高(m)
      const u = (r << 16) + (g << 8) + b;
      const elev = u < 8388608 ? u * 0.01 : (u - 16777216) * 0.01;
      const [cr, cg, cb] = getElevColor(elev);
      d[px] = cr; d[px + 1] = cg; d[px + 2] = cb; d[px + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return { data: await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer() };
  } catch (e) {
    if (e.name === "AbortError") throw e;
    return { data: new ArrayBuffer(0) };
  }
});

function demTileUrl() {
  return `colordem://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png?v=${elevTileRev}`;
}

// 他の動的レイヤーより前に挿入するためのbeforeIdを取得
function getFirstDynamicLayerId() {
  const candidates = [
    ...Object.keys(RIVER_LAYERS).map((id) => `river-${id}`),
    ...Object.keys(RASTER_OVERLAYS).map((id) => `overlay-${id}`),
    ...Object.keys(BREACH_LAYERS).map((id) => `breach-${id}`),
  ];
  return candidates.find((id) => map.getLayer(id));
}

function elevOpacity() {
  return parseFloat(document.getElementById("elev-opacity")?.value ?? "0.85");
}

function addElevationLayer() {
  if (map.getSource("dem-colored")) return;
  map.addSource("dem-colored", { type: "raster", tiles: [demTileUrl()], tileSize: 256, maxzoom: 14 });
  const before = getFirstDynamicLayerId();
  map.addLayer(
    { id: "dem-color", type: "raster", source: "dem-colored", paint: { "raster-opacity": elevOpacity() } },
    before
  );
  if (document.getElementById("elev-chk-hillshade")?.checked) addElevHillshade(before);
}

function addElevHillshade(beforeId) {
  if (!map.getSource("dem-hillshade")) {
    map.addSource("dem-hillshade", {
      type: "raster",
      tiles: ["https://cyberjapandata.gsi.go.jp/xyz/hillshademap/{z}/{x}/{y}.png"],
      tileSize: 256, maxzoom: 16,
    });
  }
  if (!map.getLayer("dem-hillshade-layer")) {
    map.addLayer(
      { id: "dem-hillshade-layer", type: "raster", source: "dem-hillshade", paint: { "raster-opacity": 0.35 } },
      beforeId
    );
  }
}

function removeElevationLayer() {
  ["dem-hillshade-layer", "dem-color"].forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
  ["dem-hillshade", "dem-colored"].forEach((id) => { if (map.getSource(id)) map.removeSource(id); });
}

// 色変更後にタイルを強制再読み込み（ソース削除→再追加でキャッシュをバスト）
function reloadElevTiles() {
  elevTileRev++;
  if (map.getLayer("dem-hillshade-layer")) map.removeLayer("dem-hillshade-layer");
  if (map.getLayer("dem-color"))           map.removeLayer("dem-color");
  if (map.getSource("dem-colored"))        map.removeSource("dem-colored");
  const before = getFirstDynamicLayerId();
  map.addSource("dem-colored", { type: "raster", tiles: [demTileUrl()], tileSize: 256, maxzoom: 14 });
  map.addLayer(
    { id: "dem-color", type: "raster", source: "dem-colored", paint: { "raster-opacity": elevOpacity() } },
    before
  );
  if (document.getElementById("elev-chk-hillshade")?.checked) addElevHillshade(before);
}

// ---- 色別標高図 設定パネル UI ----

function renderElevBandsTable() {
  const tbody = document.getElementById("elev-bands-body");
  tbody.innerHTML = "";
  elevBands.forEach((b, i) => {
    const lower = i === 0 ? null : elevBands[i - 1].upper;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input class="elev-band-from" type="number" value="${lower ?? ""}"
          placeholder="─" ${lower === null ? "disabled" : ""} data-idx="${i}" style="width:38px"></td>
      <td class="elev-band-sep">─</td>
      <td><input class="elev-band-to" type="number" value="${b.upper ?? ""}"
          placeholder="─" ${b.upper === null ? "disabled" : ""} data-idx="${i}" style="width:38px"></td>
      <td><input class="elev-band-color" type="color" value="${b.color}" data-idx="${i}"></td>
      <td><button class="elev-band-del" data-idx="${i}" title="削除">−</button></td>
      <td><button class="elev-band-add" data-idx="${i}" title="下に追加">＋</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll(".elev-band-to").forEach((inp) => {
    inp.addEventListener("change", () => {
      const idx = +inp.dataset.idx;
      const val = inp.value === "" ? null : parseFloat(inp.value);
      elevBands[idx].upper = val;
      // 次の帯のfromは自動的に更新されるのでテーブル再描画
      renderElevBandsTable();
    });
  });

  tbody.querySelectorAll(".elev-band-color").forEach((inp) => {
    inp.addEventListener("input", () => {
      elevBands[+inp.dataset.idx].color = inp.value;
    });
  });

  tbody.querySelectorAll(".elev-band-del").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (elevBands.length <= 1) return;
      elevBands.splice(+btn.dataset.idx, 1);
      // 末尾帯のupperをnullに保証
      elevBands[elevBands.length - 1].upper = null;
      renderElevBandsTable();
    });
  });

  tbody.querySelectorAll(".elev-band-add").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = +btn.dataset.idx;
      const cur = elevBands[idx];
      const newUpper = cur.upper !== null ? cur.upper + 5 : null;
      // 挿入前に末尾帯を調整
      if (idx === elevBands.length - 1) {
        cur.upper = cur.upper !== null ? cur.upper : 50;
        elevBands.push({ upper: null, color: "#cccccc" });
      } else {
        elevBands.splice(idx + 1, 0, { upper: newUpper, color: "#cccccc" });
      }
      renderElevBandsTable();
    });
  });
}

// ---- 色別標高図 パネルのドラッグ ----
{
  const popup = document.getElementById("elevation-popup");
  const header = document.getElementById("elevation-popup-header");
  let dragging = false, ox = 0, oy = 0;

  header.addEventListener("mousedown", (e) => {
    dragging = true;
    const rect = popup.getBoundingClientRect();
    ox = e.clientX - rect.left;
    oy = e.clientY - rect.top;
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    popup.style.left = (e.clientX - ox) + "px";
    popup.style.top  = (e.clientY - oy) + "px";
    popup.style.right = "auto";
  });
  document.addEventListener("mouseup", () => { dragging = false; });
}

// ---- 九頭龍碑バッファ ----

const KUZURYU_BUFFERS = {
  "1000": { radius: 1000, fillColor: "rgba(229, 57, 53, 0.12)",  lineColor: "#e53935" },
  "2000": { radius: 2000, fillColor: "rgba(251, 140, 0, 0.10)",  lineColor: "#fb8c00" },
  "3000": { radius: 3000, fillColor: "rgba(21, 101, 192, 0.08)", lineColor: "#1565c0" },
};

const activeBuffers = new Set();

// Haversine近似で円ポリゴンを生成（緯度補正済み、steps=64で十分滑らか）
function makeCirclePolygon(lon, lat, radiusM, steps = 64) {
  const R = 6371000;
  const latRad = lat * Math.PI / 180;
  const dLat = (radiusM / R) * (180 / Math.PI);
  const dLon = dLat / Math.cos(latRad);
  const ring = Array.from({ length: steps + 1 }, (_, i) => {
    const a = (i / steps) * 2 * Math.PI;
    return [lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)];
  });
  return { type: "Polygon", coordinates: [ring] };
}

function getKuzuryuBufferGeoJSON(radiusM) {
  const features = monumentsData
    .filter((f) => f.properties.type === "dragon")
    .map((f) => ({
      type: "Feature",
      geometry: makeCirclePolygon(f.geometry.coordinates[0], f.geometry.coordinates[1], radiusM),
      properties: {},
    }));
  return { type: "FeatureCollection", features };
}

function addKuzuryuBuffer(radiusStr) {
  if (map.getSource(`kuzuryu-buf-${radiusStr}`)) return;
  const cfg = KUZURYU_BUFFERS[radiusStr];
  map.addSource(`kuzuryu-buf-${radiusStr}`, {
    type: "geojson",
    data: getKuzuryuBufferGeoJSON(cfg.radius),
  });
  map.addLayer({
    id: `kuzuryu-buf-fill-${radiusStr}`,
    type: "fill",
    source: `kuzuryu-buf-${radiusStr}`,
    paint: { "fill-color": cfg.fillColor },
  });
  map.addLayer({
    id: `kuzuryu-buf-line-${radiusStr}`,
    type: "line",
    source: `kuzuryu-buf-${radiusStr}`,
    paint: { "line-color": cfg.lineColor, "line-width": 1.5, "line-dasharray": [4, 2] },
  });
}

function removeKuzuryuBuffer(radiusStr) {
  [`kuzuryu-buf-fill-${radiusStr}`, `kuzuryu-buf-line-${radiusStr}`].forEach((id) => {
    if (map.getLayer(id)) map.removeLayer(id);
  });
  if (map.getSource(`kuzuryu-buf-${radiusStr}`)) map.removeSource(`kuzuryu-buf-${radiusStr}`);
}

function addActiveBuffers() {
  activeBuffers.forEach((r) => addKuzuryuBuffer(r));
}

// パルスアニメーションの付与・解除
function updateDragonPulse() {
  const anyActive = activeBuffers.size > 0;
  document.querySelectorAll(".marker-dragon").forEach((el) => {
    el.classList.toggle("pulse", anyActive);
  });
}

// ---- ベースマップ定義
const BASE_LAYERS = {
  vector:
    "https://gsi-cyberjapan.github.io/gsivectortile-mapbox-gl-js/std.json",
  aerial: {
    version: 8,
    sources: {
      base: {
        type: "raster",
        tiles: ["https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"],
        tileSize: 256,
        attribution:
          '<a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>',
      },
    },
    layers: [{ id: "base", type: "raster", source: "base" }],
  },
  rekichizu:
    "https://mierune.github.io/rekichizu-style/styles/street/style.json",
  pale: {
    version: 8,
    sources: {
      base: {
        type: "raster",
        tiles: ["https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution:
          '<a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>',
      },
    },
    layers: [{ id: "base", type: "raster", source: "base" }],
  },
  hillshade: {
    version: 8,
    sources: {
      base: {
        type: "raster",
        tiles: [
          "https://cyberjapandata.gsi.go.jp/xyz/hillshademap/{z}/{x}/{y}.png",
        ],
        tileSize: 256,
        attribution:
          '<a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>',
        maxzoom: 16,
      },
    },
    layers: [{ id: "base", type: "raster", source: "base" }],
  },
  jinsoku: {
    version: 8,
    sources: {
      base: {
        type: "raster",
        tiles: ["https://boiledorange73.sakura.ne.jp/ws/tile/Kanto_Rapid-900913/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "© 農研機構農業環境研究部門",
      },
    },
    layers: [{ id: "base", type: "raster", source: "base" }],
  },
  kjm_kanto: {
    version: 8,
    sources: {
      base: {
        type: "raster",
        tiles: ["https://ktgis.net/kjmapw/kjtilemap/kanto/00/{z}/{x}/{y}.png"],
        tileSize: 256,
        scheme: "tms",
        attribution: "今昔マップ on the web (C)谷　謙二",
      },
    },
    layers: [{ id: "base", type: "raster", source: "base" }],
  },
  kjm_tokyo50_2man: {
    version: 8,
    sources: {
      base: {
        type: "raster",
        tiles: ["https://ktgis.net/kjmapw/kjtilemap/tokyo50/2man/{z}/{x}/{y}.png"],
        tileSize: 256,
        scheme: "tms",
        bounds: [139.40, 35.25, 140.25, 35.88],
        attribution: "今昔マップ on the web (C)谷　謙二",
      },
    },
    layers: [{ id: "base", type: "raster", source: "base" }],
  },
  kjm_tokyo50: {
    version: 8,
    sources: {
      base: {
        type: "raster",
        tiles: ["https://ktgis.net/kjmapw/kjtilemap/tokyo50/00/{z}/{x}/{y}.png"],
        tileSize: 256,
        scheme: "tms",
        bounds: [139.40, 35.25, 140.25, 35.88],
        attribution: "今昔マップ on the web (C)谷　謙二",
      },
    },
    layers: [{ id: "base", type: "raster", source: "base" }],
  },
  // 治水地形分類図（zoom 11以上でタイル配信）
  hydro: {
    version: 8,
    sources: {
      base: {
        type: "raster",
        tiles: ["https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution:
          '<a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>',
      },
      lcmfc2: {
        type: "raster",
        tiles: ["https://cyberjapandata.gsi.go.jp/xyz/lcmfc2/{z}/{x}/{y}.png"],
        tileSize: 256,
        minzoom: 11,
        maxzoom: 16,
        attribution: "治水地形分類図 © 国土地理院",
      },
    },
    layers: [
      { id: "base", type: "raster", source: "base" },
      {
        id: "lcmfc2",
        type: "raster",
        source: "lcmfc2",
        paint: { "raster-opacity": 0.7 },
      },
    ],
  },
};

// 河川オーバーレイ定義
const RIVER_LAYERS = {
  current: {
    src: "river_path/arakawa/arakawa_current.geojson",
    color: "#2422d9",
    width: 6.5,
  },
  tributaries: {
    src: "river_path/arakawa/arakawa_tributaries.geojson",
    color: "#2422d9",
    width: 2.5,
  },
  pre: {
    src: "river_path/arakawa/arakawa_pre_diversion.geojson",
    color: "#f79137",
    width: 5.5,
    dasharray: [3, 1],
  },
  post: {
    src: "river_path/arakawa/arakawa_post_diversion.geojson",
    color: "#dd090b",
    width: 5.5,
    dasharray: [3, 1],
  },
  tonegawa: {
    src: "river_path/tonegawa/tonegawa_merged.geojson",
    color: "#1a6b9e",
    width: ["match", ["get", "W05_004"], "利根川", 6.5, 4],
  },
  tamagawa: {
    src: "river_path/tamagawa/tamagawa_merged.geojson",
    color: "#3a9a6b",
    width: ["match", ["get", "W05_004"], "多摩川", 6.5, 3.5],
  },
  sagamigawa: {
    src: "river_path/sagamigawa/sagamigawa_merged.geojson",
    color: "#9a703a",
    width: ["match", ["get", "W05_004"], "相模川", 6.5, 3],
  },
};

// 破堤箇所オーバーレイ定義
const BREACH_LAYERS = {
  typhoon2019_breach: {
    src: "breach/breach_typhoon2019_arakawa.geojson",
    hasPopup: true,
    color: ["get", "color"],
  },
  meiji43_breach: {
    src: "breach/breach_meiji43_arakawa.geojson",
    hasPopup: false,
    color: "#8B0000",
  },
};

const activeTypes = new Set(["water", "dragon", "benten"]);
const activeRivers = new Set();
const activeOverlays = new Set();
const activeBreach = new Set();
let currentBaseLayer = "pale";

// --- ナウキャスト状態 ---
const NOWCAST_BASE_URL = "https://www.jma.go.jp/bosai/jmatile/data/nowc";
let ncFrames       = [];
let ncCurrent      = 0;
let ncObsCount     = 0;
let ncTimer        = null;
let ncPlaying      = false;
let ncElement      = "hrpns";
let ncActive       = false;
let ncRefreshTimer = null;
// 世代番号: 更新時に新旧レイヤーを共存させ、新世代の読込完了後に旧世代を外すために使う。
// ncGeneration は採番カウンタ、ncDisplayGen は現在表示中の世代
let ncGeneration   = 0;
let ncDisplayGen   = 0;
// 静止表示中にタイル取得を許すフレーム範囲(現在±2枚)。
// 全24フレームを常時取得するとズームのたびにリクエストが殺到し、
// 表示中フレームのタイル到着が遅れて雨雲が途切れて見える
const NC_PREFETCH_WINDOW = 2;

// --- 過去イベント降水再生状態(事前生成PNGフレームを再生する。ライブナウキャストとは別レイヤ) ---
const PAST_EVENTS = {
  typhoon19_2019: {
    label: "令和元年東日本台風",
    metaUrl: "rainfall_archive/events/typhoon19_2019/frames.json",
    baseDir: "rainfall_archive/events/typhoon19_2019/frames/",
  },
};
let peActive  = false;
let peEventId = null;
let peFrames  = [];
let peCurrent = 0;
let peTimer   = null;
let pePlaying = false;
let peBbox    = null;
let peMeta    = null;

// フライアウト内 elevation-ctrl の参照
const elevCtrl = document.getElementById("elevation-ctrl");

// ---- キキクル（危険度分布）----
const KIKICULO_BASE_URL = "https://www.jma.go.jp/bosai/jmatile/data/risk";
let kikikuloBasetime  = "";
let kikikuloValidtime = "";
let kikikuloMember    = "immed0";

function kikikuloTileUrl(element) {
  return `jmaeven://${KIKICULO_BASE_URL.replace("https://", "")}/${kikikuloBasetime}/${kikikuloMember}/${kikikuloValidtime}/surf/${element}/{z}/{x}/{y}.png`;
}

// 気象庁タイル(ナウキャスト・キキクル)は偶数ズーム(4,6,8,10)のみ実データを配信し、
// 奇数ズーム(5,7,9)には全国共通の空PNG(334bytes)を200で返す。そのまま読むと
// 奇数タイルズームに当たるズーム帯で雨雲が消えるため、奇数ズームの要求は
// 偶数の親タイルの該当四半分を2倍拡大して合成する
maplibregl.addProtocol("jmaeven", async (params, abortController) => {
  const url = params.url.replace("jmaeven://", "https://");
  const [, z, x, y] = url.match(/\/(\d+)\/(\d+)\/(\d+)\.png$/).map(Number);
  const opts = { signal: abortController.signal };
  if (z % 2 === 0) {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`tile ${res.status}`);
    return { data: await res.arrayBuffer() };
  }
  const parentUrl = url.replace(/\/\d+\/\d+\/\d+\.png$/, `/${z - 1}/${x >> 1}/${y >> 1}.png`);
  const res = await fetch(parentUrl, opts);
  if (!res.ok) throw new Error(`tile ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  const canvas = new OffscreenCanvas(256, 256);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, (x % 2) * 128, (y % 2) * 128, 128, 128, 0, 0, 256, 256);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return { data: await blob.arrayBuffer() };
});

function updateKikikuloTimeDisplay(validtime) {
  const el = document.getElementById("kikiculo-time");
  if (!el || !validtime) return;
  // APIタイムスタンプはUTC → JST(+9h)に変換
  const utc = new Date(
    `${validtime.slice(0,4)}-${validtime.slice(4,6)}-${validtime.slice(6,8)}T` +
    `${validtime.slice(8,10)}:${validtime.slice(10,12)}:${validtime.slice(12,14)}Z`
  );
  const jst = new Date(utc.getTime() + 9 * 3600 * 1000);
  el.textContent = `${String(jst.getUTCHours()).padStart(2,"0")}:${String(jst.getUTCMinutes()).padStart(2,"0")} JST`;
  updateHazardSummary();
}

async function fetchKikikuloTimestamp() {
  try {
    const data = await fetch(`${KIKICULO_BASE_URL}/targetTimes.json`).then((r) => r.json());
    const latest = data[0];
    kikikuloBasetime  = latest.basetime;
    kikikuloValidtime = latest.validtime;
    kikikuloMember    = latest.member ?? "immed0";
    updateKikikuloTimeDisplay(latest.validtime);
  } catch (e) {
    console.warn("キキクル タイムスタンプ取得失敗", e);
  }
}

// ラスタオーバーレイ定義
const RASTER_OVERLAYS = {
  typhoon2019: {
    tiles: ["https://cyberjapandata.gsi.go.jp/xyz/20191012typhoon19_tokigawa_1013do/{z}/{x}/{y}.png"],
    tileSize: 256,
  },
  // minzoom/maxzoomは降水ナウキャストと同じ気象庁配信仕様(z4-10)に合わせる。
  // 未指定だとMapLibreがz10超でも実タイルを取得しに行ってしまい、
  // z10タイルの拡大表示(オーバーズーム)にならず層が消えて見える。
  // fadeDuration: 0 はナウキャストと同じくズーム境界のクロスフェード点滅対策
  get kikiculo_land() {
    return { tiles: [kikikuloTileUrl("land")], tileSize: 256, minzoom: 4, maxzoom: 10, fadeDuration: 0 };
  },
  get kikiculo_flood() {
    return { tiles: [kikikuloTileUrl("designated_river")], tileSize: 256, minzoom: 4, maxzoom: 10, fadeDuration: 0 };
  },
  // 六角川など国(国土交通省地方整備局)管理の指定河川は designated_river ではなく
  // designated_river_nation 側にのみ描画される。UI上は「指定河川洪水」1トグルに
  // 統合するため、kikiculo_flood と常にペアでON/OFFする内部用オーバーレイとして保持する
  get kikiculo_flood_nation() {
    return { tiles: [kikikuloTileUrl("designated_river_nation")], tileSize: 256, minzoom: 4, maxzoom: 10, fadeDuration: 0 };
  },
};
let monumentsData = [];
let markers = [];

// 石碑種別ごとの件数バッジ（表示タブ）と記述統計（分析タブ）を更新
function updateMonumentStats() {
  const counts = { water: 0, dragon: 0, benten: 0, other: 0 };
  let oldestYear = null;
  monumentsData.forEach(({ properties: p }) => {
    if (p.type in counts) counts[p.type]++;
    const m = String(p.year ?? "").match(/(\d{3,4})/);
    if (m) {
      const y = parseInt(m[1]);
      if (oldestYear === null || y < oldestYear) oldestYear = y;
    }
  });

  Object.entries(counts).forEach(([type, n]) => {
    const el = document.querySelector(`.meta[data-count-for="${type}"]`);
    if (el) el.textContent = `${n}基`;
  });

  const total = monumentsData.length;
  const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  setText("stat-total", `${total}基`);
  setText("stat-water", `${counts.water}基`);
  setText("stat-dragon", `${counts.dragon}基`);
  setText("stat-benten", `${counts.benten}基`);
  setText("stat-other", `${counts.other}基`);
  setText("stat-oldest", oldestYear !== null ? `${oldestYear}年` : "不明");

  const statsRow = document.querySelector('.acc-row[data-key="stats"]');
  if (statsRow) statsRow.querySelector(".acc-summary").textContent = `石碑総数 ${total}基`;
}

// 石碑種別 凡例（左下）: 表示中の種別のみ行を出す。1種別も表示が無ければ凡例自体を隠す
const monumentLegend = document.getElementById("monument-legend");
function updateMonumentLegend() {
  monumentLegend.querySelectorAll(".legend-row").forEach((row) => {
    row.hidden = !activeTypes.has(row.dataset.legendType);
  });
  monumentLegend.classList.toggle("hidden", activeTypes.size === 0);
}

function clearMarkers() {
  markers.forEach((m) => m.remove());
  markers = [];
}

function addMarkers() {
  clearMarkers();
  updateMonumentLegend();
  monumentsData
    .filter(({ properties: p }) => activeTypes.has(p.type))
    .forEach(({ geometry, properties: p }) => {
      const el = createMarkerEl(p);
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat(geometry.coordinates)
        .addTo(map);
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        openPlaceCard(p);
      });
      markers.push(marker);
    });
  updateDragonPulse();
}

function addRiverLayer(id) {
  const cfg = RIVER_LAYERS[id];
  map.addSource(`river-${id}`, { type: "geojson", data: cfg.src });
  const paint = { "line-color": cfg.color, "line-width": cfg.width };
  if (cfg.dasharray) paint["line-dasharray"] = cfg.dasharray;
  map.addLayer({
    id: `river-${id}`,
    type: "line",
    source: `river-${id}`,
    paint,
  });
}

function removeRiverLayer(id) {
  if (map.getLayer(`river-${id}`)) map.removeLayer(`river-${id}`);
  if (map.getSource(`river-${id}`)) map.removeSource(`river-${id}`);
}

function addRiverLayers() {
  activeRivers.forEach((id) => addRiverLayer(id));
}

function addRasterOverlay(id) {
  const cfg = RASTER_OVERLAYS[id];
  map.addSource(`overlay-${id}`, {
    type: "raster",
    tiles: cfg.tiles,
    tileSize: cfg.tileSize,
    minzoom: cfg.minzoom,
    maxzoom: cfg.maxzoom,
  });
  const paint = {};
  if (cfg.fadeDuration !== undefined) paint["raster-fade-duration"] = cfg.fadeDuration;
  map.addLayer({ id: `overlay-${id}`, type: "raster", source: `overlay-${id}`, paint });
}

function removeRasterOverlay(id) {
  if (map.getLayer(`overlay-${id}`)) map.removeLayer(`overlay-${id}`);
  if (map.getSource(`overlay-${id}`)) map.removeSource(`overlay-${id}`);
}

function addRasterOverlays() {
  activeOverlays.forEach((id) => addRasterOverlay(id));
}

async function refreshKikikuloLayers() {
  const prevBasetime  = kikikuloBasetime;
  const prevValidtime = kikikuloValidtime;
  await fetchKikikuloTimestamp();
  if (kikikuloBasetime === prevBasetime && kikikuloValidtime === prevValidtime) return;
  ["kikiculo_land", "kikiculo_flood", "kikiculo_flood_nation"].forEach((id) => {
    if (activeOverlays.has(id)) {
      removeRasterOverlay(id);
      addRasterOverlay(id);
    }
  });
}

// ---- 降水ナウキャスト ----

function ncTileUrl(f, elem) {
  return `jmaeven://${NOWCAST_BASE_URL.replace("https://", "")}/${f.basetime}/none/${f.validtime}/surf/${elem}/{z}/{x}/{y}.png`;
}

function ncToJST(ts) {
  const dt = new Date(
    `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10)}:${ts.slice(10, 12)}:00Z`
  );
  return dt.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit",
    hour12: false,
  }) + " JST";
}

async function ncFetchFrames(elem) {
  const [n1, n2] = await Promise.all([
    fetch(`${NOWCAST_BASE_URL}/targetTimes_N1.json`).then((r) => r.json()),
    fetch(`${NOWCAST_BASE_URL}/targetTimes_N2.json`).then((r) => r.json()),
  ]);
  const obs = n1
    .filter((t) => (t.elements || []).includes(elem))
    .slice(0, 12)
    .reverse()
    .map((t) => ({ basetime: t.basetime, validtime: t.validtime, type: "obs" }));
  const fcst = n2
    .filter((t) => (t.elements || []).includes(elem))
    .sort((a, b) => a.validtime.localeCompare(b.validtime))
    .slice(0, 12)
    .map((t) => ({ basetime: t.basetime, validtime: t.validtime, type: "fcst" }));
  return { obs, fcst };
}

function ncSrcId(gen, i)   { return `nc-src-g${gen}-${i}`; }
function ncLayerId(gen, i) { return `nc-layer-g${gen}-${i}`; }

function ncClearLayers(gen) {
  (map.getStyle().layers ?? [])
    .filter((l) => l.id.startsWith(`nc-layer-g${gen}-`))
    .forEach((l) => map.removeLayer(l.id));
  Object.keys(map.getStyle().sources ?? {})
    .filter((id) => id.startsWith(`nc-src-g${gen}-`))
    .forEach((id) => map.removeSource(id));
}

function ncAddLayers(frames, elem, gen) {
  frames.forEach((f, i) => {
    map.addSource(ncSrcId(gen, i), {
      type: "raster",
      tiles: [ncTileUrl(f, elem)],
      tileSize: 256,
      minzoom: 4,
      maxzoom: 10,
    });
    map.addLayer({
      id: ncLayerId(gen, i),
      type: "raster",
      source: ncSrcId(gen, i),
      paint: {
        "raster-opacity": 0,
        // 既定の約300msクロスフェードがズーム境界で点滅の谷間を作るため無効化
        "raster-fade-duration": 0,
      },
    });
  });
}

// visibility: none はタイル取得ごと止まる(opacity: 0 は取得が走る)点を利用し、
// 再生中は全フレーム、静止中は現在±NC_PREFETCH_WINDOW 枚だけ取得を許す
function ncUpdateVisibility(gen = ncDisplayGen, center = ncCurrent, count = ncFrames.length) {
  for (let i = 0; i < count; i++) {
    const id = ncLayerId(gen, i);
    if (!map.getLayer(id)) continue;
    const visible = ncPlaying || Math.abs(i - center) <= NC_PREFETCH_WINDOW;
    map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  }
}

function ncShowFrame(index) {
  if (!ncFrames.length) return;
  const prev = ncCurrent;
  ncCurrent = Math.max(0, Math.min(index, ncFrames.length - 1));

  if (map.getLayer(ncLayerId(ncDisplayGen, prev)))
    map.setPaintProperty(ncLayerId(ncDisplayGen, prev), "raster-opacity", 0);

  const f = ncFrames[ncCurrent];
  const opacity = f.type === "fcst" ? 0.55 : 0.78;
  if (map.getLayer(ncLayerId(ncDisplayGen, ncCurrent)))
    map.setPaintProperty(ncLayerId(ncDisplayGen, ncCurrent), "raster-opacity", opacity);

  const labelEl  = document.getElementById("nc-time-label");
  const badgeEl  = document.getElementById("nc-badge");
  const sliderEl = document.getElementById("nc-slider");
  if (labelEl) labelEl.textContent = ncToJST(f.validtime);
  if (badgeEl) {
    badgeEl.textContent = f.type === "fcst" ? "予測" : "観測";
    badgeEl.className   = f.type === "fcst" ? "nc-badge nc-fcst" : "nc-badge nc-obs";
  }
  if (sliderEl) { sliderEl.max = ncFrames.length - 1; sliderEl.value = ncCurrent; }
  ncUpdateVisibility();
}

function ncPlay() {
  ncPlaying = true;
  // 再生中は全フレームのタイル取得を許可(先読み)して切替を滑らかにする
  ncUpdateVisibility();
  const btn = document.getElementById("nc-btn-play");
  if (btn) btn.textContent = "⏸ 停止";
  const ms = parseInt(document.getElementById("nc-speed")?.value ?? "500");
  ncTimer = setInterval(() => ncShowFrame((ncCurrent + 1) % ncFrames.length), ms);
}

function ncStop() {
  ncPlaying = false;
  clearInterval(ncTimer);
  ncTimer = null;
  ncUpdateVisibility();
  const btn = document.getElementById("nc-btn-play");
  if (btn) btn.textContent = "▶ 再生";
}

function ncWaitSourceLoaded(srcId) {
  return new Promise((resolve) => {
    if (map.getSource(srcId) && map.isSourceLoaded(srcId)) return resolve();
    const finish = () => {
      map.off("sourcedata", onData);
      clearTimeout(timer);
      resolve();
    };
    const onData = (e) => {
      if (e.sourceId === srcId && map.isSourceLoaded(srcId)) finish();
    };
    map.on("sourcedata", onData);
    // タイル欠落などで完了イベントが来ない場合の保険
    const timer = setTimeout(finish, 8000);
  });
}

// 新世代のレイヤーを裏で読み込み、完了後に表示を切替えてから旧世代を外す。
// 全削除→再構築だとタイル再取得完了までレーダーが消えるため、この順序が肝
async function ncRefreshFrames({ resetToLatestObs = false } = {}) {
  const { obs, fcst } = await ncFetchFrames(ncElement);
  const newFrames = [...obs, ...fcst];
  ncGeneration += 1;
  const gen = ncGeneration;
  ncAddLayers(newFrames, ncElement, gen);

  const nextCurrent = resetToLatestObs
    ? obs.length - 1
    : Math.min(ncCurrent, newFrames.length - 1);
  ncUpdateVisibility(gen, nextCurrent, newFrames.length);
  await ncWaitSourceLoaded(ncSrcId(gen, nextCurrent));

  // 読込待ちの間にベースマップが切替わるとレイヤーごと消えているので入れ直す
  if (!map.getLayer(ncLayerId(gen, nextCurrent))) ncAddLayers(newFrames, ncElement, gen);

  const oldGen = ncDisplayGen;
  ncDisplayGen = gen;
  ncFrames   = newFrames;
  ncObsCount = obs.length;
  ncCurrent  = nextCurrent;
  // 読込待ちの間にOFFへ切替えられた場合は透明のまま保持する(次回ONで表示)
  if (ncActive) ncShowFrame(ncCurrent);
  if (oldGen !== gen) ncClearLayers(oldGen);
}

async function ncInitialize() {
  const loadingEl = document.getElementById("nc-loading");
  if (loadingEl) loadingEl.hidden = false;
  try {
    await ncRefreshFrames({ resetToLatestObs: true });
  } catch (e) {
    console.warn("ナウキャスト初期化失敗", e);
  }
  if (loadingEl) loadingEl.hidden = true;
}

function ncRestoreLayers() {
  // ベースマップ変更後: 古いレイヤは既に消えているので直接追加
  ncAddLayers(ncFrames, ncElement, ncDisplayGen);
  ncShowFrame(ncCurrent);
}

async function ncEnable() {
  ncActive = true;
  document.getElementById("nowcast-ctrl").hidden = false;
  if (ncFrames.length === 0) {
    await ncInitialize();
  } else {
    ncShowFrame(ncCurrent);
  }
  updateAttribution();
  updateHazardSummary();
  if (!ncRefreshTimer) {
    ncRefreshTimer = setInterval(async () => {
      if (!ncActive) return;
      const wasPlaying = ncPlaying;
      ncStop();
      try {
        await ncRefreshFrames();
      } catch (e) {
        console.warn("[ncAutoRefresh]", e);
      }
      if (wasPlaying) ncPlay();
    }, 5 * 60 * 1000);
  }
}

function ncDisable() {
  ncActive = false;
  ncStop();
  // OFF中はタイル取得も止める(ONに戻すと ncShowFrame 経由で先読み窓が復元される)
  ncFrames.forEach((_, i) => {
    const id = ncLayerId(ncDisplayGen, i);
    if (!map.getLayer(id)) return;
    map.setPaintProperty(id, "raster-opacity", 0);
    map.setLayoutProperty(id, "visibility", "none");
  });
  document.getElementById("nowcast-ctrl").hidden = true;
  updateAttribution();
  updateHazardSummary();
}

// ---- 過去イベント降水再生 ----
// ライブナウキャストの多フレーム・ラスタタイル方式と異なり、
// 事前生成した1枚のPNG(荒川流域bbox切り出し)を image ソースとして
// フレームごとに差し替える。タイル取得が発生しないため軽量

function peToJST(utcTs) {
  // frames.json の time_utc は "YYYYMMDDTHHMMSSZ" 形式
  const dt = new Date(
    `${utcTs.slice(0, 4)}-${utcTs.slice(4, 6)}-${utcTs.slice(6, 8)}T${utcTs.slice(9, 11)}:${utcTs.slice(11, 13)}:00Z`
  );
  return dt.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit",
    hour12: false,
  }) + " JST";
}

async function peFetchFrames(eventId) {
  const cfg = PAST_EVENTS[eventId];
  return fetch(cfg.metaUrl).then((r) => r.json());
}

function peImageCoords(bbox) {
  // MapLibre image source の座標順: 左上→右上→右下→左下([lng, lat])
  return [
    [bbox.west, bbox.north],
    [bbox.east, bbox.north],
    [bbox.east, bbox.south],
    [bbox.west, bbox.south],
  ];
}

function peAddLayer() {
  const cfg = PAST_EVENTS[peEventId];
  const url = cfg.baseDir + peFrames[peCurrent].file;
  if (map.getSource("pe-img-src")) {
    map.getSource("pe-img-src").updateImage({ url });
    return;
  }
  map.addSource("pe-img-src", {
    type: "image",
    url,
    coordinates: peImageCoords(peBbox),
  });
  map.addLayer({
    id: "pe-img-layer",
    type: "raster",
    source: "pe-img-src",
    paint: { "raster-opacity": 0.75, "raster-fade-duration": 0 },
  });
}

function peShowFrame(index) {
  if (!peFrames.length) return;
  peCurrent = Math.max(0, Math.min(index, peFrames.length - 1));
  peAddLayer();

  const f = peFrames[peCurrent];
  const labelEl  = document.getElementById("nc-time-label");
  const badgeEl  = document.getElementById("nc-badge");
  const sliderEl = document.getElementById("nc-slider");
  if (labelEl) labelEl.textContent = peToJST(f.time_utc);
  if (badgeEl) {
    badgeEl.textContent = "過去";
    badgeEl.className   = "nc-badge nc-past";
  }
  if (sliderEl) { sliderEl.max = peFrames.length - 1; sliderEl.value = peCurrent; }
}

function pePlay() {
  pePlaying = true;
  const btn = document.getElementById("nc-btn-play");
  if (btn) btn.textContent = "⏸ 停止";
  const ms = parseInt(document.getElementById("nc-speed")?.value ?? "500");
  peTimer = setInterval(() => peShowFrame((peCurrent + 1) % peFrames.length), ms);
}

function peStop() {
  pePlaying = false;
  clearInterval(peTimer);
  peTimer = null;
  const btn = document.getElementById("nc-btn-play");
  if (btn) btn.textContent = "▶ 再生";
}

function peRemoveLayer() {
  if (map.getLayer("pe-img-layer")) map.removeLayer("pe-img-layer");
  if (map.getSource("pe-img-src")) map.removeSource("pe-img-src");
}

function peRestoreLayer() {
  // ベースマップ変更後: 古いレイヤは既に消えているので直接追加
  peAddLayer();
}

function peUpdateTickLabels() {
  const startEl = document.getElementById("nc-tick-start");
  const midEl   = document.getElementById("nc-tick-mid");
  const endEl   = document.getElementById("nc-tick-end");
  if (peActive && peFrames.length) {
    if (startEl) startEl.textContent = peToJST(peFrames[0].time_utc);
    if (midEl)   midEl.textContent   = PAST_EVENTS[peEventId].label;
    if (endEl)   endEl.textContent   = peToJST(peFrames[peFrames.length - 1].time_utc);
  } else {
    if (startEl) startEl.textContent = "−60分";
    if (midEl)   midEl.textContent   = "現在";
    if (endEl)   endEl.textContent   = "+60分";
  }
}

async function peEnable(eventId) {
  // ライブナウキャストは停止するが、フレームは保持して復帰に備える(タイル再取得を避ける)
  if (ncActive) {
    ncStop();
    ncFrames.forEach((_, i) => {
      const id = ncLayerId(ncDisplayGen, i);
      if (map.getLayer(id)) map.setPaintProperty(id, "raster-opacity", 0);
    });
  }

  peActive  = true;
  peEventId = eventId;
  document.getElementById("nowcast-toggle").checked = true;
  document.getElementById("nowcast-ctrl").hidden = false;
  const elementSelect = document.getElementById("nc-element");
  if (elementSelect) elementSelect.hidden = true;

  const loadingEl = document.getElementById("nc-loading");
  if (loadingEl) loadingEl.hidden = false;
  try {
    peMeta    = await peFetchFrames(eventId);
    peBbox    = peMeta.bbox;
    peFrames  = peMeta.frames;
    peCurrent = 0;
    peShowFrame(0);
    peUpdateTickLabels();
  } catch (e) {
    console.warn("過去イベント読込失敗", e);
  }
  if (loadingEl) loadingEl.hidden = true;
  updateAttribution();
}

function peDisable() {
  peActive = false;
  peStop();
  peRemoveLayer();
  const elementSelect = document.getElementById("nc-element");
  if (elementSelect) elementSelect.hidden = false;
  peUpdateTickLabels();
  updateAttribution();

  // ライブナウキャストへ復帰(既存フレームがあれば再取得せず即表示)
  if (ncActive && ncFrames.length > 0) ncShowFrame(ncCurrent);
}

function addBreachLayer(id) {
  const cfg = BREACH_LAYERS[id];
  map.addSource(`breach-${id}`, { type: "geojson", data: cfg.src });
  map.addLayer({
    id: `breach-${id}`,
    type: "symbol",
    source: `breach-${id}`,
    layout: {
      "text-field": "✕",
      "text-size": 38,
      "text-allow-overlap": true,
    },
    paint: {
      "text-color": cfg.color,
      "text-halo-color": "#fff",
      "text-halo-width": 2,
    },
  });
}

function removeBreachLayer(id) {
  if (map.getLayer(`breach-${id}`)) map.removeLayer(`breach-${id}`);
  if (map.getSource(`breach-${id}`)) map.removeSource(`breach-${id}`);
}

function addBreachLayers() {
  activeBreach.forEach((id) => addBreachLayer(id));
}

// --- キキクル 凡例（設定カード内）---
const kikiLegendCtrl   = document.getElementById("kikiculo-legend-ctrl");
const kikiLegendBody   = document.getElementById("kikiculo-legend-body");
const kikiLegendToggle = document.getElementById("kikiculo-legend-toggle");

document.getElementById("kikiculo-legend-header").addEventListener("click", () => {
  const isOpen = kikiLegendBody.classList.toggle("open");
  kikiLegendToggle.textContent = isOpen ? "▲" : "▼";
});

function updateKikikuloLegendVisibility() {
  const kikiActive = ["kikiculo_land", "kikiculo_flood", "kikiculo_flood_nation"]
    .some((id) => activeOverlays.has(id));
  kikiLegendCtrl.hidden = !kikiActive;
  // キキクル有効化時に凡例を自動展開
  if (kikiActive && !kikiLegendBody.classList.contains("open")) {
    kikiLegendBody.classList.add("open");
    kikiLegendToggle.textContent = "▲";
  }
  updateHazardSummary();
}

// ハザード情報アコーディオンのサマリを動的更新（タイムスタンプ常時可視化）
function updateHazardSummary() {
  const row = document.querySelector('.acc-row[data-key="hazard"]');
  if (!row) return;
  const summaryEl = row.querySelector(".acc-summary");
  if (!summaryEl) return;

  const parts = [];
  if (activeOverlays.has("kikiculo_land"))  parts.push("土砂危険度");
  if (activeOverlays.has("kikiculo_flood")) parts.push("河川洪水");
  if (ncActive)                             parts.push("ナウキャスト");
  if (activeOverlays.has("typhoon2019"))    parts.push("台風19号");
  if (activeBreach.has("typhoon2019_breach")) parts.push("破堤(R1)");
  if (activeBreach.has("meiji43_breach"))   parts.push("破堤(M43)");
  if (floodLabelsEnabled) {
    const n = lastFloodWarnings.size;
    parts.push(n > 0 ? `洪水予報(${n}河川)` : "洪水予報表示中");
  }

  if (parts.length === 0) { summaryEl.textContent = "非表示"; return; }

  const timeEl = document.getElementById("kikiculo-time");
  const hasKiki = activeOverlays.has("kikiculo_land") || activeOverlays.has("kikiculo_flood");
  const timeStr = hasKiki && timeEl && timeEl.textContent !== "--:-- JST"
    ? ` | ${timeEl.textContent}` : "";
  summaryEl.textContent = parts.join(" / ") + timeStr;
}

// ---- 指定河川洪水予報ラベル ----

const FLOOD_WARNING_API = "https://www.jma.go.jp/bosai/flood/data/r8/flood_xml.json";

// 荒川・利根川・多摩川系の対象河川（各GeoJSONの線分中点から算出）
const FLOOD_TARGET_RIVERS = [
  // 荒川本流
  { name: "荒川",     lon: 138.9977, lat: 35.9615 },
  // 荒川支流
  { name: "都幾川",   lon: 139.2511, lat: 36.004  },
  { name: "入間川",   lon: 139.1847, lat: 35.8791 },
  { name: "越辺川",   lon: 139.4619, lat: 35.9657 },
  { name: "高麗川",   lon: 139.2303, lat: 35.9108 },
  { name: "市野川",   lon: 139.3594, lat: 36.0492 },
  { name: "新河岸川", lon: 139.5222, lat: 35.8899 },
  { name: "柳瀬川",   lon: 139.429,  lat: 35.776  },
  { name: "槻川",     lon: 139.2364, lat: 36.0439 },
  { name: "小畔川",   lon: 139.3739, lat: 35.9063 },
  { name: "霞川",     lon: 139.3823, lat: 35.8368 },
  { name: "九十九川", lon: 139.3814, lat: 35.9996 },
  { name: "隅田川",   lon: 139.7378, lat: 35.7805 },
  { name: "芝川",     lon: 139.6514, lat: 35.8965 },
  { name: "新芝川",   lon: 139.7277, lat: 35.8216 },
  // 利根川本流・主要支流
  { name: "利根川",   lon: 139.022,  lat: 36.6486 },
  { name: "渡良瀬川", lon: 139.6929, lat: 36.1872 },
  { name: "鬼怒川",   lon: 139.6264, lat: 36.8707 },
  { name: "江戸川",   lon: 139.8046, lat: 36.0446 },
  { name: "小貝川",   lon: 140.1156, lat: 35.9247 },
  { name: "烏川",     lon: 138.789,  lat: 36.4264 },
  { name: "吾妻川",   lon: 138.5803, lat: 36.5454 },
  { name: "神流川",   lon: 138.7159, lat: 36.083  },
  // 多摩川本流・主要支流
  { name: "多摩川",   lon: 139.4194, lat: 35.6802 },
  { name: "浅川",     lon: 139.3156, lat: 35.668  },
  { name: "秋川",     lon: 139.1821, lat: 35.7254 },
];

let floodWarningMarkers = [];
let floodLabelsEnabled  = false;
let lastFloodWarnings   = new Map(); // 河川名 → { level, condition }

// API河川名を正規化（水系プレフィックス・流域サフィックスを除去）
function normalizeRiverName(raw) {
  return raw
    .replace(/[^\s]+水系\s*/g, "")
    .replace(/(上流部|中流部|下流部|上中流部|中下流部|下中流部)$/, "")
    .replace(/[・、].*$/, "")
    .trim();
}

// 氾濫情報の文字列からレベル番号を返す（解除・無効は0）
function getFloodLevel(condition) {
  if (!condition || condition.includes("解除")) return 0;
  if (condition.includes("レベル５")) return 5;
  if (condition.includes("レベル４")) return 4;
  if (condition.includes("レベル３")) return 3;
  if (condition.includes("レベル２")) return 2;
  return 0;
}

function clearFloodLabels() {
  floodWarningMarkers.forEach((m) => m.remove());
  floodWarningMarkers = [];
}

function applyFloodLabels() {
  clearFloodLabels();
  if (!floodLabelsEnabled) return;

  for (const river of FLOOD_TARGET_RIVERS) {
    const warning = lastFloodWarnings.get(river.name);
    if (!warning) continue;

    const el = document.createElement("div");
    el.className = `flood-label level-${warning.level}`;
    el.textContent = `⚠ ${river.name} Lv${warning.level}`;
    el.title = warning.condition;

    const marker = new maplibregl.Marker({ element: el, anchor: "left" })
      .setLngLat([river.lon, river.lat])
      .addTo(map);
    floodWarningMarkers.push(marker);
  }
}

async function fetchFloodWarnings() {
  try {
    const items = await fetch(FLOOD_WARNING_API).then((r) => r.json());

    // APIの生データからレベル別に最大値でマッピング（正規化名 → warning）
    const apiWarnings = new Map();
    for (const item of items) {
      const level = getFloodLevel(item.item?.condition || "");
      if (level === 0) continue;
      const normalized = normalizeRiverName(item.riverName || "");
      if (!apiWarnings.has(normalized) || apiWarnings.get(normalized).level < level) {
        apiWarnings.set(normalized, { level, condition: item.item?.condition || "" });
      }
    }

    // ターゲット河川リストとAPI結果を部分文字列マッチングで対応付け
    lastFloodWarnings = new Map();
    for (const river of FLOOD_TARGET_RIVERS) {
      let best = null;
      for (const [apiName, info] of apiWarnings) {
        if (apiName === river.name || apiName.startsWith(river.name) || river.name.startsWith(apiName)) {
          if (!best || info.level > best.level) best = info;
        }
      }
      if (best) lastFloodWarnings.set(river.name, best);
    }

    applyFloodLabels();
    updateHazardSummary();
  } catch (e) {
    console.warn("洪水予報取得エラー:", e);
  }
}

const map = new maplibregl.Map({
  container: "map",
  // 標準地図(vector)は774レイヤーのGSIスタイルで初回描画が重いため、
  // 初期表示は軽量なラスタの淡色地図にする（標準地図は選択肢として残す）
  style: BASE_LAYERS.pale,
  center: [139.423323, 35.998809],
  zoom: 10,
  // 気象庁ナウキャスト/キキクルのタイル提供範囲(z4-10)を下回ると
  // ラスタ層が予告なく消える(MapLibreはminzoom未満をフェードせず非表示にする)ため、
  // 地図全体のズームをその下限に合わせて制限する
  minZoom: 4,
  attributionControl: false,
});

// 石碑マーカーはDOM要素なのでスタイル読み込み(map "load")を待たずに描画できる。
// ベースマップ（GSIベクトルタイル等）のネットワーク取得が遅い環境でも
// マーカー表示だけは先に済ませ、体感速度を改善する
const monumentsDataReady = Promise.all([
  fetch("monuments_suijin.geojson").then((r) => r.json()),
  fetch("monuments_water_related.geojson").then((r) => r.json()),
]).then(([suijin, other]) => {
  monumentsData = [...suijin.features, ...other.features];
  addMarkers();
  updateMonumentStats();
});

map.on("load", () => {
  // 円バッファはmap.addSource/addLayerを使うためスタイル読み込み完了が必須
  monumentsDataReady.then(() => addActiveBuffers());
});

// --- UI DOM参照 ---
const hydroCtrl    = document.getElementById("hydro-ctrl");
const hydroSlider  = document.getElementById("hydro-opacity");
const hydroValSpan = document.getElementById("hydro-opacity-val");
const hydroLegend  = document.getElementById("hydro-legend");
const hydroLegendBody   = document.getElementById("hydro-legend-body");
const hydroLegendToggle = document.getElementById("hydro-legend-toggle");
const jinsokuCtrl    = document.getElementById("jinsoku-ctrl");
const jinsokuSlider  = document.getElementById("jinsoku-opacity");
const jinsokuValSpan = document.getElementById("jinsoku-opacity-val");

document.getElementById("hydro-legend-header").addEventListener("click", () => {
  const isOpen = hydroLegendBody.classList.toggle("open");
  hydroLegendToggle.textContent = isOpen ? "▲" : "▼";
});

// スケール表示（左下）
map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");

// ズームレベル表示（右下・出典表記の上）
const zoomDisplayEl = document.getElementById("zoom-display");
function updateZoomDisplay() {
  zoomDisplayEl.textContent = `z${map.getZoom().toFixed(1)}`;
}
map.on("zoom", updateZoomDisplay);
updateZoomDisplay();

// ズームコントロール（左上）
document.getElementById("zoom-in-btn").addEventListener("click", () => map.zoomIn());
document.getElementById("zoom-out-btn").addEventListener("click", () => map.zoomOut());

// 地図クリックでプレイスカードを閉じる
map.on("click", closePlaceCard);

// --- 水神碑タイプ フィルタ ---
document.querySelectorAll("input[data-type]").forEach((cb) => {
  cb.addEventListener("change", () => {
    cb.checked
      ? activeTypes.add(cb.dataset.type)
      : activeTypes.delete(cb.dataset.type);
    addMarkers();
  });
});

// --- ベースレイヤ切り替え ---
document.querySelectorAll('input[name="base-layer"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    const layerId = radio.value;
    currentBaseLayer = layerId;
    hydroCtrl.classList.toggle("visible", layerId === "hydro");
    hydroLegend.classList.toggle("visible", layerId === "hydro");
    jinsokuCtrl.classList.toggle("visible", layerId === "jinsoku");
    map.setStyle(BASE_LAYERS[layerId]);
    map.once("styledata", () => {
      // DEMを先に追加してレイヤ順序（DEM→バッファ→河川→破堤）を保つ
      if (elevationActive) addElevationLayer();
      addMarkers();
      addActiveBuffers();
      addRiverLayers();
      addRasterOverlays();
      addBreachLayers();
      // 基盤地図情報DEMはスタイルリロード後も復元
      if (localHillshadeActive) { addLocalDemHillshadeSource(); addLocalHillshadeLayer(); }
      if (terrain3dActive) { addLocalDemTerrainSource(); enableTerrain3d(); }
      if (ncActive && ncFrames.length > 0) ncRestoreLayers();
      if (peActive && peFrames.length > 0) peRestoreLayer();
      applyFloodLabels();
    });
    updateAttribution();
  });
});

// --- 治水地形図 透明度 ---
hydroSlider.addEventListener("input", () => {
  const val = parseFloat(hydroSlider.value);
  hydroValSpan.textContent = Math.round(val * 100) + "%";
  if (map.getLayer("lcmfc2"))
    map.setPaintProperty("lcmfc2", "raster-opacity", val);
});

// --- 迅速測図 透明度 ---
jinsokuSlider.addEventListener("input", () => {
  const val = parseFloat(jinsokuSlider.value);
  jinsokuValSpan.textContent = Math.round(val * 100) + "%";
  if (map.getLayer("base"))
    map.setPaintProperty("base", "raster-opacity", val);
});

// --- 破堤箇所ポップアップ ---
const breachPopup = new maplibregl.Popup({ maxWidth: "260px", anchor: "bottom" });

function registerBreachPopups() {
  Object.entries(BREACH_LAYERS)
    .filter(([, cfg]) => cfg.hasPopup)
    .forEach(([id]) => {
      map.on("click", `breach-${id}`, (e) => {
        const p = e.features[0].properties;
        breachPopup
          .setLngLat(e.lngLat)
          .setHTML(`
            <strong>${p.text}</strong>
            <table>
              <tr><td>種別</td><td>${p.type}</td></tr>
              <tr><td>河川</td><td>${p.river}</td></tr>
              <tr><td>岸</td><td>${p.bank}</td></tr>
              <tr><td>発生</td><td>${p.event}</td></tr>
            </table>
          `)
          .addTo(map);
      });
      map.on("mouseenter", `breach-${id}`, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", `breach-${id}`, () => { map.getCanvas().style.cursor = ""; });
    });
}

// --- 破堤箇所 トグル ---
document.querySelectorAll("input[data-breach]").forEach((cb) => {
  cb.addEventListener("change", () => {
    const id = cb.dataset.breach;
    if (cb.checked) {
      activeBreach.add(id);
      addBreachLayer(id);
    } else {
      activeBreach.delete(id);
      removeBreachLayer(id);
    }
    updateAttribution();
    updateHazardSummary();
  });
});

// --- 著作権表示（ベースレイヤ・河道レイヤー連動） ---
const KJM_LAYERS = ["kjm_kanto", "kjm_tokyo50_2man", "kjm_tokyo50"];

function updateAttribution() {
  const parts = [];
  if (KJM_LAYERS.includes(currentBaseLayer)) {
    parts.push("今昔マップ on the web (C)谷　謙二");
  } else if (currentBaseLayer === "jinsoku") {
    parts.push("© 農研機構農業環境研究部門");
  } else if (currentBaseLayer === "rekichizu") {
    parts.push("出典：れきちず");
  } else {
    parts.push("©国土地理院");
  }
  const nationalData = ["current", "tributaries", "tonegawa", "tamagawa", "sagamigawa"];
  if (nationalData.some((id) => activeRivers.has(id))) {
    parts.push("©国土数値情報(河川データ)");
  }
  if (activeRivers.has("pre") || activeRivers.has("post")) {
    parts.push("©国土交通省資料を基に描画・作成");
  }
  if (activeBreach.has("typhoon2019_breach")) {
    parts.push("台風第19号による荒川の出水状況(国土交通省関東地方整備局荒川下流河川事務所Web資料による)");
  }
  if (activeBreach.has("meiji43_breach")) {
    parts.push("明治四十三年埼玉県水害誌付録地図による、荒川流域における十間以上の破堤箇所");
  }
  if (elevationActive) {
    parts.push("色別標高図 ©国土地理院（DEMタイル）");
  }
  if (["kikiculo_land", "kikiculo_flood", "kikiculo_flood_nation"].some((id) => activeOverlays.has(id))) {
    parts.push("©気象庁 危険度分布");
  }
  if (ncActive) {
    parts.push("©気象庁 降水ナウキャスト");
  }
  if (peActive && peMeta) {
    parts.push(peMeta.attribution);
  }
  parts.push("©MapLibre GL JS");
  document.getElementById("attribution").textContent = parts.join(" | ");
}
updateAttribution();

// --- ラスタオーバーレイ トグル ---
document.querySelectorAll("input[data-overlay]").forEach((cb) => {
  cb.addEventListener("change", () => {
    const id = cb.dataset.overlay;
    // kikiculo_flood (指定河川洪水) は都道府県管理・国管理の2タイルを束ねて
    // 1トグルとして見せるため、対の kikiculo_flood_nation も同時に切り替える
    const ids = id === "kikiculo_flood" ? [id, "kikiculo_flood_nation"] : [id];
    ids.forEach((overlayId) => {
      if (cb.checked) {
        activeOverlays.add(overlayId);
        addRasterOverlay(overlayId);
      } else {
        activeOverlays.delete(overlayId);
        removeRasterOverlay(overlayId);
      }
    });
    updateAttribution();
    updateKikikuloLegendVisibility();
  });
});

// --- 荒川河道 トグル ---
document.querySelectorAll("input[data-river]").forEach((cb) => {
  cb.addEventListener("change", () => {
    const id = cb.dataset.river;
    if (cb.checked) {
      activeRivers.add(id);
      addRiverLayer(id);
    } else {
      activeRivers.delete(id);
      removeRiverLayer(id);
    }
    updateAttribution();
  });
});

// --- 河川クリックで河川名表示 ---
const riverPopup = new maplibregl.Popup({
  closeButton: false,
  className: "river-popup",
});

["current", "tributaries", "tonegawa", "tamagawa", "sagamigawa"].forEach((id) => {
  map.on("click", `river-${id}`, (e) => {
    const name = e.features[0].properties.W05_004;
    riverPopup.setLngLat(e.lngLat).setHTML(`<strong>${name}</strong>`).addTo(map);
  });
  map.on("mouseenter", `river-${id}`, () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", `river-${id}`, () => {
    map.getCanvas().style.cursor = "";
  });
});

registerBreachPopups();

// ---- 九頭龍碑バッファ トグル ----
document.querySelectorAll("input[data-buffer]").forEach((cb) => {
  cb.addEventListener("change", () => {
    const r = cb.dataset.buffer;
    if (cb.checked) {
      activeBuffers.add(r);
      if (monumentsData.length > 0) addKuzuryuBuffer(r);
    } else {
      activeBuffers.delete(r);
      removeKuzuryuBuffer(r);
    }
    updateDragonPulse();
  });
});

// ---- 色別標高図 トグル ----
document.getElementById("elevation-toggle").addEventListener("change", (e) => {
  elevationActive = e.target.checked;
  elevCtrl.classList.toggle("visible", elevationActive);
  if (elevationActive) {
    addElevationLayer();
    renderElevBandsTable();
  } else {
    removeElevationLayer();
    document.getElementById("elevation-popup").classList.remove("visible");
  }
  updateAttribution();
});

// ---- 色別標高図 設定パネル 開閉 ----
document.getElementById("elevation-settings-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const popup = document.getElementById("elevation-popup");
  const isOpen = popup.classList.toggle("visible");
  if (isOpen) renderElevBandsTable();
});

document.getElementById("elevation-popup-close").addEventListener("click", () => {
  document.getElementById("elevation-popup").classList.remove("visible");
});

// パネル内クリックでフライアウトが閉じないよう伝播停止
document.getElementById("elevation-popup").addEventListener("click", (e) => e.stopPropagation());

// 透明度スライダー（即反映）
document.getElementById("elev-opacity").addEventListener("input", (e) => {
  const val = parseFloat(e.target.value);
  document.getElementById("elev-opacity-val").textContent = Math.round(val * 100) + "%";
  if (elevationActive && map.getLayer("dem-color")) {
    map.setPaintProperty("dem-color", "raster-opacity", val);
  }
});

// 陰影トグル（即反映）
document.getElementById("elev-chk-hillshade").addEventListener("change", (e) => {
  if (!elevationActive) return;
  if (e.target.checked) {
    addElevHillshade();
  } else {
    if (map.getLayer("dem-hillshade-layer")) map.removeLayer("dem-hillshade-layer");
  }
});

// 地図に反映ボタン
document.getElementById("elev-apply-btn").addEventListener("click", () => {
  if (elevationActive) reloadElevTiles();
});

// ---- 基盤地図情報DEM（5m）---- 高精細陰影起伏図・3D地形 ----

const LOCAL_DEM_URL = "pmtiles://dem_pipeline/work/dem.pmtiles";
let localHillshadeActive = false;
let terrain3dActive = false;

// 陰影用・地形用で別ソースに分ける（同一ソース使用時の品質低下を回避）
// maxzoom: 14 → タイル境界の段差アーティファクトを軽減（z15-16はz14タイルをオーバーズーム）
function addLocalDemHillshadeSource() {
  if (map.getSource("local-dem-hs")) return;
  map.addSource("local-dem-hs", {
    type: "raster-dem",
    url: LOCAL_DEM_URL,
    tileSize: 256,
    encoding: "terrarium",
    maxzoom: 14,
  });
}

function addLocalDemTerrainSource() {
  if (map.getSource("local-dem-terrain")) return;
  map.addSource("local-dem-terrain", {
    type: "raster-dem",
    url: LOCAL_DEM_URL,
    tileSize: 256,
    encoding: "terrarium",
    maxzoom: 14,
  });
}

function addLocalHillshadeLayer() {
  if (map.getLayer("local-hillshade")) return;
  // マーカーより下に挿入（monuments-layerが存在する場合）
  const layerIds = map.getStyle().layers.map((l) => l.id);
  const before = layerIds.includes("monuments-layer") ? "monuments-layer" : undefined;
  map.addLayer(
    {
      id: "local-hillshade",
      type: "hillshade",
      source: "local-dem-hs",
      paint: {
        "hillshade-exaggeration": 0.6,
        "hillshade-illumination-anchor": "map",
        "hillshade-shadow-color": "#3a3a3a",
        "hillshade-highlight-color": "#ffffff",
      },
    },
    before
  );
}

function enableTerrain3d() {
  const exag = parseFloat(document.getElementById("terrain-exaggeration")?.value ?? "1.5");
  map.setTerrain({ source: "local-dem-terrain", exaggeration: exag });
}

function disableTerrain3d() {
  map.setTerrain(null);
}

// 高精細陰影起伏図 トグル
document.getElementById("local-hillshade-toggle").addEventListener("change", (e) => {
  localHillshadeActive = e.target.checked;
  if (localHillshadeActive) {
    addLocalDemHillshadeSource();
    addLocalHillshadeLayer();
  } else {
    if (map.getLayer("local-hillshade")) map.removeLayer("local-hillshade");
    if (map.getSource("local-dem-hs")) map.removeSource("local-dem-hs");
  }
});

// 3D地形 トグル
document.getElementById("terrain3d-toggle").addEventListener("change", (e) => {
  terrain3dActive = e.target.checked;
  const ctrl = document.getElementById("terrain3d-ctrl");
  ctrl.classList.toggle("visible", terrain3dActive);
  if (terrain3dActive) {
    addLocalDemTerrainSource();
    enableTerrain3d();
  } else {
    disableTerrain3d();
    if (map.getSource("local-dem-terrain")) map.removeSource("local-dem-terrain");
  }
});

// 誇張スライダー
document.getElementById("terrain-exaggeration").addEventListener("input", (e) => {
  const val = parseFloat(e.target.value);
  document.getElementById("terrain-exag-val").textContent = `×${val.toFixed(1)}`;
  if (terrain3dActive) map.setTerrain({ source: "local-dem-terrain", exaggeration: val });
});

// --- シナリオプリセット ---
const PRESETS = {
  typhoon2019: {
    basemap:  "pale",
    types:    new Set(["water"]),
    overlays: new Set(["typhoon2019"]),
    breach:   new Set(["typhoon2019_breach"]),
    rivers:   new Set(),
    buffers:  new Set(),
    nowcast:  false,
  },
  historical: {
    basemap:  "pale",
    types:    new Set(["water", "dragon", "benten", "other"]),
    overlays: new Set(),
    breach:   new Set(),
    rivers:   new Set(["pre", "post"]),
    buffers:  new Set(),
    nowcast:  false,
  },
  reset: {
    basemap:  "vector",
    types:    new Set(["water", "dragon", "benten"]),
    overlays: new Set(),
    breach:   new Set(),
    rivers:   new Set(),
    buffers:  new Set(),
    nowcast:  false,
  },
  survey: {
    basemap:  "pale",
    types:    new Set(["water", "dragon", "benten", "other"]),
    overlays: new Set(["kikiculo_land"]),
    breach:   new Set(),
    rivers:   new Set(["current"]),
    buffers:  new Set(),
    nowcast:  true,
  },
};

function applyPreset(presetId) {
  const p = PRESETS[presetId];
  if (!p) return;

  // プリセット適用中はトグルのchangeイベントで「カスタム」化させない
  window.__applyingPreset = true;

  // シナリオはライブ降水のON/OFFのみを扱うため、過去イベント再生中なら先に閉じる
  if (peActive) {
    peDisable();
    const srcSelect = document.getElementById("nc-source");
    if (srcSelect) srcSelect.value = "live";
  }

  // Sets一括更新
  activeTypes.clear();    p.types.forEach((v) => activeTypes.add(v));
  activeOverlays.clear(); p.overlays.forEach((v) => activeOverlays.add(v));
  activeBreach.clear();   p.breach.forEach((v) => activeBreach.add(v));
  activeRivers.clear();   p.rivers.forEach((v) => activeRivers.add(v));
  activeBuffers.clear();  p.buffers.forEach((v) => activeBuffers.add(v));

  // チェックボックス・ラジオのDOM同期
  document.querySelectorAll("input[data-type]").forEach((cb) => {
    cb.checked = p.types.has(cb.dataset.type);
  });
  document.querySelectorAll("input[data-overlay]").forEach((cb) => {
    cb.checked = p.overlays.has(cb.dataset.overlay);
  });
  document.querySelectorAll("input[data-breach]").forEach((cb) => {
    cb.checked = p.breach.has(cb.dataset.breach);
  });
  document.querySelectorAll("input[data-river]").forEach((cb) => {
    cb.checked = p.rivers.has(cb.dataset.river);
  });
  document.querySelectorAll("input[data-buffer]").forEach((cb) => {
    cb.checked = p.buffers.has(cb.dataset.buffer);
  });

  updateKikikuloLegendVisibility();

  // ナウキャスト ON/OFF
  if (p.nowcast === true && !ncActive) {
    const ncToggleEl = document.getElementById("nowcast-toggle");
    if (ncToggleEl) ncToggleEl.checked = true;
    ncEnable();
  } else if (p.nowcast === false && ncActive) {
    const ncToggleEl = document.getElementById("nowcast-toggle");
    if (ncToggleEl) ncToggleEl.checked = false;
    ncDisable();
  }

  // ベースマップ切り替え → styledata コールバックで全レイヤー再構築
  const radio = document.querySelector(`input[name="base-layer"][value="${p.basemap}"]`);
  radio.checked = true;
  radio.dispatchEvent(new Event("change", { bubbles: true }));

  window.__applyingPreset = false;
  document.dispatchEvent(new CustomEvent("preset-applied", { detail: presetId }));
}

// --- 検索フィールド（インクリメンタル検索 + flyTo） ---
const searchInput   = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");
const searchClear   = document.getElementById("search-clear");

function closeSearch() {
  searchResults.hidden = true;
  searchClear.hidden = true;
  searchInput.value = "";
}

function selectSearchResult(feature) {
  const [lng, lat] = feature.geometry.coordinates;
  map.flyTo({ center: [lng, lat], zoom: 15, duration: 700 });
  openPlaceCard(feature.properties);
  closeSearch();
}

function runSearch(query) {
  const q = query.trim().toLowerCase();
  searchClear.hidden = !query;

  if (!q || monumentsData.length === 0) {
    searchResults.hidden = true;
    return;
  }

  const hits = monumentsData
    .filter(({ properties: p }) =>
      (p.name    && p.name.toLowerCase().includes(q)) ||
      (p.address && p.address.toLowerCase().includes(q))
    )
    .slice(0, 8);

  if (hits.length === 0) {
    searchResults.innerHTML = '<div class="search-empty">該当なし</div>';
    searchResults.hidden = false;
    return;
  }

  searchResults.innerHTML = hits
    .map((f, i) => {
      const p = f.properties;
      return `<div class="search-item" data-idx="${i}">
        <span class="search-item-name">${p.name ?? ""}</span>
        <span class="search-item-sub">${p.address ?? ""}</span>
      </div>`;
    })
    .join("");

  hits.forEach((f, i) => {
    searchResults.querySelector(`[data-idx="${i}"]`).addEventListener("click", () => {
      selectSearchResult(f);
    });
  });

  searchResults.hidden = false;
}

searchInput.addEventListener("input", () => runSearch(searchInput.value));

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeSearch();
    searchInput.blur();
  }
});

searchClear.addEventListener("click", () => {
  closeSearch();
  searchInput.focus();
});

// 検索フィールド外クリックで結果を閉じる
document.getElementById("search-field").addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => { searchResults.hidden = true; });

// キキクル タイムスタンプ初期取得 + 10分ごと自動更新
fetchKikikuloTimestamp();
setInterval(refreshKikikuloLayers, 600_000);

// 指定河川洪水予報ラベル トグル
document.getElementById("flood-label-toggle").addEventListener("change", (e) => {
  floodLabelsEnabled = e.target.checked;
  if (floodLabelsEnabled) {
    fetchFloodWarnings();
  } else {
    clearFloodLabels();
    lastFloodWarnings = new Map();
    updateHazardSummary();
  }
});

// 10分ごとに洪水予報を自動更新（ラベル有効時のみAPI呼出し）
setInterval(() => { if (floodLabelsEnabled) fetchFloodWarnings(); }, 600_000);

// --- ナウキャスト コントローラ イベント ---
// #nowcast-ctrl のスライダー・再生ボタン群はライブ(nc*)と過去イベント(pe*)で共用する。
// peActive の真偽で分岐し、どちらの再生エンジンを操作するか切り替える
document.getElementById("nowcast-toggle").addEventListener("change", (e) => {
  if (e.target.checked) {
    const src = document.getElementById("nc-source")?.value ?? "live";
    src === "live" ? ncEnable() : peEnable(src);
  } else {
    peActive ? peDisable() : ncDisable();
  }
});
document.getElementById("nc-source").addEventListener("change", (e) => {
  const val = e.target.value;
  if (val === "live") {
    if (peActive) peDisable();
    ncActive ? ncShowFrame(ncCurrent) : ncEnable();
  } else {
    peEnable(val);
  }
});
document.getElementById("nc-btn-play").addEventListener("click", () => {
  if (peActive) { pePlaying ? peStop() : pePlay(); }
  else { ncPlaying ? ncStop() : ncPlay(); }
});
document.getElementById("nc-btn-prev").addEventListener("click", () => {
  if (peActive) { peStop(); peShowFrame(peCurrent - 1); }
  else { ncStop(); ncShowFrame(ncCurrent - 1); }
});
document.getElementById("nc-btn-next").addEventListener("click", () => {
  if (peActive) { peStop(); peShowFrame(peCurrent + 1); }
  else { ncStop(); ncShowFrame(ncCurrent + 1); }
});
document.getElementById("nc-btn-first").addEventListener("click", () => {
  if (peActive) { peStop(); peShowFrame(0); }
  else { ncStop(); ncShowFrame(0); }
});
document.getElementById("nc-btn-last").addEventListener("click", () => {
  if (peActive) { peStop(); peShowFrame(peFrames.length - 1); }
  else { ncStop(); ncShowFrame(ncFrames.length - 1); }
});
document.getElementById("nc-slider").addEventListener("input", (e) => {
  if (peActive) { peStop(); peShowFrame(parseInt(e.target.value)); }
  else { ncStop(); ncShowFrame(parseInt(e.target.value)); }
});
document.getElementById("nc-speed").addEventListener("change", () => {
  if (peActive) { if (pePlaying) { peStop(); pePlay(); } }
  else { if (ncPlaying) { ncStop(); ncPlay(); } }
});
document.getElementById("nc-element").addEventListener("change", async (e) => {
  const wasPlaying = ncPlaying;
  ncStop();
  ncElement = e.target.value;
  await ncInitialize();
  if (wasPlaying) ncPlay();
});

// ⌘K（またはCtrl+K）で検索フィールドにフォーカス
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});
