// ===== パネルの折りたたみ =====
const _panel = document.getElementById("main-panel");
const _collapseBtn = document.getElementById("panel-collapse-btn");
_collapseBtn.addEventListener("click", () => {
    const collapsed = _panel.classList.toggle("collapsed");
    _collapseBtn.classList.toggle("ti-minus", !collapsed);
    _collapseBtn.classList.toggle("ti-plus", collapsed);
    _collapseBtn.setAttribute(
        "aria-label",
        collapsed ? "展開" : "畳む",
    );
});

// ===== ナウキャストパネルの折りたたみ =====
const _ncPanel = document.getElementById("nowcast-ctrl");
const _ncCollapseBtn = document.getElementById("nc-collapse-btn");
_ncCollapseBtn.addEventListener("click", () => {
    const collapsed = _ncPanel.classList.toggle("collapsed");
    _ncCollapseBtn.classList.toggle("ti-minus", !collapsed);
    _ncCollapseBtn.classList.toggle("ti-plus", collapsed);
    _ncCollapseBtn.setAttribute(
        "aria-label",
        collapsed ? "展開" : "畳む",
    );
});

// ===== 検索フィールドの開閉 =====
const _searchToggleBtn =
    document.getElementById("search-toggle-btn");
const _searchField = document.getElementById("search-field");
_searchToggleBtn.addEventListener("click", () => {
    const willShow = _searchField.hidden;
    _searchField.hidden = !willShow;
    if (willShow) document.getElementById("search-input").focus();
});

// ===== セグメンテッドタブ切替 =====
const _tabs = document.querySelectorAll(".tab-btn");
const _tabPanels = document.querySelectorAll(".tab-panel");
_tabs.forEach((t) => {
    t.addEventListener("click", () => {
        _tabs.forEach((x) => x.classList.remove("active"));
        t.classList.add("active");
        const target = t.dataset.tab;
        _tabPanels.forEach((p) => p.classList.remove("active"));
        document
            .getElementById("panel-" + target)
            .classList.add("active");
    });
});

// ===== アコーディオン（同タブ内で1つだけ開く） =====
document.querySelectorAll(".acc-head").forEach((h) => {
    h.addEventListener("click", () => {
        const row = h.parentElement;
        const panel = row.closest(".tab-panel");
        const isOpen = row.classList.contains("open");
        panel
            .querySelectorAll(".acc-row")
            .forEach((r) => r.classList.remove("open"));
        if (!isOpen) row.classList.add("open");
    });
});

// ===== ベースマップ ミニタブ（現代/歴史地図/主題図） =====
document.querySelectorAll(".bm-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
        const bar = tab.parentElement;
        bar.querySelectorAll(".bm-tab").forEach((t) =>
            t.classList.remove("active"),
        );
        tab.classList.add("active");
        const scroll = bar.nextElementSibling;
        scroll.querySelectorAll(".bm-group").forEach((g) => {
            g.classList.toggle(
                "active",
                g.dataset.group === tab.dataset.group,
            );
        });
    });
});

// ===== ベースマップ選択 → サマリ更新 =====
document
    .querySelectorAll('input[name="base-layer"]')
    .forEach((radio) => {
        radio.addEventListener("change", () => {
            if (!radio.checked) return;
            const label = radio
                .closest(".bm-tile")
                .querySelector(".bm-label").textContent;
            const row = document.querySelector(
                '.acc-row[data-key="basemap"]',
            );
            row.querySelector(".acc-summary").textContent = label;
        });
    });

// ===== トグル系サマリ更新（data-key 共通ロジック） =====
const RIVER_KEY_UNIT = { river: "河川" };

function refreshSummary(key) {
    const row = document.querySelector(
        '.acc-row[data-key="' + key + '"]',
    );
    if (!row) return;
    const summary = row.querySelector(".acc-summary");
    if (!summary) return;
    const inputs = document.querySelectorAll(
        'input[data-key="' + key + '"]',
    );
    const onLabels = [];
    inputs.forEach((el) => {
        if (el.checked) onLabels.push(el.dataset.label);
    });
    const total = inputs.length;
    const unit = RIVER_KEY_UNIT[key];

    if (onLabels.length === 0) {
        summary.textContent = "非表示";
    } else if (unit) {
        if (onLabels.length === 1) {
            summary.textContent = onLabels[0] + " (1" + unit + ")";
        } else if (onLabels.length <= 2) {
            summary.textContent =
                onLabels.join("・") +
                " (" +
                onLabels.length +
                unit +
                ")";
        } else {
            summary.textContent =
                onLabels[0] +
                " ほか (" +
                onLabels.length +
                unit +
                ")";
        }
    } else if (key === "monument") {
        if (onLabels.length <= 2) {
            summary.textContent =
                onLabels.join("・") +
                " (" +
                onLabels.length +
                "/" +
                total +
                ")";
        } else {
            summary.textContent =
                onLabels[0] +
                " ほか (" +
                onLabels.length +
                "/" +
                total +
                ")";
        }
    } else {
        summary.textContent = onLabels.join("・");
    }
}

function refreshAllSummaries() {
    ["monument", "river", "course", "flood", "history", "hazard", "terrain"].forEach(
        refreshSummary,
    );
}

document.querySelectorAll("input[data-key]").forEach((el) => {
    el.addEventListener("change", () => {
        refreshSummary(el.dataset.key);
        // プリセット適用中の自動同期は「カスタム」化させない
        if (!window.__applyingPreset) markCustomScenario();
    });
});

// ===== シナリオカード =====
document
    .querySelectorAll(".scenario-card[data-preset]")
    .forEach((card) => {
        card.addEventListener("click", () => {
            if (card.dataset.preset === "custom") return;
            applyPreset(card.dataset.preset);
        });
    });

function markCustomScenario() {
    document
        .querySelectorAll(".scenario-card")
        .forEach((c) => c.classList.remove("active"));
    const custom = document.getElementById("custom-scenario-card");
    if (custom) custom.classList.add("active");
}

document.addEventListener("preset-applied", (e) => {
    document.querySelectorAll(".scenario-card").forEach((c) => {
        c.classList.toggle("active", c.dataset.preset === e.detail);
    });
    refreshAllSummaries();
});

refreshAllSummaries();

// CSPでインラインonerrorを使えないため、サムネ画像の読込失敗は捕捉フェーズで拾う
document.addEventListener(
  "error",
  (e) => {
    if (e.target instanceof HTMLImageElement && e.target.closest(".bm-tile")) {
      e.target.style.display = "none";
    }
  },
  true,
);
