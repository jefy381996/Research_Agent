/* Graphene Battery Evidence Workbench - interface behaviour.
   No framework and no build step: the whole product is one deployable service. */

const api = (path) => fetch(path).then((r) => {
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
});

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
  if (view === "library") loadDocuments();
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

async function loadMore() {
  if (state.loading) return;
  state.loading = true;
  try {
    const p = query({ limit: state.limit, offset: state.offset });
    const data = await api(`/api/evidence?${p}`);
    state.total = data.total;
    if (state.offset === 0) {
      const top = data.rows.find((r) => r.specific_capacity_mah_g !== null);
      state.capMax = Math.max(400, top ? Number(top.specific_capacity_mah_g) : 400);
    }
    state.rows.push(...data.rows);
    state.offset += data.rows.length;
    appendRows(data.rows);
    renderCount();
    document.getElementById("grid-empty").hidden = state.total !== 0;
    if (state.total === 0) emptyState();
  } catch (e) {
    document.getElementById("grid-empty").hidden = false;
    document.getElementById("grid-empty").innerHTML =
      `<strong>The evidence table could not be read.</strong>${esc(e.message)}. The service may still be starting; reload the page.`;
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
  const facets = await api("/api/facets");
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

document.getElementById("export-csv").addEventListener("click", () => {
  window.location = `/api/export.csv?${query()}`;
});
document.getElementById("export-xlsx").addEventListener("click", () => {
  window.location = `/api/export.xlsx?${query()}`;
});

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

async function askNow(question) {
  if (!question) return;
  const host = document.getElementById("ask-result");
  host.hidden = false;
  host.innerHTML = `<div class="answer muted">Searching the library&hellip;</div>`;

  let summary = "", stats = null, cites = [], coverage = null, status = "", mode = "";
  const paint = () => {
    host.innerHTML =
      `<div class="answer${status === "not_found" ? " refused" : ""}">${esc(summary)}</div>`
      + (stats ? `<div class="statrow">${Object.entries(stats).map(([k, v]) =>
          `<div class="stat"><div class="label">${esc(k)}</div>`
        + `<div class="value">${fmt(v.median, 1)}<span class="unit">${esc(v.unit)}</span></div>`
        + `<div class="sub">median of ${v.n} &middot; ${fmt(v.min, 1)}–${fmt(v.max, 1)}</div></div>`).join("")}</div>` : "")
      + cites.map((c) => `<div class="cite"><div class="n">[${c.n}]</div><div>
          <div class="meta">${esc(c.title || "")} &middot; ${esc(c.journal || "")} ${c.year || ""}
          ${c.doi ? `&middot; <a href="https://doi.org/${esc(c.doi)}" target="_blank" rel="noopener">doi</a>` : ""}
          &middot; ${esc(c.confidence || "")}</div>
          <div class="q">${esc(c.quote || "")}</div>
          ${Object.keys(c.values || {}).length ? `<div class="vals">${
            Object.entries(c.values).map(([k, v]) => `${esc(k)} ${esc(v)}`).join("  &middot;  ")}</div>` : ""}
        </div></div>`).join("")
      + (coverage ? renderCoverage(coverage, status) : "");
  };

  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === "status") { status = ev.status; mode = ev.mode; }
        if (ev.type === "summary") summary += ev.text;
        if (ev.type === "statistics") stats = ev.statistics;
        if (ev.type === "citation") cites.push(ev.citation);
        if (ev.type === "coverage") coverage = ev.coverage;
        if (ev.type === "error") summary = `The question could not be answered: ${ev.message}`;
        paint();
      }
    }
  } catch (e) {
    host.innerHTML = `<div class="answer">The question could not be sent. ${esc(e.message)}</div>`;
  }
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
let calcLoaded = false;
async function loadCalculators() {
  if (calcLoaded) return;
  calcLoaded = true;
  const data = await api("/api/calculators");
  document.getElementById("calc-list").innerHTML = data.calculators.map((c) => `
    <div class="calc" data-name="${esc(c.name)}">
      <h3>${esc(c.name.replace(/_/g, " "))}</h3>
      <div class="desc">${esc(c.description)}</div>
      <div class="calc-inputs">
        ${c.inputs.map((i) => `<label class="field"><span>${esc(i.name)}</span>
          <input type="number" step="any" data-in="${esc(i.name)}"
          ${i.default !== null ? `value="${i.default}"` : ""}></label>`).join("")}
        <button class="primary" data-run>Calculate</button>
      </div>
      <div class="calc-out"></div>
    </div>`).join("");

  document.getElementById("calc-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-run]");
    if (!btn) return;
    const card = btn.closest(".calc");
    const out = card.querySelector(".calc-out");
    const inputs = {};
    card.querySelectorAll("[data-in]").forEach((el) => { inputs[el.dataset.in] = el.value; });
    try {
      const res = await fetch("/api/calculate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: card.dataset.name, inputs }),
      });
      const j = await res.json();
      out.classList.add("on");
      if (!res.ok) { out.innerHTML = `<div class="formula">${esc(j.detail)}</div>`; return; }
      out.innerHTML = `<div class="formula">${esc(j.formula)}</div>`
        + `<div class="res">${fmt(j.result, 4)}<span class="unit">${esc(j.unit)}</span></div>`
        + `<div class="muted" style="font-size:12px;margin-top:5px">`
        + Object.entries(j.inputs).map(([k, v]) => `${esc(k)} = ${esc(v)}`).join("  &middot;  ")
        + `</div>`
        + (j.reference ? `<div class="muted" style="font-size:12px;margin-top:7px">
            Materials Project reference: ${j.reference.map((r) =>
            `${esc(r.formula)} ${fmt(r.energy_density, 0)} Wh/kg`).join(", ")}</div>` : "");
    } catch (err) {
      out.classList.add("on");
      out.innerHTML = `<div class="formula">${esc(err.message)}</div>`;
    }
  });
}

/* ---------- library ---------- */
const drop = document.getElementById("drop");
const fileInput = document.getElementById("file");
drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => {
  e.preventDefault(); drop.classList.add("over");
}));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => {
  e.preventDefault(); drop.classList.remove("over");
}));
drop.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) upload(f);
});
fileInput.addEventListener("change", () => { if (fileInput.files[0]) upload(fileInput.files[0]); });

async function upload(file) {
  const status = document.getElementById("upload-status");
  status.hidden = false;
  status.className = "upload-status";
  status.textContent = `Reading ${file.name}… extracting text, indexing, then deleting the PDF.`;
  const body = new FormData();
  body.append("file", file);
  try {
    const res = await fetch("/api/upload", { method: "POST", body });
    const j = await res.json();
    if (!res.ok) {
      status.className = "upload-status bad";
      status.textContent = j.detail || "The upload failed.";
      return;
    }
    status.innerHTML = `<strong>${esc(j.filename)}</strong> indexed. `
      + `${j.page_count} pages, ${j.characters.toLocaleString("en-GB")} characters, `
      + `${j.evidence_rows} evidence ${j.evidence_rows === 1 ? "row" : "rows"} extracted. `
      + `The PDF was deleted. Your paper is now searchable alongside the public set.`;
    loadDocuments();
    loadFacets();
    reload();
  } catch (e) {
    status.className = "upload-status bad";
    status.textContent = `The upload could not be sent. ${e.message}`;
  }
}

async function loadDocuments() {
  try {
    const data = await api("/api/documents");
    document.getElementById("doc-list").innerHTML = data.rows.length ? `
      <h3 style="font:600 11.5px var(--sans);color:var(--ink-mute);margin:22px 0 7px">Your documents</h3>
      <table class="grid"><thead><tr><th>File</th><th class="num">Pages</th>
      <th class="num">Characters</th><th>Uploaded</th></tr></thead><tbody>
      ${data.rows.map((r) => `<tr><td>${esc(r.filename)}</td>
        <td class="num">${fmt(r.page_count)}</td>
        <td class="num">${fmt(r.char_count)}</td>
        <td>${esc((r.uploaded_at || "").replace("T", " ").replace("+00:00", " UTC"))}</td></tr>`).join("")}
      </tbody></table>` : "";
  } catch (e) { /* nothing uploaded yet */ }
}

/* ---------- sources ---------- */
async function loadSources(q = "") {
  const data = await api(`/api/sources?limit=600${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  document.getElementById("src-count").textContent = data.total.toLocaleString("en-GB");
  document.getElementById("src-body").innerHTML = data.rows.map((r) => `
    <tr><td class="title-cell">${esc(r.title || "")}</td>
    <td class="num">${r.year ? String(r.year) : nr}</td>
    <td>${esc(r.journal || "") || nr}</td>
    <td>${r.licence ? esc(r.licence) : nr}</td>
    <td>${esc(r.oa_status || "") || nr}</td>
    <td class="num">${fmt(r.evidence_rows)}</td>
    <td>${r.stored_sections ? "yes" : `<span class="nr">no</span>`}</td>
    <td>${esc((r.fetched_at || "").slice(0, 10))}</td></tr>`).join("");
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
    state.stats = await api("/api/stats");
    const s = state.stats;
    document.title = `Graphene Battery Evidence · ${s.evidence_rows} measurements`;
    document.getElementById("result-detail").textContent =
      `from ${s.papers.toLocaleString("en-GB")} papers, ${s.year_range[0]}–${s.year_range[1]}`;
  } catch (e) { /* stats are not essential to the table */ }
  await Promise.all([loadFacets(), loadMore()]);
})();
