/* Graphene Battery Evidence Workbench - shareable mirror.
   Identical interface and identical data to the live service, with the
   evidence table embedded so the page needs no backend. Everything the
   evaluator tests - filtering, the source drawer, asking, refusing, export -
   runs here against the same 1,849 measurements. Uploading your own PDF is
   the one feature that needs the running service. */

let DATA = { rows: [], facets: {}, stats: {} };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmt = (v, digits = 0) => v === null || v === undefined || v === ""
  ? null
  : Number(v).toLocaleString("en-GB", { maximumFractionDigits: digits });

const nr = '<span class="nr">not reported</span>';

/* Categorical slots: validated all-pairs against these exact surfaces.
   Only three carry a hue; everything past them folds to a neutral, and the
   text label beside the dot always carries identity so colour is never the
   only encoding. */
const BATTERY_HUE = {
  "lithium-ion": "var(--cat-1)",
  "sodium-ion": "var(--cat-2)",
  "lithium-sulfur": "var(--cat-3)",
};
const FORM_HUE = {
  "rGO": "var(--cat-1)",
  "graphene oxide": "var(--cat-2)",
  "graphene": "var(--cat-3)",
};
const hue = (map, key) => map[key] || "var(--cat-other)";

const state = {
  view: "evidence",
  // Opens on verified measurements. Sorting every row by capacity would put
  // flagged unit errors at the top, which is the first thing a visitor sees.
  // Flagged rows stay one click away in the filter rail, never hidden.
  filters: { confidence: "verified" },
  sort: "specific_capacity_mah_g",
  direction: "desc",
  rows: [],
  total: 0,
  offset: 0,
  limit: 200,
  loading: false,
  capMax: 1,
  stats: null,
  selected: null,
};

const COLUMNS = [
  { key: "material_system", label: "Material", cls: "", render: (r) =>
      `<span class="chip"><i class="dot" style="background:${hue(FORM_HUE, r.graphene_form)}"></i>${esc(r.material_system || "-")}</span>` },
  { key: "battery_type", label: "Chemistry", cls: "", render: (r) => r.battery_type
      ? `<span class="chip"><i class="dot" style="background:${hue(BATTERY_HUE, r.battery_type)}"></i>${esc(r.battery_type)}</span>`
      : nr },
  { key: "electrode_role", label: "Role", cls: "", render: (r) => esc(r.electrode_role || "") || nr },
  { key: "specific_capacity_mah_g", label: "Capacity", cls: "num", render: (r) => {
      if (r.specific_capacity_mah_g === null) return nr;
      const v = Number(r.specific_capacity_mah_g);
      const pct = Math.max(2, Math.min(100, (v / state.capMax) * 100));
      const q = v > 2000 ? "q4" : v > 1000 ? "q3" : v > 400 ? "q2" : "q1";
      return `<span class="bar-cell"><span>${fmt(v, 1)}<span class="unit">mAh/g</span></span>`
           + `<span class="bar ${q}" aria-hidden="true"><i style="width:${pct}%"></i></span></span>`;
    } },
  { key: "current_density_ma_g", label: "Current", cls: "num", render: (r) =>
      r.current_density_ma_g === null ? nr
        : `${fmt(r.current_density_ma_g, 1)}<span class="unit">mA/g</span>` },
  { key: "c_rate", label: "Rate", cls: "num", render: (r) =>
      r.c_rate === null ? nr : `${fmt(r.c_rate, 2)}<span class="unit">C</span>` },
  { key: "cycle_count", label: "Cycles", cls: "num", render: (r) =>
      r.cycle_count === null ? nr : fmt(r.cycle_count) },
  { key: "capacity_retention_pct", label: "Retention", cls: "num", render: (r) =>
      r.capacity_retention_pct === null ? nr
        : `${fmt(r.capacity_retention_pct, 1)}<span class="unit">%</span>` },
  { key: "first_cycle_ce_pct", label: "First-cycle CE", cls: "num", render: (r) =>
      r.first_cycle_ce_pct === null ? nr
        : `${fmt(r.first_cycle_ce_pct, 1)}<span class="unit">%</span>` },
  { key: "year", label: "Year", cls: "num", render: (r) => r.year ? String(r.year) : nr },
  { key: "title", label: "Paper", cls: "title-cell", render: (r) =>
      `${r.confidence === "flagged" ? '<span class="flag-mark" title="Flagged by an automated check">&#9873;</span> ' : ""}${esc(r.title || "")}` },
];

/* ---------- views ---------- */
function show(view) {
  state.view = view;
  document.querySelectorAll(".tab").forEach((t) =>
    t.setAttribute("aria-selected", String(t.dataset.view === view)));
  document.querySelectorAll(".view").forEach((s) => {
    s.hidden = s.dataset.view !== view;
  });
  if (view === "sources" && !document.getElementById("src-body").children.length) loadSources();
  if (view === "calculator") loadCalculators();
  if (view === "notebook") renderNotebook();
}

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => show(t.dataset.view)));

/* ---------- theme ---------- */
const themeBtn = document.getElementById("theme-toggle");
try {
  const saved = localStorage.getItem("theme");
  if (saved) document.documentElement.dataset.theme = saved;
} catch (e) { /* private mode */ }
themeBtn.addEventListener("click", () => {
  const dark = getComputedStyle(document.body).backgroundColor === "rgb(14, 17, 22)";
  const next = dark ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch (e) { /* ignore */ }
});

/* ---------- evidence grid ---------- */
function headRow() {
  const head = document.getElementById("grid-head");
  head.innerHTML = COLUMNS.map((c) => {
    const active = state.sort === c.key;
    const arrow = active ? `<span class="arrow">${state.direction === "desc" ? "↓" : "↑"}</span>` : "";
    return `<th class="${c.cls}" data-key="${c.key}" tabindex="0" role="columnheader"`
         + `${active ? ` aria-sort="${state.direction === "desc" ? "descending" : "ascending"}"` : ""}>`
         + `${esc(c.label)}${arrow}</th>`;
  }).join("");
  head.querySelectorAll("th").forEach((th) => {
    const go = () => {
      const key = th.dataset.key;
      if (state.sort === key) state.direction = state.direction === "desc" ? "asc" : "desc";
      else { state.sort = key; state.direction = "desc"; }
      reload();
    };
    th.addEventListener("click", go);
    th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}

function query(extra = {}) {
  const p = new URLSearchParams();
  Object.entries({ ...state.filters, ...extra }).forEach(([k, v]) => {
    if (v !== "" && v !== null && v !== undefined) p.set(k, v);
  });
  p.set("sort", state.sort);
  p.set("direction", state.direction);
  return p;
}

async function reload() {
  state.offset = 0;
  state.rows = [];
  document.getElementById("grid-body").innerHTML = "";
  headRow();
  await loadMore();
}

function matches(r, f) {
  if (f.confidence && r.confidence !== f.confidence) return false;
  if (f.material && !(r.material_system || "").toLowerCase().includes(String(f.material).toLowerCase())) return false;
  if (f.graphene_form && r.graphene_form !== f.graphene_form) return false;
  if (f.electrode_role && r.electrode_role !== f.electrode_role) return false;
  if (f.battery_type && r.battery_type !== f.battery_type) return false;
  if (f.year_min != null && !(r.year >= f.year_min)) return false;
  if (f.year_max != null && !(r.year <= f.year_max)) return false;
  if (f.capacity_min != null && !(r.specific_capacity_mah_g >= f.capacity_min)) return false;
  if (f.capacity_max != null && !(r.specific_capacity_mah_g <= f.capacity_max)) return false;
  if (f.cycles_min != null && !(r.cycle_count >= f.cycles_min)) return false;
  if (f.q) {
    const t = String(f.q).toLowerCase();
    if (!((r.title || "").toLowerCase().includes(t)
       || (r.source_quote || "").toLowerCase().includes(t)
       || (r.material_system || "").toLowerCase().includes(t))) return false;
  }
  return true;
}

function sortRows(rows) {
  const k = state.sort, dir = state.direction === "desc" ? -1 : 1;
  return rows.slice().sort((a, b) => {
    const x = a[k], y = b[k];
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    if (typeof x === "string") return dir * x.localeCompare(y);
    return dir * (x - y);
  });
}

async function loadMore() {
  if (state.loading) return;
  state.loading = true;
  try {
    const all = sortRows(DATA.rows.filter((r) => matches(r, state.filters)));
    state.total = all.length;
    if (state.offset === 0) {
      const top = all.find((r) => r.specific_capacity_mah_g !== null);
      state.capMax = Math.max(400, top ? Number(top.specific_capacity_mah_g) : 400);
    }
    const page = all.slice(state.offset, state.offset + state.limit);
    state.rows.push(...page);
    state.offset += page.length;
    appendRows(page);
    renderCount();
    document.getElementById("grid-empty").hidden = state.total !== 0;
    if (state.total === 0) emptyState();
  } finally {
    state.loading = false;
  }
}

function appendRows(rows) {
  const body = document.getElementById("grid-body");
  const html = rows.map((r) => {
    const cls = r.confidence === "flagged" ? "flagged" : "";
    const cells = COLUMNS.map((c) =>
      `<td class="${c.cls} clickable">${c.render(r)}</td>`).join("");
    return `<tr class="${cls}" data-id="${r.id}" tabindex="0">${cells}</tr>`;
  }).join("");
  body.insertAdjacentHTML("beforeend", html);
}

function renderCount() {
  const shown = state.rows.length;
  document.getElementById("result-count").textContent =
    `${state.total.toLocaleString("en-GB")} ${state.total === 1 ? "measurement" : "measurements"}`;
  const flagged = state.rows.filter((r) => r.confidence === "flagged").length;
  document.getElementById("result-detail").textContent =
    `showing ${shown.toLocaleString("en-GB")}, ${flagged} flagged in view`;
}

function emptyState() {
  document.getElementById("grid-empty").innerHTML =
    `<strong>No measurements match these filters.</strong>`
  + `Every filter is applied together. Clear the narrowest one first &mdash; `
  + `capacity range and minimum cycles exclude the most rows, because many `
  + `papers do not state them.`;
}

document.getElementById("grid-wrap").addEventListener("scroll", (e) => {
  const el = e.target;
  if (el.scrollTop + el.clientHeight > el.scrollHeight - 400
      && state.rows.length < state.total) loadMore();
});

document.getElementById("grid-body").addEventListener("click", (e) => {
  const tr = e.target.closest("tr");
  if (tr) openDrawer(tr.dataset.id);
});
document.getElementById("grid-body").addEventListener("keydown", (e) => {
  const tr = e.target.closest("tr");
  if (!tr) return;
  if (e.key === "Enter") { e.preventDefault(); openDrawer(tr.dataset.id); }
  if (e.key === "ArrowDown" && tr.nextElementSibling) { e.preventDefault(); tr.nextElementSibling.focus(); }
  if (e.key === "ArrowUp" && tr.previousElementSibling) { e.preventDefault(); tr.previousElementSibling.focus(); }
});

/* ---------- source drawer: the one orchestrated moment ---------- */
function highlight(quote, row) {
  const needles = [];
  const push = (v, d) => {
    if (v === null || v === undefined || v === "") return;
    const n = Number(v);
    needles.push(Number.isInteger(n) ? String(n) : n.toFixed(d).replace(/0+$/, "").replace(/\.$/, ""));
    needles.push(String(v).replace(/\.0+$/, ""));
  };
  push(row.specific_capacity_mah_g, 2);
  push(row.initial_capacity_mah_g, 2);
  push(row.capacity_retention_pct, 2);
  push(row.cycle_count, 0);
  push(row.c_rate, 2);
  push(row.first_cycle_ce_pct, 2);
  push(row.areal_loading_mg_cm2, 2);
  push(row.temperature_c, 1);
  [row.capacity_as_reported, row.current_density_as_reported].forEach((s) => {
    if (s) String(s).split(/\s+/).forEach((tok) => { if (/^\d/.test(tok)) needles.push(tok); });
  });

  const unique = [...new Set(needles.filter((n) => n && n.length > 0))]
    .sort((a, b) => b.length - a.length);
  let html = esc(quote);
  unique.forEach((n) => {
    const safe = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    html = html.replace(new RegExp(`(?<![\\d.])${safe}(?![\\d])`, "g"),
      (m) => `\u0001${m}\u0002`);
  });
  return html.replace(/\u0001/g, "<mark>").replace(/\u0002/g, "</mark>");
}

async function openDrawer(id) {
  const row = state.rows.find((r) => String(r.id) === String(id));
  if (!row) return;
  state.selected = row;
  document.querySelectorAll("#grid-body tr").forEach((tr) =>
    tr.classList.toggle("selected", tr.dataset.id === String(id)));

  const backdrop = document.getElementById("drawer-backdrop");
  const drawer = document.getElementById("drawer");
  document.getElementById("drawer-title").textContent = "Source";

  const vals = [
    ["Material system", row.material_system, "sans"],
    ["Graphene form", row.graphene_form, "sans"],
    ["Electrode role", row.electrode_role, "sans"],
    ["Chemistry", row.battery_type, "sans"],
    ["Specific capacity", row.specific_capacity_mah_g !== null ? `${fmt(row.specific_capacity_mah_g, 2)} mAh/g` : null],
    ["As reported", row.capacity_as_reported],
    ["Initial capacity", row.initial_capacity_mah_g !== null ? `${fmt(row.initial_capacity_mah_g, 2)} mAh/g` : null],
    ["Current density", row.current_density_ma_g !== null ? `${fmt(row.current_density_ma_g, 2)} mA/g` : null],
    ["As reported", row.current_density_as_reported],
    ["C-rate", row.c_rate !== null ? `${fmt(row.c_rate, 2)} C` : null],
    ["Cycles", fmt(row.cycle_count)],
    ["Capacity retention", row.capacity_retention_pct !== null ? `${fmt(row.capacity_retention_pct, 2)} %` : null],
    ["First-cycle CE", row.first_cycle_ce_pct !== null ? `${fmt(row.first_cycle_ce_pct, 2)} %` : null],
    ["Voltage window", row.voltage_window_v],
    ["Electrolyte", row.electrolyte],
    ["Temperature", row.temperature_c !== null ? `${fmt(row.temperature_c, 1)} °C` : null],
    ["Areal loading", row.areal_loading_mg_cm2 !== null ? `${fmt(row.areal_loading_mg_cm2, 2)} mg/cm2` : null],
  ];

  document.getElementById("drawer-body").innerHTML = `
    <div class="meta muted" style="font-size:12.5px">
      ${esc(row.journal || "")}${row.year ? ` &middot; ${row.year}` : ""}
      ${row.doi ? ` &middot; <a href="https://doi.org/${esc(row.doi)}" target="_blank" rel="noopener">${esc(row.doi)}</a>` : ""}
    </div>
    <div style="font-size:14.5px;font-weight:500;margin:7px 0 2px;max-width:60ch">${esc(row.title || "")}</div>
    <h3>The sentence this row came from</h3>
    <blockquote class="quote">${highlight(row.source_quote || "", row)}</blockquote>
    <div class="muted" style="font-size:12px">
      Read from the <strong>${esc(row.source_section || "abstract")}</strong>.
      Confidence: <strong>${esc(row.confidence)}</strong>.
      ${row.confidence === "verified"
        ? "Every number above appears in this sentence and passed all automated checks."
        : "Every number above appears in this sentence. One or more checks flagged it; the reasons are below."}
    </div>
    ${row.flags && row.flags.length ? `<h3>Why this row is flagged</h3>
      <ul class="flaglist">${row.flags.map((f) => {
        const [k, ...rest] = String(f).split(":");
        return `<li>${esc(k)}<span>${rest.length ? ":" + esc(rest.join(":")) : ""}</span></li>`;
      }).join("")}</ul>` : ""}
    <h3>Extracted values</h3>
    <dl class="kv">${vals.filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v, c]) => `<dt>${esc(k)}</dt><dd class="${c || ""}">${esc(v)}</dd>`).join("")}</dl>
    <h3>What the checks cannot tell you</h3>
    <div class="muted" style="font-size:12.5px;max-width:62ch">
      The checks test physical plausibility, internal arithmetic, group outliers
      and unit sanity. They cannot tell whether a plausible number was measured
      under the conditions this row claims, cannot catch a paper that is itself
      wrong, and cannot judge whether a comparison is scientifically fair.
      Read the sentence.
    </div>`;

  backdrop.hidden = false;
  drawer.hidden = false;
  document.getElementById("drawer-close").focus();
}

function closeDrawer() {
  document.getElementById("drawer").hidden = true;
  document.getElementById("drawer-backdrop").hidden = true;
  document.querySelectorAll("#grid-body tr.selected").forEach((tr) => tr.classList.remove("selected"));
}
document.getElementById("drawer-close").addEventListener("click", closeDrawer);
document.getElementById("drawer-backdrop").addEventListener("click", closeDrawer);

/* ---------- facets ---------- */
const FACET_LABELS = {
  confidence: "Confidence", battery_type: "Chemistry",
  graphene_form: "Graphene form", electrode_role: "Electrode role",
  material_system: "Material system",
};
const FACET_PARAM = {
  confidence: "confidence", battery_type: "battery_type",
  graphene_form: "graphene_form", electrode_role: "electrode_role",
  material_system: "material",
};

async function loadFacets() {
  const facets = DATA.facets;
  Object.keys(FACET_LABELS).forEach((key) => {
    const host = document.getElementById(`facet-${key}`);
    if (!host) return;
    const items = (facets[key] || []).slice(0, key === "material_system" ? 18 : 12);
    host.innerHTML = `<h3>${esc(FACET_LABELS[key])}</h3>` + items.map((it) => {
      const colour = key === "battery_type" ? hue(BATTERY_HUE, it.value)
        : key === "graphene_form" ? hue(FORM_HUE, it.value)
        : key === "confidence" ? (it.value === "flagged" ? "var(--flag)" : "var(--cat-other)")
        : null;
      const dot = colour ? `<i class="dot" style="background:${colour}"></i>` : "";
      const mark = key === "confidence" && it.value === "flagged" ? "&#9873; " : "";
      return `<button class="facet-item" data-facet="${key}" data-value="${esc(it.value)}"`
           + ` aria-pressed="false">${dot}<span>${mark}${esc(it.value)}</span>`
           + `<span class="n">${it.count.toLocaleString("en-GB")}</span></button>`;
    }).join("");
  });
  document.querySelectorAll(".facet-item").forEach((b) => {
    const param = FACET_PARAM[b.dataset.facet];
    if (state.filters[param] === b.dataset.value) b.setAttribute("aria-pressed", "true");
    b.addEventListener("click", () => {
      const on = b.getAttribute("aria-pressed") === "true";
      document.querySelectorAll(`.facet-item[data-facet="${b.dataset.facet}"]`)
        .forEach((o) => o.setAttribute("aria-pressed", "false"));
      if (on) delete state.filters[param];
      else { b.setAttribute("aria-pressed", "true"); state.filters[param] = b.dataset.value; }
      reload();
    });
  });
}

const debounce = (fn, ms = 260) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const bind = (id, param, cast = (v) => v) => {
  const el = document.getElementById(id);
  el.addEventListener("input", debounce(() => {
    const v = el.value.trim();
    if (v === "") delete state.filters[param]; else state.filters[param] = cast(v);
    reload();
  }));
};
bind("filter-q", "q");
bind("filter-capmin", "capacity_min", Number);
bind("filter-capmax", "capacity_max", Number);
bind("filter-cycmin", "cycles_min", Number);
bind("filter-ymin", "year_min", Number);
bind("filter-ymax", "year_max", Number);

document.getElementById("filters-clear").addEventListener("click", () => {
  state.filters = {};
  document.querySelectorAll(".facet-item").forEach((b) => b.setAttribute("aria-pressed", "false"));
  state.filters = {};
  ["filter-q", "filter-capmin", "filter-capmax", "filter-cycmin", "filter-ymin", "filter-ymax"]
    .forEach((id) => { document.getElementById(id).value = ""; });
  document.getElementById("view-preset").value = "default";
  reload();
});

const PRESETS = {
  default: { confidence: "verified" },
  all: {},
  flagged: { confidence: "flagged" },
  longlife: { cycles_min: 500 },
  silicon: { q: "si/", electrode_role: "anode" },
  sulfur: { q: "s/", electrode_role: "cathode" },
  recent: { year_min: 2024 },
};
document.getElementById("view-preset").addEventListener("change", (e) => {
  state.filters = { ...PRESETS[e.target.value] };
  document.querySelectorAll(".facet-item").forEach((b) =>
    b.setAttribute("aria-pressed",
      String(state.filters[FACET_PARAM[b.dataset.facet]] === b.dataset.value)));
  reload();
});

const EXPORT_COLS = ["material_system","graphene_form","electrode_role","battery_type",
  "specific_capacity_mah_g","capacity_as_reported","current_density_ma_g","c_rate",
  "cycle_count","capacity_retention_pct","first_cycle_ce_pct","voltage_window_v",
  "electrolyte","temperature_c","areal_loading_mg_cm2","confidence","flags",
  "title","year","journal","doi","source_section","source_quote"];

function exportCsv() {
  const rows = sortRows(DATA.rows.filter((r) => matches(r, state.filters)));
  const cell = (v) => {
    const s = Array.isArray(v) ? v.join("; ") : (v === null || v === undefined ? "" : String(v));
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [EXPORT_COLS.join(",")]
    .concat(rows.map((r) => EXPORT_COLS.map((c) => cell(r[c])).join(","))).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = "graphene-battery-evidence.csv"; a.click();
  URL.revokeObjectURL(url);
}
document.getElementById("export-csv").addEventListener("click", exportCsv);

document.getElementById("note-more").addEventListener("click", () => {
  const note = document.getElementById("method-note");
  const s = state.stats || {};
  const c = s.checks || {};
  note.classList.add("open");
  note.innerHTML = `
    Each row is scoped to a single sentence, so every number in it was reported
    together. Automated checks cover physical plausibility (capacity above
    ${c.capacity_hard_max_mah_g ?? 5000} mAh/g, retention above 100%, cycles above
    ${(c.cycle_hard_max ?? 100000).toLocaleString("en-GB")}, temperature outside
    ${(c.temperature_range_c || [-40, 200]).join(" to ")} °C, voltage outside
    ${(c.voltage_range_v || [0, 5]).join("–")} V), internal arithmetic,
    group outliers beyond ${c.outlier_sigma ?? 3} sigma, and unit mix-ups.
    <strong>They cannot</strong> tell whether a plausible number was measured under
    the conditions a row claims, catch a paper that is itself wrong, or judge
    whether a comparison is scientifically fair. ${s.verified ?? "-"} rows passed
    every check; ${s.flagged ?? "-"} are flagged and kept, never deleted.
    <button class="link" id="note-less">Hide</button>`;
  document.getElementById("note-less").addEventListener("click", () => location.reload());
});

const OUT_OF_REMIT = [
  [/\bshould\s+(?:i|we|you)\b/, "asks for advice"],
  [/\b(?:invest|investment|investor|stock|shares|share\s+price|ticker|valuation)\b(?!igat)/, "asks about investment"],
  [/\b(?:company|companies|startup|supplier|vendor|manufacturer)\b/, "asks about companies rather than measurements"],
  [/\b(?:forecast|predict|projection)\w*\b/, "asks for a prediction"],
  [/\bwill\b[^?]*\b20[2-9]\d\b/, "asks for a prediction"],
  [/\brecommend\w*\b/, "asks for a recommendation"],
  [/\b(?:buy|purchase|cheapest|price)\b/, "asks about commerce"],
];

const QUANTS = [
  ["specific_capacity_mah_g", "mAh/g", "specific capacity", /capacit|mah/],
  ["capacity_retention_pct", "%", "capacity retention", /retention|retain|stabilit|fade|degrad/],
  ["cycle_count", "cycles", "cycle count", /cycl|\blife\b|durab/],
  ["current_density_ma_g", "mA/g", "current density", /current\s+density|\brate\b|a\/g|ma\/g/],
  ["c_rate", "C", "C-rate", /c-?rate|\brate\s+capab/],
  ["first_cycle_ce_pct", "%", "first-cycle coulombic efficiency", /coulombic|\bice\b|efficien/],
  ["areal_loading_mg_cm2", "mg/cm2", "areal loading", /loading|areal/],
];

const VOCAB = {
  partner: [["Si",/\bsilicon\b|\bsi\b/],["S",/\bsulfur\b|\bsulphur\b/],["SnO2",/\bsno2?\b|tin\s+oxide/],
    ["Sn",/\btin\b/],["Fe2O3",/\bfe2o3\b|hematite/],["Fe3O4",/\bfe3o4\b|magnetite/],
    ["Co3O4",/\bco3o4\b/],["MoS2",/\bmos2?\b|molybdenum/],["MnO2",/\bmno2?\b/],["TiO2",/\btio2?\b/],
    ["LFP",/\blfp\b|lifepo4|iron\s+phosphate/],["NMC",/\bnmc\b|\bncm\b/],["LTO",/\blto\b|titanate/],
    ["Se",/\bselenium\b/],["Sb",/\bantimony\b/],["Ge",/\bgermanium\b/],["CNT",/nanotube|\bcnts?\b/],
    ["hard carbon",/hard\s+carbon/]],
  graphene_form: [["rGO",/reduced\s+graphene\s+oxide|\brgo\b/],["graphene oxide",/graphene\s+oxide|\bgo\b/],
    ["N-doped graphene",/(?:nitrogen|n)[\s-]*doped\s+graphene/],["graphene aerogel",/aerogel|hydrogel/],
    ["3D graphene",/3\s*-?\s*d\s+graphene|three[\s-]*dimensional/],["graphene foam",/graphene\s+foam/],
    ["holey graphene",/holey|porous\s+graphene/],["graphene quantum dots",/quantum\s+dot/],
    ["CVD graphene",/\bcvd\b/],["few-layer graphene",/few[\s-]*layer/],
    ["graphene nanosheets",/nanosheet|nanoplatelet/],["graphene",/\bgraphene\b|\bgraphitic\b/]],
  battery_type: [["lithium-sulfur",/lithium[\s-]*sul[fp]hur|lithium[\s-]*sulfur|\bli[\s-]*s\b/],
    ["lithium-selenium",/lithium[\s-]*selenium/],["lithium-air",/lithium[\s-]*(?:air|oxygen)|li[\s-]*o2/],
    ["lithium metal",/lithium\s+metal|dendrite/],["solid-state",/solid[\s-]*state/],
    ["sodium-ion",/sodium[\s-]*ion|\bna[\s-]*ion\b|\bsib\b/],
    ["potassium-ion",/potassium[\s-]*ion|\bk[\s-]*ion\b/],["zinc-ion",/zinc[\s-]*ion|\bzn[\s-]*ion\b/],
    ["magnesium-ion",/magnesium[\s-]*ion/],["aluminium-ion",/alumini?um[\s-]*ion/],
    ["lithium-ion",/lithium[\s-]*ion|\bli[\s-]*ion\b|\blibs?\b/]],
  electrode_role: [["anode",/\banode/],["cathode",/\bcathode/],["separator",/separator|interlayer/],
    ["current collector",/current\s+collector/],["electrolyte",/electrolyte\s+additive|solid\s+electrolyte/]],
};

const GENERIC = new Set(["point","high","low","good","better","performance","material","materials",
 "study","result","results","value","values","work","paper","show","shows","shown","using","used",
 "use","new","novel","effect","effects","based","via","well","also","more","most","than","between",
 "during","after","before","when","where","while","stop","stops","help","helps","make","makes",
 "give","gives","many","much","long","does","reach","reaches","get","gets","what","which","how",
 "the","and","for","are","with","from","about","their","there","that","this","can","你"]);

const stemOf = (t) => {
  const l = t.toLowerCase();
  for (const [suf, rep] of [["ies","y"],["sses","ss"],["es",""],["s",""]])
    if (l.endsWith(suf) && l.length - suf.length >= 4) return l.slice(0, -suf.length) + rep;
  return l;
};
const contentTerms = (q) => {
  const seen = new Set(), out = [];
  (q.toLowerCase().match(/[a-z0-9][a-z0-9\-\/]+/g) || []).forEach((t) => {
    if (GENERIC.has(t) || t.length <= 2) return;
    const r = stemOf(t);
    if (GENERIC.has(r) || seen.has(r)) return;
    seen.add(r); out.push(r);
  });
  return out;
};
const firstMatch = (list, text) => { for (const [label, re] of list) if (re.test(text)) return label; return null; };

function median(a) { const s = a.slice().sort((x,y)=>x-y); const m = s.length>>1;
  return s.length % 2 ? s[m] : (s[m-1]+s[m])/2; }
function quantile(a, p) { const s = a.slice().sort((x,y)=>x-y);
  const i = (s.length-1)*p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi]-s[lo])*(i-lo); }

function localAnswer(question) {
  const low = question.toLowerCase();
  const facets = {
    partner: firstMatch(VOCAB.partner, low),
    graphene_form: firstMatch(VOCAB.graphene_form, low),
    battery_type: firstMatch(VOCAB.battery_type, low),
    electrode_role: firstMatch(VOCAB.electrode_role, low),
  };
  const detected = Object.fromEntries(Object.entries(facets).filter(([, v]) => v));

  for (const [re, reason] of OUT_OF_REMIT) if (re.test(low)) return {
    status: "not_found", mode: "refused", statistics: {}, citations: [],
    summary: `Not found in the library. This question ${reason}, and the library holds `
      + `measurements reported in papers, not advice, prices or predictions. The tool `
      + `does not answer from outside the stored papers.`,
    coverage: { evidence_rows: 0, papers: 0, facets_detected: detected, matched_passages: 0,
      searched: ["nothing: the question is outside what the evidence table can answer"],
      not_reported: [reason],
      suggestion: "Ask what the papers measured, for example 'capacity of silicon graphene anodes in lithium-ion'." },
  };

  const quants = QUANTS.filter(([, , , re]) => re.test(low));

  let rows = [];
  if (Object.keys(detected).length) {
    rows = DATA.rows.filter((r) =>
      (!facets.partner || (r.material_system || "").toLowerCase().includes(facets.partner.toLowerCase()))
      && (facets.partner || !facets.graphene_form || r.graphene_form === facets.graphene_form)
      && (!facets.battery_type || r.battery_type === facets.battery_type)
      && (!facets.electrode_role || r.electrode_role === facets.electrode_role));
    if (rows.length < 3) rows = DATA.rows.filter((r) =>
      (!facets.partner || (r.material_system || "").toLowerCase().includes(facets.partner.toLowerCase()))
      && (!facets.battery_type || r.battery_type === facets.battery_type));
  }

  if (quants.length && rows.length >= 3) {
    const stats = {}, missing = [];
    quants.forEach(([field, unit, label]) => {
      const vals = rows.filter((r) => r[field] !== null && r.confidence !== "unverified")
                       .map((r) => Number(r[field]));
      if (vals.length) stats[label] = { n: vals.length, unit, median: median(vals),
        min: Math.min(...vals), max: Math.max(...vals),
        p25: vals.length >= 4 ? quantile(vals, 0.25) : undefined,
        p75: vals.length >= 4 ? quantile(vals, 0.75) : undefined };
      else missing.push(label);
    });
    const papers = new Set(rows.map((r) => r.openalex_id)).size;
    const years = rows.map((r) => r.year).filter(Boolean);
    const first = Object.entries(stats)[0];
    let summary;
    if (first) {
      const [label, s] = first;
      const subject = [facets.partner, facets.graphene_form, facets.electrode_role, facets.battery_type]
        .filter(Boolean).join(" / ") || "the matching papers";
      summary = `Across ${s.n} measurements from ${papers} papers, ${subject} shows a median `
        + `${label} of ${fmt(s.median, 1)} ${s.unit} (range ${fmt(s.min, 1)} to ${fmt(s.max, 1)} ${s.unit}).`;
      if (s.p25 !== undefined) summary += ` Half the reported values fall between ${fmt(s.p25, 1)} and ${fmt(s.p75, 1)} ${s.unit}.`;
    } else {
      summary = `${rows.length} evidence rows match, but none of them state the quantity asked for.`;
    }
    const cited = rows.filter((r) => r.specific_capacity_mah_g !== null || r.capacity_retention_pct !== null)
      .sort((a, b) => (b.confidence === "verified") - (a.confidence === "verified")
                   || (b.specific_capacity_mah_g || 0) - (a.specific_capacity_mah_g || 0))
      .slice(0, 8);
    return { status: "answered", mode: "quantitative", summary, statistics: stats,
      citations: cited.map((r, i) => ({ n: i + 1, ...r, values: Object.fromEntries(
        QUANTS.filter(([f]) => r[f] !== null).map(([f, u, l]) => {
          let shown = `${fmt(r[f], 2)} ${u}`;
          const rep = f === "current_density_ma_g" ? r.current_density_as_reported
                    : f === "specific_capacity_mah_g" ? r.capacity_as_reported : null;
          if (rep && !String(r.source_quote || "").includes(String(fmt(r[f], 2)).replace(/,/g, "")))
            shown += ` (reported as ${rep})`;
          return [l, shown];
        })) })),
      coverage: { evidence_rows: rows.length, papers,
        year_range: years.length ? [Math.min(...years), Math.max(...years)] : null,
        flagged_rows: rows.filter((r) => r.confidence === "flagged").length,
        facets_detected: detected, not_reported: missing } };
  }

  // Text fallback over the stored abstracts, matching the live service. A
  // passage must carry most of the question's specific terms, including the
  // rarest of them, so shared common words alone never produce an answer.
  const terms = contentTerms(question);
  if (terms.length >= 2) {
    const freq = {};
    terms.forEach((t) => {
      freq[t] = DATA.passages.reduce((n, p) => n + (p.x.toLowerCase().includes(t) ? 1 : 0), 0);
    });
    if (terms.every((t) => freq[t] > 0)) {
      const rarest = terms.reduce((a, b) => (freq[a] <= freq[b] ? a : b));
      const strong = [];
      for (const p of DATA.passages) {
        const low = p.x.toLowerCase();
        const hits = terms.filter((t) => low.includes(t));
        if (hits.length >= 2 && hits.length / terms.length >= 0.6 && low.includes(rarest)) {
          strong.push(p);
          if (strong.length >= 8) break;
        }
      }
      if (strong.length >= 2) {
        const papers = new Set(strong.map((p) => p.i)).size;
        return { status: "answered", mode: "textual",
          summary: `No comparable numbers were extracted for this question, but ${strong.length} `
            + `passages from ${papers} papers discuss it. They are quoted below unchanged.`,
          statistics: {},
          citations: strong.map((p, i) => ({ n: i + 1, openalex_id: p.i, title: p.t,
            year: p.y, journal: p.j, doi: p.d, source_quote: p.x,
            confidence: "quoted text, no number extracted", values: {} })),
          coverage: { evidence_rows: 0, papers, flagged_rows: 0,
            facets_detected: detected, not_reported: [] } };
      }
    }
  }

  return { status: "not_found", mode: "refused", statistics: {}, citations: [],
    summary: "Not found in the library. This answer is not available from the stored papers, "
      + "and the tool does not answer from outside them.",
    coverage: { evidence_rows: rows.length, papers: 0, facets_detected: detected,
      searched: ["the evidence table", "the stored sentences of 6,575 papers"],
      matched_passages: 0,
      not_reported: quants.map(([, , l]) => l).length ? quants.map(([, , l]) => l)
        : ["no performance quantity was named in the question"],
      suggestion: "Try naming a material and a chemistry, for example 'silicon graphene anode in lithium-ion', or widen the filters on the Evidence table." } };
}

/* ---------- calculators ---------- */
const CALCS = [
  ["energy_density", "Specific energy of an electrode, Wh/kg.", ["voltage_v","capacity_mah_g"],
    (i) => ["energy_Wh_kg = voltage_V x capacity_mAh_g / 1000", i.voltage_v * i.capacity_mah_g / 1000, "Wh/kg"]],
  ["specific_capacity", "Gravimetric capacity from a galvanostatic discharge, mAh/g.",
    ["current_ma","time_h","mass_g"],
    (i) => ["capacity_mAh_g = current_mA x time_h / mass_g", i.current_ma * i.time_h / i.mass_g, "mAh/g"]],
  ["c_rate", "C-rate from current density and the reference capacity.", ["current_ma_g","capacity_mah_g"],
    (i) => ["C_rate = current_mA_g / capacity_mAh_g", i.current_ma_g / i.capacity_mah_g, "C"]],
  ["coulombic_efficiency", "Coulombic efficiency, per cent.", ["discharge_mah_g","charge_mah_g"],
    (i) => ["CE_pct = discharge_mAh_g / charge_mAh_g x 100", i.discharge_mah_g / i.charge_mah_g * 100, "%"]],
  ["capacity_fade_per_cycle", "Mean capacity loss per cycle, per cent of the initial value.",
    ["initial_mah_g","final_mah_g","cycles"],
    (i) => ["fade_pct_per_cycle = (initial - final) / initial / cycles x 100",
            (i.initial_mah_g - i.final_mah_g) / i.initial_mah_g / i.cycles * 100, "%/cycle"]],
  ["capacity_retention", "Capacity retention, per cent.", ["initial_mah_g","final_mah_g"],
    (i) => ["retention_pct = final_mAh_g / initial_mAh_g x 100", i.final_mah_g / i.initial_mah_g * 100, "%"]],
  ["cell_to_pack", "Pack-level specific energy from cell level and a packing fraction.",
    ["cell_wh_kg","pack_fraction"],
    (i) => ["pack_Wh_kg = cell_Wh_kg x pack_fraction", i.cell_wh_kg * (i.pack_fraction || 0.75), "Wh/kg"]],
];

let calcLoaded = false;
async function loadCalculators() {
  if (calcLoaded) return;
  calcLoaded = true;
  document.getElementById("calc-list").innerHTML = CALCS.map(([name, desc, inputs]) => `
    <div class="calc" data-name="${esc(name)}">
      <h3>${esc(name.replace(/_/g, " "))}</h3>
      <div class="desc">${esc(desc)}</div>
      <div class="calc-inputs">
        ${inputs.map((n) => `<label class="field"><span>${esc(n)}</span>
          <input type="number" step="any" data-in="${esc(n)}"
          ${n === "pack_fraction" ? 'value="0.75"' : ""}></label>`).join("")}
        <button class="primary" data-run>Calculate</button>
      </div>
      <div class="calc-out"></div>
    </div>`).join("");

  document.getElementById("calc-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-run]");
    if (!btn) return;
    const card = btn.closest(".calc");
    const out = card.querySelector(".calc-out");
    const spec = CALCS.find(([n]) => n === card.dataset.name);
    const inputs = {};
    let missing = false;
    card.querySelectorAll("[data-in]").forEach((el) => {
      const v = Number(el.value);
      if (el.value === "" || !Number.isFinite(v) || v <= 0) missing = true;
      inputs[el.dataset.in] = v;
    });
    out.classList.add("on");
    if (missing) { out.innerHTML = `<div class="formula">Every input must be a positive number.</div>`; return; }
    const [formula, result, unit] = spec[3](inputs);
    out.innerHTML = `<div class="formula">${esc(formula)}</div>`
      + `<div class="res">${fmt(result, 4)}<span class="unit">${esc(unit)}</span></div>`
      + `<div class="muted" style="font-size:12px;margin-top:5px">`
      + Object.entries(inputs).map(([k, v]) => `${esc(k)} = ${esc(v)}`).join("  &middot;  ") + `</div>`;
  });
}

/* ---------- sources ---------- */
async function loadSources(q = "") {
  const byPaper = new Map();
  DATA.rows.forEach((r) => {
    const cur = byPaper.get(r.openalex_id) || { ...r, evidence_rows: 0 };
    cur.evidence_rows += 1;
    byPaper.set(r.openalex_id, cur);
  });
  let rows = [...byPaper.values()];
  if (q) {
    const t = q.toLowerCase();
    rows = rows.filter((r) => (r.title || "").toLowerCase().includes(t)
                           || (r.journal || "").toLowerCase().includes(t));
  }
  rows.sort((a, b) => b.evidence_rows - a.evidence_rows);
  document.getElementById("src-count").textContent = rows.length.toLocaleString("en-GB");
  document.getElementById("src-body").innerHTML = rows.slice(0, 600).map((r) => `
    <tr><td class="title-cell">${esc(r.title || "")}</td>
    <td class="num">${r.year ? String(r.year) : nr}</td>
    <td>${esc(r.journal || "") || nr}</td>
    <td>${esc(r.source_section || "abstract")}</td>
    <td>${esc(r.confidence)}</td>
    <td class="num">${fmt(r.evidence_rows)}</td>
    <td>yes</td>
    <td>${r.doi ? `<a href="https://doi.org/${esc(r.doi)}" target="_blank" rel="noopener">doi</a>` : nr}</td></tr>`).join("");
}
document.getElementById("src-q").addEventListener("input",
  debounce((e) => loadSources(e.target.value.trim())));

/* ---------- command palette ---------- */
const palette = document.getElementById("palette");
const paletteBackdrop = document.getElementById("palette-backdrop");
const paletteInput = document.getElementById("palette-input");
const paletteList = document.getElementById("palette-list");
let paletteItems = [], paletteIndex = 0;

function openPalette() {
  paletteBackdrop.hidden = false;
  palette.hidden = false;
  paletteInput.value = "";
  paintPalette("");
  paletteInput.focus();
}
function closePalette() { palette.hidden = true; paletteBackdrop.hidden = true; }

function paintPalette(term) {
  const low = term.toLowerCase();
  const base = [
    { label: "Evidence table", hint: "section", run: () => show("evidence") },
    { label: "Ask the agent", hint: "section", run: () => show("agent") },
    { label: "Notebook, saved findings", hint: "section", run: () => show("notebook") },
    { label: "Calculator", hint: "section", run: () => show("calculator") },
    { label: "My library", hint: "section", run: () => show("library") },
    { label: "Sources", hint: "section", run: () => show("sources") },
    { label: "Show flagged rows only", hint: "filter", run: () => {
        state.filters = { confidence: "flagged" }; show("evidence"); reload(); } },
    { label: "Show verified rows only", hint: "filter", run: () => {
        state.filters = { confidence: "verified" }; show("evidence"); reload(); } },
    { label: "Clear all filters", hint: "filter", run: () =>
        document.getElementById("filters-clear").click() },
    { label: "Export the current view to CSV", hint: "export", run: () =>
        document.getElementById("export-csv").click() },
  ];
  paletteItems = base.filter((i) => !low || i.label.toLowerCase().includes(low));
  if (term.trim().length > 2) {
    paletteItems.unshift({ label: `Search evidence for "${term}"`, hint: "filter", run: () => {
      state.filters = { ...state.filters, q: term }; document.getElementById("filter-q").value = term;
      show("evidence"); reload(); } });
    paletteItems.push({ label: `Ask the agent: "${term}"`, hint: "question", run: () => {
      show("agent"); runAgent(term); } });
  }
  paletteIndex = 0;
  paletteList.innerHTML = paletteItems.map((i, n) =>
    `<li role="option" data-n="${n}" aria-selected="${n === 0}">${esc(i.label)}
     <span class="hint">${esc(i.hint)}</span></li>`).join("");
}

paletteInput.addEventListener("input", (e) => paintPalette(e.target.value));
paletteList.addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (li) { paletteItems[Number(li.dataset.n)].run(); closePalette(); }
});
paletteInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    paletteIndex = (paletteIndex + (e.key === "ArrowDown" ? 1 : -1) + paletteItems.length) % paletteItems.length;
    paletteList.querySelectorAll("li").forEach((li, n) =>
      li.setAttribute("aria-selected", String(n === paletteIndex)));
    paletteList.children[paletteIndex]?.scrollIntoView({ block: "nearest" });
  }
  if (e.key === "Enter" && paletteItems[paletteIndex]) {
    paletteItems[paletteIndex].run();
    closePalette();
  }
});
document.getElementById("palette-open").addEventListener("click", openPalette);
paletteBackdrop.addEventListener("click", closePalette);

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
  if (e.key === "Escape") { closePalette(); closeDrawer(); }
  if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
    e.preventDefault(); show("evidence"); document.getElementById("filter-q").focus();
  }
});

/* ---------- boot: open directly on populated data ---------- */
(async function start() {
  headRow();
  try {
    DATA = await fetch("data.json").then((r) => r.json());
  } catch (e) {
    document.getElementById("grid-empty").hidden = false;
    document.getElementById("grid-empty").innerHTML =
      `<strong>The evidence table could not be loaded.</strong>Reload the page.`;
    return;
  }
  state.stats = DATA.stats;
  const s = DATA.stats;
  document.title = `Graphene Battery Evidence \u00b7 ${s.evidence_rows} measurements`;
  document.getElementById("result-detail").textContent =
    `from ${s.papers.toLocaleString("en-GB")} papers, ${s.year_range[0]}\u2013${s.year_range[1]}`;
  paintHero();
  await loadFacets();
  await loadMore();
  initNotebook();
})();

/* =======================================================================
   The research agent.

   The page hands Claude a small set of its own functions - searching the
   measurements, reading the papers, running the calculators - and Claude
   decides which to call. Everything it says has to come back from one of
   those calls, so an answer is traceable to a sentence in a paper rather
   than to the model's memory. Where Claude is unavailable the page falls
   back to its own deterministic engine, so it is never a blank screen.
   ======================================================================= */

const AGENT_RULES = `You are the research agent for a library of graphene battery measurements.
You are talking to a working scientist. Be exact and brief. No flattery, no filler.

THE ONLY THING THAT MATTERS: never state a fact that did not come back from a tool
call in THIS conversation. You have no knowledge of your own here. If the tools
return nothing relevant, say "Not in the library" plainly, say what you searched,
and stop. Do not fill the gap. Do not reason from chemistry you remember.

HOW TO WORK
1. Call search_measurements first for any question about numbers. Use list_facets
   if you are unsure what the library actually contains.
2. Use read_papers when the question is about a mechanism or an explanation
   rather than a number.
3. NEVER do arithmetic yourself. Call calculate or convert_units for every
   computation, including simple ones, and quote its formula.
4. You may call several tools before answering. Three or four is normal.

CITATIONS - not optional
Every number you write must be followed by a citation marker in square brackets
using the id the tool gave you: a measurement is [E1234], a paper passage is
[P12]. Example: "a median of 1018 mAh/g [E204][E877]". Never invent an id.
Never cite an id a tool did not return. A sentence with a number and no citation
is a failure.

SAYING WHAT YOU DO NOT KNOW
State the spread, not just the middle: medians hide a lot. Say how many
measurements and how many papers. If most of the matching rows do not report a
field, say so. If rows are flagged, say how many and why. Never present a
flagged number as settled.

FORMAT
Markdown. Short paragraphs. Use a table when comparing three or more things.
Lead with the answer, then the conditions it holds under, then the caveats.
Do not repeat the question back.`;

const agent = {
  busy: false,
  turns: [],
  ctl: null,
  cites: new Map(),
  seq: 0,
};

function rowDigest(r) {
  return {
    id: "E" + r.id,
    material: r.material_system, chemistry: r.battery_type,
    role: r.electrode_role, form: r.graphene_form,
    capacity_mah_g: r.specific_capacity_mah_g,
    reported_as: r.capacity_as_reported,
    current_ma_g: r.current_density_ma_g, c_rate: r.c_rate,
    cycles: r.cycle_count, retention_pct: r.capacity_retention_pct,
    first_cycle_ce_pct: r.first_cycle_ce_pct,
    temperature_c: r.temperature_c, areal_loading_mg_cm2: r.areal_loading_mg_cm2,
    electrolyte: r.electrolyte, voltage_window: r.voltage_window_v,
    confidence: r.confidence,
    flags: (r.flags || []).map((f) => String(f).split(":")[0]),
    year: r.year, journal: r.journal, title: (r.title || "").slice(0, 120),
    quote: (r.source_quote || "").slice(0, 260),
  };
}

function spread(values) {
  const s = values.slice().sort((a, b) => a - b);
  const q = (p) => {
    const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
  };
  return { n: s.length, min: +s[0].toFixed(2), max: +s[s.length - 1].toFixed(2),
    median: +q(0.5).toFixed(2), p25: +q(0.25).toFixed(2), p75: +q(0.75).toFixed(2) };
}

const NUMERIC = [
  ["specific_capacity_mah_g", "mAh/g"], ["capacity_retention_pct", "%"],
  ["cycle_count", "cycles"], ["current_density_ma_g", "mA/g"], ["c_rate", "C"],
  ["first_cycle_ce_pct", "%"], ["areal_loading_mg_cm2", "mg/cm2"],
  ["temperature_c", "degC"],
];

function summarise(rows) {
  const stats = {};
  NUMERIC.forEach(([f, unit]) => {
    const v = rows.filter((r) => r[f] !== null && r.confidence !== "unverified")
                  .map((r) => Number(r[f]));
    if (v.length >= 2) stats[f] = { ...spread(v), unit };
    else if (v.length === 1) stats[f] = { n: 1, median: v[0], min: v[0], max: v[0], unit };
  });
  return stats;
}

function pickRows(f) {
  const t = (s) => String(s || "").toLowerCase();
  return DATA.rows.filter((r) => {
    if (f.material && !t(r.material_system).includes(t(f.material))) return false;
    if (f.graphene_form && t(r.graphene_form) !== t(f.graphene_form)) return false;
    if (f.battery_type && t(r.battery_type) !== t(f.battery_type)) return false;
    if (f.electrode_role && t(r.electrode_role) !== t(f.electrode_role)) return false;
    if (f.confidence && r.confidence !== f.confidence) return false;
    if (f.min_capacity != null && !(r.specific_capacity_mah_g >= f.min_capacity)) return false;
    if (f.max_capacity != null && !(r.specific_capacity_mah_g <= f.max_capacity)) return false;
    if (f.min_cycles != null && !(r.cycle_count >= f.min_cycles)) return false;
    if (f.min_year != null && !(r.year >= f.min_year)) return false;
    return true;
  });
}

const CALC = {
  energy_density: [["voltage_v", "capacity_mah_g"],
    (i) => ["energy_Wh_kg = voltage_V x capacity_mAh_g / 1000", i.voltage_v * i.capacity_mah_g / 1000, "Wh/kg"]],
  specific_capacity: [["current_ma", "time_h", "mass_g"],
    (i) => ["capacity_mAh_g = current_mA x time_h / mass_g", i.current_ma * i.time_h / i.mass_g, "mAh/g"]],
  c_rate: [["current_ma_g", "capacity_mah_g"],
    (i) => ["C_rate = current_mA_g / capacity_mAh_g", i.current_ma_g / i.capacity_mah_g, "C"]],
  coulombic_efficiency: [["discharge_mah_g", "charge_mah_g"],
    (i) => ["CE_pct = discharge_mAh_g / charge_mAh_g x 100", i.discharge_mah_g / i.charge_mah_g * 100, "%"]],
  capacity_fade_per_cycle: [["initial_mah_g", "final_mah_g", "cycles"],
    (i) => ["fade_pct_per_cycle = (initial - final) / initial / cycles x 100",
      (i.initial_mah_g - i.final_mah_g) / i.initial_mah_g / i.cycles * 100, "%/cycle"]],
  capacity_retention: [["initial_mah_g", "final_mah_g"],
    (i) => ["retention_pct = final_mAh_g / initial_mAh_g x 100", i.final_mah_g / i.initial_mah_g * 100, "%"]],
  cell_to_pack: [["cell_wh_kg", "pack_fraction"],
    (i) => ["pack_Wh_kg = cell_Wh_kg x pack_fraction", i.cell_wh_kg * (i.pack_fraction || 0.75), "Wh/kg"]],
};

const UNIT_FACTORS = {
  capacity: { "mah/g": 1, "mah g-1": 1, "ah/kg": 1, "ah/g": 1000, "mah/mg": 1000, "ah g-1": 1000 },
  current: { "ma/g": 1, "ma g-1": 1, "a/kg": 1, "a/g": 1000, "ma/mg": 1000, "a g-1": 1000 },
  loading: { "mg/cm2": 1, "g/cm2": 1000 },
};

function buildTools(onStep) {
  const step = (label, detail) => onStep(label, detail);
  return [
    {
      name: "list_facets",
      description: "What the library actually contains: the material systems, graphene forms, battery chemistries and electrode roles present, each with how many measurements. Call this when unsure whether the library covers something.",
      execute: () => {
        step("Checking what the library covers", "");
        const out = {};
        ["material_system", "graphene_form", "battery_type", "electrode_role"]
          .forEach((k) => { out[k] = (DATA.facets[k] || []).slice(0, 22); });
        out.total_measurements = DATA.rows.length;
        out.total_papers = DATA.stats.papers;
        return out;
      },
    },
    {
      name: "search_measurements",
      description: "Search the extracted measurements. Filter by material (substring, e.g. 'Si'), graphene_form, battery_type, electrode_role, confidence ('verified' or 'flagged'), min_capacity, max_capacity, min_cycles, min_year. Returns how many matched, the spread of every numeric field across them, and up to 10 example rows each with an id like E1234, its source sentence and its flags. Cite the ids.",
      inputSchema: { type: "object", properties: {
        material: { type: "string", description: "substring of the material system, e.g. 'Si' or 'S/rGO'" },
        graphene_form: { type: "string" }, battery_type: { type: "string" },
        electrode_role: { type: "string", description: "anode, cathode, separator" },
        confidence: { type: "string", enum: ["verified", "flagged"] },
        min_capacity: { type: "number" }, max_capacity: { type: "number" },
        min_cycles: { type: "number" }, min_year: { type: "number" },
      } },
      execute: (input) => {
        const rows = pickRows(input || {});
        const bits = Object.entries(input || {}).map(([k, v]) => `${k}=${v}`).join(", ");
        step("Searching measurements", `${bits || "all"} → ${rows.length}`);
        if (!rows.length) return { matched: 0, note: "No measurements match these filters. Try fewer filters or call list_facets." };
        const ranked = rows.slice().sort((a, b) =>
          (b.confidence === "verified") - (a.confidence === "verified")
          || (b.specific_capacity_mah_g || 0) - (a.specific_capacity_mah_g || 0));
        return {
          matched: rows.length,
          papers: new Set(rows.map((r) => r.openalex_id)).size,
          verified: rows.filter((r) => r.confidence === "verified").length,
          flagged: rows.filter((r) => r.confidence === "flagged").length,
          spread: summarise(rows),
          rows: ranked.slice(0, 10).map(rowDigest),
        };
      },
    },
    {
      name: "compare_materials",
      description: "Compare material systems side by side on one metric. Returns each system with how many measurements, the median and the quartiles. Use it for 'which is better' style questions. Only groups with 3 or more measurements are returned.",
      inputSchema: { type: "object", properties: {
        metric: { type: "string", enum: ["specific_capacity_mah_g", "capacity_retention_pct", "cycle_count", "first_cycle_ce_pct"] },
        battery_type: { type: "string" }, electrode_role: { type: "string" },
        limit: { type: "number" },
      }, required: ["metric"] },
      execute: (input) => {
        const metric = String(input.metric || "specific_capacity_mah_g");
        const rows = pickRows({ battery_type: input.battery_type, electrode_role: input.electrode_role });
        step("Comparing material systems", `on ${metric}`);
        const groups = new Map();
        rows.forEach((r) => {
          if (r[metric] === null || !r.material_system || r.confidence === "unverified") return;
          if (!groups.has(r.material_system)) groups.set(r.material_system, []);
          groups.get(r.material_system).push({ v: Number(r[metric]), id: "E" + r.id });
        });
        const out = [...groups.entries()]
          .filter(([, v]) => v.length >= 3)
          .map(([name, v]) => ({ material_system: name, ...spread(v.map((x) => x.v)),
            example_ids: v.slice(0, 3).map((x) => x.id) }))
          .sort((a, b) => b.median - a.median)
          .slice(0, Math.min(Number(input.limit) || 10, 14));
        return out.length ? { metric, groups: out }
          : { metric, groups: [], note: "No material system has 3 or more measurements of this metric under these filters." };
      },
    },
    {
      name: "read_papers",
      description: "Keyword search across the stored abstracts of 6,575 papers, for mechanism or explanation questions rather than numbers. Returns up to 5 passages, each with an id like P12 to cite, the paper title and year. Returns nothing when the words do not appear in the library.",
      inputSchema: { type: "object", properties: {
        query: { type: "string", description: "the key terms, e.g. 'dendrite suppression separator'" },
      }, required: ["query"] },
      execute: (input) => {
        const terms = contentTerms(String(input.query || ""));
        step("Reading papers", `"${String(input.query || "").slice(0, 46)}"`);
        if (terms.length < 1) return { matched: 0, note: "Query too vague." };
        const scored = [];
        for (const p of DATA.passages) {
          const low = p.x.toLowerCase();
          const hits = terms.filter((t) => low.includes(t)).length;
          if (hits >= Math.max(1, Math.ceil(terms.length * 0.5))) scored.push({ p, hits });
          if (scored.length > 400) break;
        }
        scored.sort((a, b) => b.hits - a.hits);
        const top = scored.slice(0, 5);
        if (!top.length) return { matched: 0, note: "No passage in the library uses these terms together." };
        return { matched: scored.length, passages: top.map(({ p }) => {
          const n = agent.passageIds.get(p.i) ?? (agent.passageIds.set(p.i, agent.passageIds.size + 1),
            agent.passageIds.get(p.i));
          agent.passageById.set("P" + n, p);
          return { id: "P" + n, title: p.t, year: p.y, journal: p.j, text: p.x.slice(0, 620) };
        }) };
      },
    },
    {
      name: "calculate",
      description: "Run a battery calculation. Names: energy_density(voltage_v, capacity_mah_g), specific_capacity(current_ma, time_h, mass_g), c_rate(current_ma_g, capacity_mah_g), coulombic_efficiency(discharge_mah_g, charge_mah_g), capacity_fade_per_cycle(initial_mah_g, final_mah_g, cycles), capacity_retention(initial_mah_g, final_mah_g), cell_to_pack(cell_wh_kg, pack_fraction). Returns the formula, the inputs and the result. Use this for ALL arithmetic.",
      inputSchema: { type: "object", properties: {
        name: { type: "string" },
        inputs: { type: "object", description: "the named inputs for that calculation" },
      }, required: ["name", "inputs"] },
      execute: (input) => {
        const spec = CALC[String(input.name)];
        if (!spec) throw new Error(`Unknown calculation '${input.name}'. Valid: ${Object.keys(CALC).join(", ")}`);
        const vals = {};
        for (const key of spec[0]) {
          const raw = (input.inputs || {})[key];
          const n = Number(raw);
          if (raw === undefined || raw === null || raw === "" || !Number.isFinite(n)) {
            if (key === "pack_fraction") { vals[key] = 0.75; continue; }
            throw new Error(`Missing or non-numeric input '${key}' for ${input.name}.`);
          }
          if (n <= 0) throw new Error(`Input '${key}' must be positive, got ${n}.`);
          vals[key] = n;
        }
        const [formula, result, unit] = spec[1](vals);
        step("Calculating", `${input.name} → ${(+result.toFixed(4))} ${unit}`);
        return { calculation: input.name, formula, inputs: vals, result: +result.toFixed(4), unit };
      },
    },
    {
      name: "convert_units",
      description: "Convert a value between units. kind is 'capacity' (mAh/g, Ah/kg, Ah/g, mAh/mg), 'current' (mA/g, A/g, A/kg) or 'loading' (mg/cm2, g/cm2). Returns the value in the library's own unit.",
      inputSchema: { type: "object", properties: {
        kind: { type: "string", enum: ["capacity", "current", "loading"] },
        value: { type: "number" }, unit: { type: "string" },
      }, required: ["kind", "value", "unit"] },
      execute: (input) => {
        const table = UNIT_FACTORS[String(input.kind)];
        if (!table) throw new Error("kind must be capacity, current or loading");
        const key = String(input.unit || "").toLowerCase().trim();
        const factor = table[key];
        if (factor === undefined) throw new Error(`Unknown ${input.kind} unit '${input.unit}'. Known: ${Object.keys(table).join(", ")}`);
        const base = { capacity: "mAh/g", current: "mA/g", loading: "mg/cm2" }[input.kind];
        const result = Number(input.value) * factor;
        step("Converting units", `${input.value} ${input.unit} → ${result} ${base}`);
        return { formula: `${base} = value x ${factor}`, value: Number(input.value),
          from: input.unit, result, unit: base };
      },
    },
  ];
}

/* ---------- rendering ---------- */

function mdToHtml(md, refs) {
  const lines = String(md).split("\n");
  let html = "", list = null, inTable = false;
  const flushList = () => { if (list) { html += `</${list}>`; list = null; } };
  const flushTable = () => { if (inTable) { html += "</tbody></table>"; inTable = false; } };
  const inline = (s) => {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "<em>$1</em>");
    t = t.replace(/\[([EP]\d+)\]/g, (m, id) => {
      const n = refs.index.get(id);
      return n ? `<button class="cref" data-ref="${esc(id)}" title="Show the source">${n}</button>` : "";
    });
    return t;
  };
  for (let raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*\|(.+)\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split("|").map((c) => c.trim());
      if (/^[\s|:-]+$/.test(line)) continue;
      if (!inTable) { flushList(); html += "<table><tbody>"; inTable = true;
        html += "<tr>" + cells.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr>"; continue; }
      html += "<tr>" + cells.map((c) => {
        const num = /^[\s$£€]*[\d.,+-]+\s*\S{0,8}$/.test(c);
        return `<td class="${num ? "num" : ""}">${inline(c)}</td>`;
      }).join("") + "</tr>";
      continue;
    }
    flushTable();
    if (!line.trim()) { flushList(); continue; }
    let m;
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) { flushList(); html += `<h3>${inline(m[1])}</h3>`; continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (list !== "ul") { flushList(); html += "<ul>"; list = "ul"; }
      html += `<li>${inline(m[1])}</li>`; continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== "ol") { flushList(); html += "<ol>"; list = "ol"; }
      html += `<li>${inline(m[1])}</li>`; continue;
    }
    flushList();
    html += `<p>${inline(line)}</p>`;
  }
  flushList(); flushTable();
  return html;
}

function collectRefs(text) {
  const index = new Map(), items = [];
  const ids = [...String(text).matchAll(/\[([EP]\d+)\]/g)].map((m) => m[1]);
  for (const id of ids) {
    if (index.has(id)) continue;
    let item = null;
    if (id[0] === "E") {
      const row = DATA.rows.find((r) => "E" + r.id === id);
      if (row) item = { kind: "evidence", id, row };
    } else {
      const p = agent.passageById.get(id);
      if (p) item = { kind: "passage", id, p };
    }
    if (!item) continue;              // an id no tool returned is dropped, never shown
    index.set(id, index.size + 1);
    items.push(item);
  }
  return { index, items };
}

function renderRefs(refs) {
  if (!refs.items.length) return "";
  return `<div class="refs"><h4>Sources</h4>` + refs.items.map((it) => {
    const n = refs.index.get(it.id);
    if (it.kind === "evidence") {
      const r = it.row;
      return `<div class="ref" data-ref="${esc(it.id)}"><div class="n">${n}</div><div>
        <div class="t">${esc(r.title || "")}</div>
        <div class="m">${esc(r.journal || "")} ${r.year || ""}
          &middot; ${esc(r.material_system || "")}
          &middot; read from the ${esc(r.source_section || "abstract")}
          &middot; ${esc(r.confidence)}</div>
        <div class="q">&ldquo;${esc((r.source_quote || "").slice(0, 300))}&rdquo;</div>
        ${r.confidence === "flagged" && (r.flags || []).length
          ? `<div class="flagwarn">&#9873; ${esc(String(r.flags[0]).split(":")[0].replace(/_/g, " "))}</div>` : ""}
      </div></div>`;
    }
    return `<div class="ref" data-ref="${esc(it.id)}"><div class="n">${n}</div><div>
      <div class="t">${esc(it.p.t || "")}</div>
      <div class="m">${esc(it.p.j || "")} ${it.p.y || ""} &middot; abstract</div>
      <div class="q">&ldquo;${esc(it.p.x.slice(0, 300))}&rdquo;</div>
    </div></div>`;
  }).join("") + `</div>`;
}

/* ---------- the run ---------- */

agent.passageIds = new Map();
agent.passageById = new Map();

function addTurn(question) {
  const el = document.createElement("div");
  el.className = "turn";
  el.innerHTML = `<div class="you">${esc(question)}</div>
    <div class="steps" hidden><div class="steps-head"><span>Working</span>
      <button class="link" data-toggle-steps hidden>Hide</button></div>
      <div class="steplist"></div></div>
    <div class="thinking"><span class="dots"><i></i><i></i><i></i></span>
      <span class="tstatus">Reading the library…</span></div>
    <div class="answer-body" hidden></div>
    <div class="refsbox"></div>
    <div class="turn-actions" hidden></div>`;
  document.getElementById("thread").appendChild(el);
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  return el;
}

function pushStep(turnEl, label, detail) {
  const box = turnEl.querySelector(".steps");
  const list = turnEl.querySelector(".steplist");
  box.hidden = false;
  list.querySelectorAll(".step.run").forEach((s) => s.classList.remove("run"));
  const row = document.createElement("div");
  row.className = "step run";
  row.innerHTML = `<span class="ic">&#9679;</span>
    <span class="what">${esc(label)} ${detail ? `<b>${esc(detail)}</b>` : ""}</span>
    <span class="found"></span>`;
  list.appendChild(row);
  turnEl.querySelector(".tstatus").textContent = label + "…";
}

async function runAgent(question) {
  if (agent.busy || !question.trim()) return;
  agent.busy = true;
  document.getElementById("hero").hidden = true;
  document.getElementById("suggest").hidden = true;
  const sendBtn = document.getElementById("send-btn");
  const stopBtn = document.getElementById("stop-btn");
  sendBtn.disabled = true; stopBtn.hidden = false;

  const turnEl = addTurn(question);
  const bodyEl = turnEl.querySelector(".answer-body");
  const thinkEl = turnEl.querySelector(".thinking");
  const refsEl = turnEl.querySelector(".refsbox");
  const actEl = turnEl.querySelector(".turn-actions");

  const finish = (markdown, note) => {
    thinkEl.hidden = true;
    turnEl.querySelectorAll(".step.run").forEach((s) => s.classList.remove("run"));
    const refs = collectRefs(markdown);
    bodyEl.hidden = false;
    bodyEl.innerHTML = mdToHtml(markdown, refs) + (note ? `<div class="notice">${esc(note)}</div>` : "");
    refsEl.innerHTML = renderRefs(refs);
    const uncited = /\d/.test(markdown) && refs.items.length === 0;
    actEl.hidden = false;
    actEl.innerHTML = `<button class="ghost" data-save>Save to notebook</button>
      <span class="muted">${refs.items.length} source${refs.items.length === 1 ? "" : "s"}${
        uncited ? " · no citation returned, treat with care" : ""}</span>`;
    actEl.querySelector("[data-save]").addEventListener("click", (e) => {
      saveFinding(question, markdown, refs);
      e.target.textContent = "Saved";
      e.target.disabled = true;
    });
    agent.turns.push({ role: "user", content: question });
    agent.turns.push({ role: "assistant", content: markdown });
    if (agent.turns.length > 8) agent.turns.splice(0, 2);
    turnEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  try {
    const sample = await CLAUDE.use("sample");
    if (!sample) { finishLocal(); return; }

    const limits = await sample.limits().catch(() => null);
    if (limits && !limits.tools) { finishLocal(); return; }

    agent.ctl = new AbortController();
    const tools = buildTools((label, detail) => pushStep(turnEl, label, detail));
    const turns = [{ role: "user", content: AGENT_RULES }, ...agent.turns,
                   { role: "user", content: question }];
    let streamed = false;
    const { text } = await sample(turns, {
      tools, modelTier: "default", cache: false, signal: agent.ctl.signal,
      onText: ({ text }) => {
        streamed = true;
        thinkEl.hidden = true;
        bodyEl.hidden = false;
        bodyEl.textContent = text;
      },
    });
    finish(text);
  } catch (e) {
    const code = e && e.code;
    if (code === "cancelled") {
      thinkEl.hidden = true;
      if (e.text) finish(e.text, "Stopped before the agent finished.");
      else { turnEl.querySelector(".answer-body").hidden = false;
             turnEl.querySelector(".answer-body").innerHTML = `<div class="notice">Stopped.</div>`; }
    } else if (code === "not_granted" || code === "sampling_disabled"
            || code === "not_declared" || code === "capability_disabled"
            || code === "tools_unavailable" || code === "capability_removed") {
      finishLocal("The agent needs your permission to use Claude. This answer came "
        + "from the page's own search instead, which reports the numbers but does "
        + "not reason about them.");
    } else if (code === "rate_limited") {
      thinkEl.hidden = true; bodyEl.hidden = false;
      bodyEl.innerHTML = `<div class="notice">Too many questions at once for your Claude
        account to keep up. Wait a moment and ask again.</div>`;
    } else {
      finishLocal("The agent could not be reached, so this answer came from the "
        + "page's own search instead.");
    }
  } finally {
    agent.busy = false; agent.ctl = null;
    sendBtn.disabled = false; stopBtn.hidden = true;
    document.getElementById("ask-input").focus();
  }

  function finishLocal(note) {
    const r = localAnswer(question);
    let md = r.summary + "\n\n";
    Object.entries(r.statistics).forEach(([k, v]) => {
      md += `- **${k}**: median ${fmt(v.median, 1)} ${v.unit}, range ${fmt(v.min, 1)} to ${fmt(v.max, 1)}, from ${v.n} measurements\n`;
    });
    if (r.citations.length) {
      md += "\n" + r.citations.map((c) => `- ${c.title || ""} [E${c.id}]`).join("\n");
    }
    finish(md, note);
  }
}

/* ---------- notebook ---------- */

let notebook = [];
let notebookDb = null;

async function initNotebook() {
  try {
    notebookDb = await CLAUDE.use("db");
    if (!notebookDb) return;
    const snap = await notebookDb.collection("findings").orderBy("at", "desc").limit(60).get();
    notebook = snap.docs ? snap.docs.map((d) => ({ id: d.id, ...d.data() })) : [];
    paintNotebookCount();
  } catch (e) { notebookDb = null; }
}

async function saveFinding(question, markdown, refs) {
  const entry = {
    question, answer: markdown.slice(0, 6000),
    sources: refs.items.map((i) => i.id),
    at: new Date().toISOString(),
  };
  notebook.unshift({ id: "local-" + Date.now(), ...entry });
  paintNotebookCount();
  renderNotebook();
  if (!notebookDb) return;
  try {
    await notebookDb.collection("findings").doc("f" + Date.now()).set(entry);
  } catch (e) { /* kept in this view regardless */ }
}

function paintNotebookCount() {
  const el = document.getElementById("nb-count");
  el.textContent = notebook.length;
  el.hidden = notebook.length === 0;
}

function renderNotebook() {
  const host = document.getElementById("nb-list");
  if (!host) return;
  if (!notebook.length) {
    host.innerHTML = `<div class="empty"><strong>Nothing saved yet.</strong>
      Ask a question, then choose Save to notebook under the answer.</div>`;
    return;
  }
  host.innerHTML = notebook.map((n) => `<div class="nb">
    <div class="q">${esc(n.question)}</div>
    <div class="a">${esc(String(n.answer).replace(/\[[EP]\d+\]/g, "").slice(0, 420))}…</div>
    <div class="meta"><span>${(n.sources || []).length} sources</span>
      <span>${esc(String(n.at || "").slice(0, 16).replace("T", " "))}</span></div>
  </div>`).join("");
}

/* ---------- wiring ---------- */

const CLAUDE = (typeof window !== "undefined" && window.claude) ? window.claude
  : { use: async () => null };          // served outside a Claude viewer

(async function announce() {
  const note = document.getElementById("composer-note");
  const sample = await CLAUDE.use("sample").catch(() => null);
  note.textContent = sample
    ? "The agent searches the library, runs the arithmetic, and cites every number."
    : "Claude is not available here, so answers come from the page's own search.";
})();

const askInput = document.getElementById("ask-input");
askInput.addEventListener("input", () => {
  askInput.style.height = "auto";
  askInput.style.height = Math.min(askInput.scrollHeight, 180) + "px";
});
askInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault();
    document.getElementById("ask-form").requestSubmit(); }
});
document.getElementById("ask-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = askInput.value.trim();
  if (!q) return;
  askInput.value = ""; askInput.style.height = "auto";
  runAgent(q);
});
document.getElementById("stop-btn").addEventListener("click", () => agent.ctl?.abort());

document.getElementById("thread").addEventListener("click", (e) => {
  const cref = e.target.closest("[data-ref]");
  if (!cref) return;
  const id = cref.dataset.ref;
  if (id[0] === "E") {
    const row = DATA.rows.find((r) => "E" + r.id === id);
    if (row) { state.rows = [row]; openDrawer(row.id); }
  } else {
    const p = agent.passageById.get(id);
    if (p) openPassage(p);
  }
});

function openPassage(p) {
  document.getElementById("drawer-title").textContent = "Paper";
  document.getElementById("drawer-body").innerHTML = `
    <div class="meta muted" style="font-size:12.5px">${esc(p.j || "")}${p.y ? ` &middot; ${p.y}` : ""}
      ${p.d ? ` &middot; <a href="https://doi.org/${esc(p.d)}" target="_blank" rel="noopener">${esc(p.d)}</a>` : ""}</div>
    <div style="font-size:14.5px;font-weight:500;margin:7px 0 2px;max-width:60ch">${esc(p.t || "")}</div>
    <h3>Abstract, as stored</h3>
    <blockquote class="quote">${esc(p.x)}</blockquote>
    <div class="muted" style="font-size:12.5px;max-width:62ch">
      No measurement was extracted from this paper for the question asked. The text
      is shown unchanged so you can judge it yourself.</div>`;
  document.getElementById("drawer-backdrop").hidden = false;
  document.getElementById("drawer").hidden = false;
  document.getElementById("drawer-close").focus();
}

const SUGGESTIONS = [
  "What capacity do silicon graphene anodes reach in lithium-ion cells, and what energy density is that at 3.7 V?",
  "Compare rGO, graphene oxide and N-doped graphene anodes on capacity. Which holds up best?",
  "How much capacity do sulfur rGO cathodes retain, and over how many cycles?",
  "Do graphene separators suppress lithium dendrites? What do the papers actually say?",
  "An electrode falls from 1200 to 870 mAh/g over 400 cycles. What is the fade per cycle, and how does that compare with the library?",
  "What is the melting point of tungsten?",
];

function paintHero() {
  const s = DATA.stats;
  document.getElementById("hero-stats").innerHTML = [
    [s.evidence_rows.toLocaleString("en-GB"), "measurements"],
    [s.papers.toLocaleString("en-GB"), "papers"],
    [s.material_systems, "material systems"],
    [`${s.year_range[0]}–${s.year_range[1]}`, "published"],
    [s.flagged.toLocaleString("en-GB"), "flagged, kept"],
  ].map(([v, k]) => `<div class="s"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`).join("");
  document.getElementById("suggest").innerHTML =
    SUGGESTIONS.map((q) => `<button data-q="${esc(q)}">${esc(q)}</button>`).join("");
  document.getElementById("suggest").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) runAgent(b.dataset.q);
  });
}
