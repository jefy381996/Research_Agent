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
document.getElementById("export-xlsx").addEventListener("click", exportCsv);

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

/* ---------- ask ---------- */
const EXAMPLES = [
  "What capacity do silicon graphene anodes reach in lithium-ion batteries?",
  "capacity retention of sulfur rGO cathodes in lithium-sulfur",
  "How many cycles do sodium-ion graphene anodes survive?",
  "coulombic efficiency of silicon graphene anodes",
  "What is the melting point of tungsten?",
];
document.getElementById("ask-examples").innerHTML =
  EXAMPLES.map((q) => `<button data-q="${esc(q)}">${esc(q)}</button>`).join("");
document.getElementById("ask-examples").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  document.getElementById("ask-input").value = b.dataset.q;
  askNow(b.dataset.q);
});

document.getElementById("ask-form").addEventListener("submit", (e) => {
  e.preventDefault();
  askNow(document.getElementById("ask-input").value.trim());
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

function answerLocal(question) {
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

async function askNow(question) {
  if (!question) return;
  const host = document.getElementById("ask-result");
  host.hidden = false;
  const r = answerLocal(question);
  const cites = r.citations, stats = Object.keys(r.statistics).length ? r.statistics : null;
  host.innerHTML =
      `<div class="answer${r.status === "not_found" ? " refused" : ""}">${esc(r.summary)}</div>`
    + (stats ? `<div class="statrow">${Object.entries(stats).map(([k, v]) =>
        `<div class="stat"><div class="label">${esc(k)}</div>`
      + `<div class="value">${fmt(v.median, 1)}<span class="unit">${esc(v.unit)}</span></div>`
      + `<div class="sub">median of ${v.n} &middot; ${fmt(v.min, 1)}\u2013${fmt(v.max, 1)}</div></div>`).join("")}</div>` : "")
    + cites.map((c) => `<div class="cite"><div class="n">[${c.n}]</div><div>
        <div class="meta">${esc(c.title || "")} &middot; ${esc(c.journal || "")} ${c.year || ""}
        ${c.doi ? `&middot; <a href="https://doi.org/${esc(c.doi)}" target="_blank" rel="noopener">doi</a>` : ""}
        &middot; ${esc(c.confidence || "")}</div>
        <div class="q">${esc(c.source_quote || c.quote || "")}</div>
        ${Object.keys(c.values || {}).length ? `<div class="vals">${
          Object.entries(c.values).map(([k, v]) => `${esc(k)} ${esc(v)}`).join("  &middot;  ")}</div>` : ""}
      </div></div>`).join("")
    + renderCoverage(r.coverage, r.status);
}

function renderCoverage(c, status) {
  const bits = [];
  if (c.papers) bits.push(`<strong>${c.papers}</strong> papers`);
  if (c.evidence_rows) bits.push(`<strong>${c.evidence_rows}</strong> measurements`);
  if (c.year_range) bits.push(`published <strong>${c.year_range[0]}–${c.year_range[1]}</strong>`);
  if (c.flagged_rows) bits.push(`<strong>${c.flagged_rows}</strong> flagged and included`);
  let html = `<div class="coverage">`;
  if (status === "not_found") {
    html += `Searched ${(c.searched || []).join(" and ")}. `
         + `Matched ${c.matched_passages ?? 0} passages, below the threshold for an answer. `;
    if (Object.keys(c.facets_detected || {}).length)
      html += `Recognised ${Object.entries(c.facets_detected).map(([k, v]) => `${k} <strong>${esc(v)}</strong>`).join(", ")}. `;
    html += `<br>${esc(c.suggestion || "")}`;
  } else {
    html += `Drawn from ${bits.join(", ")}.`;
    if ((c.not_reported || []).length)
      html += ` Not stated by these papers: <strong>${c.not_reported.map(esc).join(", ")}</strong>.`;
    html += ` Numbers come only from the sentences quoted above.`;
  }
  return html + `</div>`;
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
    { label: "Ask the library", hint: "section", run: () => show("ask") },
    { label: "Calculator", hint: "section", run: () => show("calculator") },
    { label: "My library", hint: "section", run: () => show("library") },
    { label: "Sources", hint: "section", run: () => show("sources") },
    { label: "Show flagged rows only", hint: "filter", run: () => {
        state.filters = { confidence: "flagged" }; show("evidence"); reload(); } },
    { label: "Show verified rows only", hint: "filter", run: () => {
        state.filters = { confidence: "verified" }; show("evidence"); reload(); } },
    { label: "Clear all filters", hint: "filter", run: () =>
        document.getElementById("filters-clear").click() },
    { label: "Export the current view to Excel", hint: "export", run: () =>
        document.getElementById("export-xlsx").click() },
  ];
  paletteItems = base.filter((i) => !low || i.label.toLowerCase().includes(low));
  if (term.trim().length > 2) {
    paletteItems.unshift({ label: `Search evidence for "${term}"`, hint: "filter", run: () => {
      state.filters = { ...state.filters, q: term }; document.getElementById("filter-q").value = term;
      show("evidence"); reload(); } });
    paletteItems.push({ label: `Ask: "${term}"`, hint: "question", run: () => {
      show("ask"); document.getElementById("ask-input").value = term; askNow(term); } });
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
  await loadFacets();
  await loadMore();
})();
