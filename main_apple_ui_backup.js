// ---- プレイスカード ----

const placeCard      = document.getElementById("place-card");
const placePhoto     = document.getElementById("place-photo");
const placePhotoWrap = document.getElementById("place-photo-wrap");
const placeName      = document.getElementById("place-name");
const placeRows      = document.getElementById("place-rows");

function openPlaceCard(p) {
  placeName.textContent = p.name;

  if (p.photo_filename) {
    placePhoto.src = `monumentphoto/medium_res/${p.photo_filename}`;
    placePhoto.alt = p.name;
    placePhotoWrap.style.display = "";
    placePhoto.onerror = () => { placePhotoWrap.style.display = "none"; };
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
}

function closePlaceCard() {
  document.activeElement?.blur();
  placeCard.classList.remove("open");
  placeCard.setAttribute("aria-hidden", "true");
}

document.getElementById("place-card-close").addEventListener("click", closePlaceCard);

function createMarkerEl(p) {
  const el = document.createElement("div");
  el.className = `marker marker-${p.type}`;
  el.style.setProperty("--marker-color", p.color);
  el.style.setProperty("--marker-fill", p.fill_color);
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
let currentBaseLayer = "vector";

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

// フライアウト内 elevation-ctrl の参照
const elevCtrl = document.getElementById("elevation-ctrl");

// ---- キキクル（危険度分布）----
const KIKICULO_BASE_URL = "https://www.jma.go.jp/bosai/jmatile/data/risk";
let kikikuloBasetime  = "";
let kikikuloValidtime = "";
let kikikuloMember    = "immed0";

function kikikuloTileUrl(element) {
  return `${KIKICULO_BASE_URL}/${kikikuloBasetime}/${kikikuloMember}/${kikikuloValidtime}/surf/${element}/{z}/{x}/{y}.png`;
}

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
  get kikiculo_land() {
    return { tiles: [kikikuloTileUrl("land")], tileSize: 256 };
  },
  get kikiculo_flood() {
    return { tiles: [kikikuloTileUrl("designated_river")], tileSize: 256 };
  },
};
let monumentsData = [];
let markers = [];

function clearMarkers() {
  markers.forEach((m) => m.remove());
  markers = [];
}

function addMarkers() {
  clearMarkers();
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
  map.addSource(`overlay-${id}`, { type: "raster", tiles: cfg.tiles, tileSize: cfg.tileSize });
  map.addLayer({ id: `overlay-${id}`, type: "raster", source: `overlay-${id}` });
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
  ["kikiculo_land", "kikiculo_flood"].forEach((id) => {
    if (activeOverlays.has(id)) {
      removeRasterOverlay(id);
      addRasterOverlay(id);
    }
  });
}

// ---- 降水ナウキャスト ----

function ncTileUrl(f, elem) {
  return `${NOWCAST_BASE_URL}/${f.basetime}/none/${f.validtime}/surf/${elem}/{z}/{x}/{y}.png`;
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

function ncClearLayers() {
  ncFrames.forEach((_, i) => {
    if (map.getLayer(`nc-layer-${i}`)) map.removeLayer(`nc-layer-${i}`);
    if (map.getSource(`nc-src-${i}`))  map.removeSource(`nc-src-${i}`);
  });
}

function ncAddLayers(frames, elem) {
  frames.forEach((f, i) => {
    map.addSource(`nc-src-${i}`, {
      type: "raster",
      tiles: [ncTileUrl(f, elem)],
      tileSize: 256,
      minzoom: 4,
      maxzoom: 10,
    });
    map.addLayer({
      id: `nc-layer-${i}`,
      type: "raster",
      source: `nc-src-${i}`,
      paint: { "raster-opacity": 0 },
    });
  });
}

function ncShowFrame(index) {
  if (!ncFrames.length) return;
  const prev = ncCurrent;
  ncCurrent = Math.max(0, Math.min(index, ncFrames.length - 1));

  if (map.getLayer(`nc-layer-${prev}`))
    map.setPaintProperty(`nc-layer-${prev}`, "raster-opacity", 0);

  const f = ncFrames[ncCurrent];
  const opacity = f.type === "fcst" ? 0.55 : 0.78;
  if (map.getLayer(`nc-layer-${ncCurrent}`))
    map.setPaintProperty(`nc-layer-${ncCurrent}`, "raster-opacity", opacity);

  const labelEl  = document.getElementById("nc-time-label");
  const badgeEl  = document.getElementById("nc-badge");
  const sliderEl = document.getElementById("nc-slider");
  if (labelEl) labelEl.textContent = ncToJST(f.validtime);
  if (badgeEl) {
    badgeEl.textContent = f.type === "fcst" ? "予測" : "観測";
    badgeEl.className   = f.type === "fcst" ? "nc-badge nc-fcst" : "nc-badge nc-obs";
  }
  if (sliderEl) { sliderEl.max = ncFrames.length - 1; sliderEl.value = ncCurrent; }
}

function ncPlay() {
  ncPlaying = true;
  const btn = document.getElementById("nc-btn-play");
  if (btn) btn.textContent = "⏸ 停止";
  const ms = parseInt(document.getElementById("nc-speed")?.value ?? "500");
  ncTimer = setInterval(() => ncShowFrame((ncCurrent + 1) % ncFrames.length), ms);
}

function ncStop() {
  ncPlaying = false;
  clearInterval(ncTimer);
  ncTimer = null;
  const btn = document.getElementById("nc-btn-play");
  if (btn) btn.textContent = "▶ 再生";
}

async function ncInitialize() {
  const loadingEl = document.getElementById("nc-loading");
  if (loadingEl) loadingEl.hidden = false;
  try {
    const { obs, fcst } = await ncFetchFrames(ncElement);
    const newFrames = [...obs, ...fcst];
    ncClearLayers();
    ncAddLayers(newFrames, ncElement);
    ncFrames   = newFrames;
    ncObsCount = obs.length;
    ncCurrent  = ncObsCount - 1;
    ncShowFrame(ncCurrent);
  } catch (e) {
    console.warn("ナウキャスト初期化失敗", e);
  }
  if (loadingEl) loadingEl.hidden = true;
}

function ncRestoreLayers() {
  // ベースマップ変更後: 古いレイヤは既に消えているので直接追加
  ncAddLayers(ncFrames, ncElement);
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
  if (!ncRefreshTimer) {
    ncRefreshTimer = setInterval(async () => {
      if (!ncActive) return;
      const wasPlaying = ncPlaying;
      ncStop();
      try {
        const { obs, fcst } = await ncFetchFrames(ncElement);
        const newFrames = [...obs, ...fcst];
        ncClearLayers();
        ncAddLayers(newFrames, ncElement);
        ncFrames   = newFrames;
        ncObsCount = obs.length;
        ncCurrent  = Math.min(ncCurrent, ncFrames.length - 1);
        ncShowFrame(ncCurrent);
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
  ncFrames.forEach((_, i) => {
    if (map.getLayer(`nc-layer-${i}`))
      map.setPaintProperty(`nc-layer-${i}`, "raster-opacity", 0);
  });
  document.getElementById("nowcast-ctrl").hidden = true;
  updateAttribution();
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
  const kikiActive = ["kikiculo_land", "kikiculo_flood"].some((id) => activeOverlays.has(id));
  kikiLegendCtrl.hidden = !kikiActive;
}

const map = new maplibregl.Map({
  container: "map",
  style: BASE_LAYERS.vector,
  center: [139.423323, 35.998809],
  zoom: 10,
  attributionControl: false,
});

map.on("load", () => {
  Promise.all([
    fetch("monuments_suijin.geojson").then((r) => r.json()),
    fetch("monuments_water_related.geojson").then((r) => r.json()),
  ]).then(([suijin, other]) => {
    monumentsData = [...suijin.features, ...other.features];
    addMarkers();
    // データロード後に有効なバッファを追加（チェックが先行した場合の対応）
    addActiveBuffers();
  });
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

// ズームレベル表示
map.on("zoom", () => {
  document.getElementById("zoom-value").textContent = map.getZoom().toFixed(1);
});

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
  if (["kikiculo_land", "kikiculo_flood"].some((id) => activeOverlays.has(id))) {
    parts.push("©気象庁 危険度分布");
  }
  if (ncActive) {
    parts.push("©気象庁 降水ナウキャスト");
  }
  parts.push("©MapLibre GL JS");
  document.getElementById("attribution").textContent = parts.join(" | ");
}
updateAttribution();

// --- ラスタオーバーレイ トグル ---
document.querySelectorAll("input[data-overlay]").forEach((cb) => {
  cb.addEventListener("change", () => {
    const id = cb.dataset.overlay;
    if (cb.checked) {
      activeOverlays.add(id);
      addRasterOverlay(id);
    } else {
      activeOverlays.delete(id);
      removeRasterOverlay(id);
    }
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
}

document.querySelectorAll(".scenario-pill[data-preset]").forEach((btn) => {
  btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
});

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

// --- ナウキャスト コントローラ イベント ---
document.getElementById("nowcast-toggle").addEventListener("change", (e) => {
  e.target.checked ? ncEnable() : ncDisable();
});
document.getElementById("nc-btn-play").addEventListener("click", () => {
  ncPlaying ? ncStop() : ncPlay();
});
document.getElementById("nc-btn-prev").addEventListener("click", () => {
  ncStop(); ncShowFrame(ncCurrent - 1);
});
document.getElementById("nc-btn-next").addEventListener("click", () => {
  ncStop(); ncShowFrame(ncCurrent + 1);
});
document.getElementById("nc-btn-first").addEventListener("click", () => {
  ncStop(); ncShowFrame(0);
});
document.getElementById("nc-btn-last").addEventListener("click", () => {
  ncStop(); ncShowFrame(ncFrames.length - 1);
});
document.getElementById("nc-slider").addEventListener("input", (e) => {
  ncStop(); ncShowFrame(parseInt(e.target.value));
});
document.getElementById("nc-speed").addEventListener("change", () => {
  if (ncPlaying) { ncStop(); ncPlay(); }
});
document.getElementById("nc-element").addEventListener("change", async (e) => {
  const wasPlaying = ncPlaying;
  ncStop();
  ncElement = e.target.value;
  ncFrames  = [];
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
