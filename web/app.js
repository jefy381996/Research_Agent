/* Graphene Research Agent
   Runs entirely on its own data. No model, no network call at question time:
   the same question always produces the same answer, and every number it shows
   was read out of a sentence in a paper. */

let DATA = { rows: [], properties: [], property_families: [], passages: [],
             concepts: [], compounds: [], calculators: [], facets: {}, stats: {} };
let API = false;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, d = 0) => (v === null || v === undefined || v === "")
  ? null : Number(v).toLocaleString("en-GB", { maximumFractionDigits: d });
const NR = '<span class="nr">not reported</span>';

/* A property can run from 0.004 to 5,300 in the same column. Rounding the
   whole column to the median's precision printed the minimum as "0", which
   reads as "none" rather than "very small", so each figure keeps three
   significant digits of its own. */
const sig = (v, figs = 3) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  const mag = Math.floor(Math.log10(Math.abs(n)));
  const places = Math.max(0, Math.min(6, figs - 1 - mag));
  return n.toLocaleString("en-GB", { maximumFractionDigits: places,
                                     minimumFractionDigits: 0 });
};

/* Give each child an index the stylesheet turns into a delay, so a list
   arrives in sequence rather than all at once. */
function stagger(root, selector, cap = 24) {
  if (!root) return;
  root.querySelectorAll(selector).forEach((el, i) => {
    el.style.setProperty("--i", Math.min(i, cap));
  });
}

/* Count a figure up to its value. The element keeps its unit markup; only the
   leading number is animated, and it lands exactly on the real value. */
function countUp(el, value, decimals) {
  if (!el || !Number.isFinite(value)) return;
  const reduce = window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const render = (v) => { el.textContent = v.toLocaleString("en-GB",
    { minimumFractionDigits: decimals, maximumFractionDigits: decimals }); };
  if (reduce || Math.abs(value) < 0.01) { render(value); return; }
  const DUR = 780, t0 = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / DUR);
    const eased = 1 - Math.pow(1 - p, 4);
    render(value * eased);
    if (p < 1) requestAnimationFrame(tick); else render(value);
  };
  requestAnimationFrame(tick);
}

/* ── vocabulary ─────────────────────────────────────────── */
const V = {
  partner: [["Si", /\bsilicon\b|\bsi\b|\bsiox\b/], ["S", /\bsulfur\b|\bsulphur\b|\bli-?s\b/],
    ["SnO2", /\bsno2?\b|tin\s+oxide/], ["Sn", /\btin\b/], ["Fe2O3", /\bfe2o3\b|hematite/],
    ["Fe3O4", /\bfe3o4\b|magnetite/], ["Co3O4", /\bco3o4\b/],
    ["MoS2", /\bmos2?\b|molybdenum\s+disulfide/], ["MnO2", /\bmno2?\b/], ["TiO2", /\btio2?\b/],
    ["LFP", /\blfp\b|lifepo4|iron\s+phosphate/], ["NMC", /\bnmc\b|\bncm\b/],
    ["LTO", /\blto\b|titanate/], ["V2O5", /\bv2o5\b/], ["Nb2O5", /\bnb2o5\b/],
    ["Li2S", /\bli2s\b/], ["Se", /\bselenium\b/], ["Sb", /\bantimony\b/], ["Bi", /\bbismuth\b/],
    ["Ge", /\bgermanium\b/], ["P", /black\s+phosphor|red\s+phosphor|phosphorene/],
    ["NiO", /\bnio\b/], ["CuO", /\bcuo\b/], ["ZnO", /\bzno\b/],
    ["CNT", /carbon\s+nanotube|\bcnts?\b/], ["hard carbon", /hard\s+carbon/]],
  graphene_form: [["rGO", /reduced\s+graphene\s+oxide|\brgo\b/],
    ["graphene oxide", /graphene\s+oxide|\bgo\b/],
    ["N-doped graphene", /(?:nitrogen|n)[\s-]*doped\s+graphene/],
    ["graphene aerogel", /aerogel|hydrogel/],
    ["3D graphene", /3\s*-?\s*d\s+graphene|three[\s-]*dimensional\s+graphene/],
    ["graphene foam", /graphene\s+foam/], ["holey graphene", /holey|porous\s+graphene/],
    ["graphene quantum dots", /quantum\s+dot/], ["CVD graphene", /\bcvd\b/],
    ["few-layer graphene", /few[\s-]*layer/],
    ["graphene nanosheets", /nanosheet|nanoplatelet/], ["graphene", /\bgraphene\b|\bgraphitic\b/]],
  battery_type: [["lithium-sulfur", /lithium[\s-]*sul[fp]hur|lithium[\s-]*sulfur|\bli[\s-]*s\b/],
    ["lithium-selenium", /lithium[\s-]*selenium/],
    ["lithium-air", /lithium[\s-]*(?:air|oxygen)|li[\s-]*o2/],
    ["lithium metal", /lithium\s+metal|dendrite/], ["solid-state", /solid[\s-]*state/],
    ["sodium-ion", /sodium[\s-]*ion|\bna[\s-]*ion\b|\bsibs?\b/],
    ["potassium-ion", /potassium[\s-]*ion|\bk[\s-]*ion\b/],
    ["zinc-ion", /zinc[\s-]*ion|\bzn[\s-]*ion\b/], ["magnesium-ion", /magnesium[\s-]*ion/],
    ["aluminium-ion", /alumini?um[\s-]*ion/],
    ["lithium-ion", /lithium[\s-]*ion|\bli[\s-]*ion\b|\blibs?\b/]],
  electrode_role: [["anode", /\banode/], ["cathode", /\bcathode/],
    ["separator", /separator|interlayer/], ["current collector", /current\s+collector/],
    ["electrolyte", /electrolyte\s+additive|solid\s+electrolyte/]],
};

const METRICS = [
  ["specific_capacity_mah_g", "mAh/g", "specific capacity", /capacit|mah|\bmah\/g\b/],
  ["capacity_retention_pct", "%", "capacity retention", /retention|retain|stabilit|fade|degrad/],
  ["cycle_count", "cycles", "cycle life", /cycl|\blife\b|durab|longev/],
  ["current_density_ma_g", "mA/g", "current density", /current\s+density|\ba\/g\b|\bma\/g\b/],
  ["c_rate", "C", "C-rate", /c-?rate|rate\s+capab|\bfast\s+charg/],
  ["first_cycle_ce_pct", "%", "first-cycle coulombic efficiency", /coulombic|\bice\b|efficien/],
  ["areal_loading_mg_cm2", "mg/cm2", "areal loading", /loading|areal/],
];

const OUT_OF_REMIT = [
  [/\bshould\s+(?:i|we|you)\b/, "asks for advice"],
  [/\b(?:invest|investment|investor|stock|shares|share\s+price|ticker|valuation)\b(?!igat)/, "asks about investment"],
  [/\b(?:company|companies|startup|supplier|vendor|manufacturer)\b/, "asks about companies, not measurements"],
  [/\b(?:forecast|predict|projection)\w*\b/, "asks for a prediction"],
  [/\bwill\b[^?]*\b20[2-9]\d\b/, "asks for a prediction"],
  [/\brecommend\w*\b/, "asks for a recommendation"],
  [/\b(?:buy|purchase|cheapest|price)\b/, "asks about commerce"],
];

// Share of passages a term must appear in before the library claims coverage.
const COVERAGE_FLOOR = 0.008;
// How much of the question an entry's title must account for before the
// knowledge base answers rather than the papers. 560 is roughly 60 % coverage.
const CONCEPT_FLOOR = 560;

/* Researchers and papers often use different words for the same thing. A
   paper writes "rate capability" or "at 1 C" where the question says
   "C-rate"; it writes "solid electrolyte interphase" where the question says
   "SEI". Expanding a term to its field variants finds the passage that was
   always there. Nothing is invented: the quote is still the paper's own. */
const SYNONYM = {
  "c-rate": ["c rate", "rate capability", "rate performance"],
  "crate": ["c rate", "rate capability"],
  "sei": ["solid electrolyte interphase", "solid-electrolyte interphase"],
  "interphase": ["interphase", "sei"],
  "ice": ["initial coulombic efficiency", "first-cycle coulombic efficiency"],
  "rgo": ["reduced graphene oxide"],
  "go": ["graphene oxide"],
  "lib": ["lithium-ion battery", "lithium ion battery"],
  "sib": ["sodium-ion battery", "sodium ion battery"],
  "cnt": ["carbon nanotube"],
  "cvd": ["chemical vapour deposition", "chemical vapor deposition"],
  "xrd": ["x-ray diffraction"],
  "xps": ["x-ray photoelectron"],
  "sem": ["scanning electron"],
  "tem": ["transmission electron"],
  "eis": ["impedance spectroscopy"],
  "cv": ["cyclic voltammetry"],
  "bet": ["specific surface area", "brunauer"],
  "cyclability": ["cycle life", "cycling stability"],
  "lifetime": ["cycle life"],
  "conductivity": ["conductivity", "conductive"],
};
const variants = (t) => [t].concat(SYNONYM[t] || []);
const anyIn = (low, t) => variants(t).some((v) => low.includes(v));

const GENERIC = new Set(("point high low good better performance material materials study "
  + "result results value values work paper show shows shown using used use new novel effect "
  + "effects based via well also more most than between during after before when where while "
  + "stop stops help helps make makes give gives many much long does reach reaches get gets "
  + "what which how the and for are with from about their there that this can tell me you "
  + "please does do is was were been have has had").split(" "));

const stem = (t) => {
  const l = t.toLowerCase();
  for (const [s, r] of [["ies", "y"], ["sses", "ss"], ["es", ""], ["s", ""]])
    if (l.endsWith(s) && l.length - s.length >= 4) return l.slice(0, -s.length) + r;
  return l;
};
const terms = (q) => {
  const seen = new Set(), out = [];
  (q.toLowerCase().match(/[a-z0-9][a-z0-9\-\/]+/g) || []).forEach((t) => {
    if (GENERIC.has(t) || t.length <= 2) return;
    const r = stem(t);
    if (GENERIC.has(r) || seen.has(r)) return;
    seen.add(r); out.push(r);
  });
  return out;
};
const match1 = (list, text) => { for (const [l, re] of list) if (re.test(text)) return l; return null; };

/* ── statistics ─────────────────────────────────────────── */
function spread(a) {
  const s = a.slice().sort((x, y) => x - y);
  const q = (p) => { const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
  return { n: s.length, min: s[0], max: s[s.length - 1], median: q(.5),
    p25: q(.25), p75: q(.75), values: s };
}

function pick(f) {
  const t = (s) => String(s || "").toLowerCase();
  return DATA.rows.filter((r) => {
    if (r.confidence === "unverified") return false;
    if (f.partner && !t(r.material_system).includes(t(f.partner))) return false;
    if (f.graphene_form && !f.partner && t(r.graphene_form) !== t(f.graphene_form)) return false;
    if (f.battery_type && t(r.battery_type) !== t(f.battery_type)) return false;
    if (f.electrode_role && t(r.electrode_role) !== t(f.electrode_role)) return false;
    return true;
  });
}

/* ── reference entries ──────────────────────────────────── */
const DEFINITIONAL = [
  /\bwhat\s+(?:is|are|was|were)\b/, /\bwhat'?s\b/, /^\s*define\b/i,
  /\bexplain\b/, /\bmeaning\s+of\b/, /\btell\s+me\s+about\b/,
  /\bwhat\s+does\b.*\bmean\b/, /\bhow\s+does\b.*\bwork\b/,
  /\bintroduction\s+to\b/, /\boverview\s+of\b/, /\bdifference\s+between\b/,
];
const isDefinitional = (q) => DEFINITIONAL.some((re) => re.test(q.toLowerCase()));

const STRIP = /^(?:what|whats|what's|who|define|explain|tell me about|the|a|an|is|are|does|do|meaning of|overview of|introduction to)\s+/i;

function conceptQuery(q) {
  let t = String(q).toLowerCase().replace(/[?.!]+\s*$/, "").trim();
  for (let i = 0; i < 4; i++) t = t.replace(STRIP, "").trim();
  return t;
}

/* Whole-word containment. Plain substring matching made "melting point of
   tungsten" look like a question about tin, because "tin" sits inside
   "melting". */
const wordRe = new Map();
function hasWord(haystack, needle) {
  if (!needle) return false;
  let re = wordRe.get(needle);
  if (!re) {
    re = new RegExp(`(?:^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^a-z0-9]|$)`, "i");
    wordRe.set(needle, re);
  }
  return re.test(haystack);
}

function findConcepts(question, limit = 5) {
  if (!DATA.concepts.length) return [];
  const q = conceptQuery(question);
  const qt = terms(q);
  if (!q) return [];
  const scored = [];
  for (const c of DATA.concepts) {
    const title = c.title.toLowerCase();
    const tt = terms(title);
    let score = 0;
    // Containment alone is far too loose: "what capacity do silicon graphene
    // anodes reach" contains "silicon", but it is not asking what silicon is.
    // Score by how much of the question the entry's title actually accounts for.
    if (title === q) score = 1000;
    else if (hasWord(q, title))
      score = 200 + Math.round((title.length / Math.max(q.length, 1)) * 650);
    else if (hasWord(title, q))
      score = 150 + Math.round((q.length / Math.max(title.length, 1)) * 500);
    if (!score && tt.length) {
      const hit = tt.filter((w) => qt.includes(w)).length;
      if (hit === tt.length) score = 300 + hit * 10;
      else if (hit) score = hit * 40 - Math.abs(tt.length - hit) * 5;
    }
    if (!score && qt.length) {
      const sum = (c.summary || "").toLowerCase();
      const hit = qt.filter((w) => sum.includes(w)).length;
      if (hit === qt.length && qt.length >= 2) score = 60;
    }
    if (score > 0) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => ({ ...x.c, _score: x.score }));
}

function papersAbout(text, n = 5) {
  const t = terms(text);
  if (!t.length) return [];
  const out = [];
  for (const p of DATA.passages) {
    const title = (p.t || "").toLowerCase();
    const hit = t.filter((w) => title.includes(w)).length;
    if (hit >= Math.min(2, t.length)) out.push({ p, hit });
    if (out.length > 400) break;
  }
  out.sort((a, b) => b.hit - a.hit);
  return out.slice(0, n).map((x) => x.p);
}

function measurementsAbout(text, n = 4) {
  const t = terms(text);
  if (!t.length) return [];
  return DATA.rows.filter((r) => {
    const hay = `${r.material_system} ${r.graphene_form} ${r.battery_type} ${r.electrode_role}`.toLowerCase();
    return t.some((w) => hay.includes(w));
  }).sort((a, b) => (b.confidence === "verified") - (a.confidence === "verified")
      || (b.specific_capacity_mah_g || 0) - (a.specific_capacity_mah_g || 0)).slice(0, n);
}

/* ── question understanding ─────────────────────────────── */
const NUMUNIT = new RegExp(
  "(\\d+(?:[.,]\\d+)?)\\s*(mah\\s*\\/?\\s*g|mah\\s*g-?1|ah\\s*\\/?\\s*kg|a\\s*\\/?\\s*g|"
  + "ma\\s*\\/?\\s*g|mg\\s*\\/?\\s*cm2?|volts?|\\bv\\b|cycles?|%|\\bc\\b)", "gi");

function readQuantities(q) {
  const out = { voltage: null, capacity: null, current: null, cycles: null,
    percent: [], crate: null, numbers: [] };
  for (const m of String(q).matchAll(NUMUNIT)) {
    const v = Number(m[1].replace(",", "")), u = m[2].toLowerCase().replace(/\s+/g, "");
    out.numbers.push(v);
    if (/^(mah\/g|mahg-?1|ah\/kg)$/.test(u)) out.capacity = out.capacity ?? v;
    else if (u === "a/g") out.current = out.current ?? v * 1000;
    else if (u === "ma/g") out.current = out.current ?? v;
    else if (/^volts?$|^v$/.test(u)) out.voltage = out.voltage ?? v;
    else if (/^cycles?$/.test(u)) out.cycles = out.cycles ?? v;
    else if (u === "%") out.percent.push(v);
    else if (u === "c") out.crate = out.crate ?? v;
  }
  return out;
}

function understand(question) {
  const low = " " + question.toLowerCase() + " ";
  const facets = {
    partner: match1(V.partner, low), graphene_form: match1(V.graphene_form, low),
    battery_type: match1(V.battery_type, low), electrode_role: match1(V.electrode_role, low),
  };
  const metrics = METRICS.filter(([, , , re]) => re.test(low));
  const blocked = OUT_OF_REMIT.find(([re]) => re.test(low));
  const compare = /\bcompar|\bversus\b|\bvs\.?\b|\bwhich\b.*\b(better|best|highest|lowest|strongest)|\brank\b|\bagainst\b/.test(low);
  const trend = /\btrend|over\s+time|since\s+20\d\d|by\s+year|improv\w*\s+over|getting\s+better/.test(low);
  const quantities = readQuantities(question);
  const wantsCalc = /\bcalculat|\bwhat\s+is\s+the\s+energy|energy\s+density|\bfade\b|\bconvert\b|\bper\s+cycle\b/.test(low)
    || (quantities.voltage !== null && quantities.capacity !== null);
  return { facets, metrics, blocked: blocked ? blocked[1] : null, compare, trend,
    quantities, wantsCalc, low };
}

function renderLive(r) {
  if (!r.available)
    return `<h3>Live search unavailable</h3>
      <p class="sub" style="margin:0">${esc(r.reason || "the service did not answer")}.</p>`;
  const rows = (r.rows || []).slice(0, 8);
  const fresh = (r.papers || []).filter((p) => !p.already_in_library).slice(0, 6);
  return `<h3>Fetched from the literature just now</h3>
    <p class="sub" style="margin:0 0 14px">Searched <b>${esc(r.query)}</b> and read
      ${(r.papers || []).length} papers, <b>${r.new_to_library}</b> of them not in the
      library. ${esc(r.note || "")}</p>
    ${rows.length ? `<div class="srcs">${rows.map((row, i) => `
      <div class="src ${row.confidence === "flagged" ? "flagged" : ""}" style="--i:${i}">
        <div class="n">L${i + 1}</div><div>
        <div class="t">${esc(row.title || "")}</div>
        <div class="m"><span>${esc(row.journal || "")}</span><span>${row.year || ""}</span>
          <span>${esc(row.material_system || "")}</span>
          <span>${row.already_in_library ? "already stored" : "new"}</span></div>
        <div class="qt">${esc((row.source_quote || "").slice(0, 300))}</div>
      </div></div>`).join("")}</div>`
      : `<p class="sub" style="margin:0">No measurement could be read from these
         abstracts. The papers themselves are listed below.</p>`}
    ${fresh.length ? `<div class="csec" style="margin-top:18px">
      <h3>Papers new to the library</h3>
      ${fresh.map((p) => `<div class="cpaper" style="cursor:default">
        <b>${esc(p.title || "")}</b><span>${esc(p.journal || "")} \u00b7 ${p.year || ""}
        ${p.doi ? ` \u00b7 ${esc(p.doi)}` : ""}</span></div>`).join("")}</div>` : ""}`;
}

/* ── knowledge browser ──────────────────────────────────── */
let exCat = null;
function paintExplore(q = "") {
  const cats = [...new Set(DATA.concepts.map((c) => c.category))];
  $("excats").innerHTML = [`<button data-c="" aria-pressed="${!exCat}">All ${DATA.concepts.length}</button>`]
    .concat(cats.map((c) => `<button data-c="${esc(c)}" aria-pressed="${exCat === c}">${esc(c)}
      <span class="dim">${DATA.concepts.filter((x) => x.category === c).length}</span></button>`)).join("");
  const t = q.toLowerCase().trim();
  const list = DATA.concepts.filter((c) =>
    (!exCat || c.category === exCat)
    && (!t || c.title.toLowerCase().includes(t) || (c.summary || "").toLowerCase().includes(t)
        || (c.description || "").toLowerCase().includes(t)));
  $("exempty").hidden = list.length > 0;
  if (!list.length) {
    $("exgrid").innerHTML = "";
    $("exempty").innerHTML = `<strong>No entry matches that.</strong>
      The knowledge base covers graphene, carbon materials, batteries and the
      techniques used to measure them. Try a broader word.`;
    return;
  }
  const groups = {};
  list.forEach((c) => { (groups[c.category] = groups[c.category] || []).push(c); });
  $("exgrid").innerHTML = Object.entries(groups).map(([cat, items], gi) => `
    <div class="exgroup" style="--g:${gi}"><h3>${esc(cat)} \u00b7 ${items.length}</h3>
    <div class="excards">${items.map((c, i) => `<button class="excard" style="--i:${i}" data-concept="${esc(c.slug)}">
      <b>${esc(c.title)}</b>${c.description ? `<i>${esc(c.description)}</i>` : ""}
      <p>${esc((c.summary || "").slice(0, 190))}</p></button>`).join("")}</div></div>`).join("");
}
$("exq").addEventListener("input", deb((e) => paintExplore(e.target.value)));
$("excats").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  exCat = b.dataset.c || null; paintExplore($("exq").value);
});

/* ── telling a non-specialist what a screen is ──────────── */
/* A table of 2,794 rows with a column called "coulombic efficiency" tells a
   chemist a great deal and a research director nothing at all. Each of these
   screens opens with the same three things in plain words: what it holds, what
   one row of it means, and what to do with it. It can be folded away, and the
   choice is remembered, so it never becomes furniture for someone who has read
   it once. */
const PRIMERS = {
  evidence: {
    title: "What this screen holds",
    lead: "Battery performance figures, pulled out of published papers one sentence at a time.",
    points: [
      ["One card is one measurement",
       "Someone built an electrode, measured it, and wrote the number in a paper. That number is the card. Nothing here is averaged, estimated or generated."],
      ["Click any card to see the proof",
       "It opens the exact sentence the number came from, with the figures highlighted, and a link to the paper. If you disagree with a number, you can go and argue with the author."],
      ["Capacity, in mAh/g, is the headline",
       "How much charge a gram of the material holds. Higher is better. Graphite, used in the battery in your phone, manages about 372."],
      ["Verified and flagged",
       "Every row is checked against physical limits and its own arithmetic. Rows that fail are kept and labelled, never deleted \u2014 hiding them would make the library look better than it is."],
    ],
  },
  properties: {
    title: "What this screen holds",
    lead: "What graphene measures at, outside the battery: heat, electricity, strength, light, filtration.",
    points: [
      ["Twelve properties, each in its own unit",
       "Thermal conductivity in W/mK, sheet resistance in ohms per square, stiffness in GPa. Use the buttons to pick one \u2014 comparing across units is meaningless."],
      ["The median is far below the famous number",
       "Graphene conducts heat at about 5,300 W/mK as a single sheet. The median here is nearer 10, because most papers measure graphene mixed into something else. Both are true. That is why everything is grouped before it is compared."],
      ["One card is one sentence of one paper",
       "Click it to read that sentence. The conditions \u2014 temperature, thickness, whether the sheet was suspended \u2014 are only whatever the sentence happened to state."],
    ],
  },
  sources: {
    title: "What this screen holds",
    lead: "Every paper that contributed at least one measurement, and how many it gave.",
    points: [
      ["These are the receipts",
       "The library draws on 37,027 papers. These are the ones a number was actually read from, so they are the ones worth checking."],
      ["Follow the DOI",
       "Each row links to the published paper. Nothing in this tool asks to be taken on trust."],
    ],
  },
  explore: {
    title: "What this screen holds",
    lead: "Plain definitions of the terms the rest of the tool uses, from open reference sources.",
    points: [
      ["Start here if a word is unfamiliar",
       "Anode, C-rate, chemical vapour deposition, Raman spectroscopy. Each entry says where it came from and links to the original."],
      ["Where a term is also measured, the numbers come too",
       'Ask "what is Young\u2019s modulus" and you get the definition and what this library measures it at.'],
    ],
  },
  calculator: {
    title: "What this screen holds",
    lead: "Twenty-eight working calculations, each showing its formula and its inputs.",
    points: [
      ["Nothing is hidden",
       "Every calculator prints the formula it used, the numbers you gave it, and a note on what the result does and does not mean."],
      ["The values shown are worked examples",
       "Replace them with yours. The result updates as you type."],
    ],
  },
};

function primerKey(view) { return "gba.primer." + view; }

function primerHTML(view) {
  const d = PRIMERS[view];
  if (!d) return "";
  return `<section class="primer" data-primer="${view}">
    <button class="primer-x" aria-label="Hide this explanation">&times;</button>
    <h3>${esc(d.title)}</h3>
    <p class="lead">${esc(d.lead)}</p>
    <dl>${d.points.map(([k, v], i) => `<div style="--i:${i}">
      <dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
  </section>`;
}

function mountPrimer(view, host) {
  if (!host || !PRIMERS[view]) return;
  if (host.querySelector(`[data-primer="${view}"]`)) return;
  let hidden = false;
  try { hidden = localStorage.getItem(primerKey(view)) === "off"; } catch (e) {}
  const wrap = document.createElement("div");
  wrap.innerHTML = hidden
    ? `<button class="primer-show" data-primer-show="${view}">
         What am I looking at?</button>`
    : primerHTML(view);
  host.prepend(wrap.firstElementChild);
}

document.addEventListener("click", (e) => {
  const x = e.target.closest(".primer-x");
  if (x) {
    const sec = x.closest(".primer");
    const view = sec.dataset.primer;
    sec.classList.add("folding");
    setTimeout(() => {
      const b = document.createElement("button");
      b.className = "primer-show";
      b.dataset.primerShow = view;
      b.textContent = "What am I looking at?";
      sec.replaceWith(b);
    }, 320);
    try { localStorage.setItem(primerKey(view), "off"); } catch (err) {}
    return;
  }
  const show = e.target.closest("[data-primer-show]");
  if (show) {
    const view = show.dataset.primerShow;
    const wrap = document.createElement("div");
    wrap.innerHTML = primerHTML(view);
    show.replaceWith(wrap.firstElementChild);
    try { localStorage.removeItem(primerKey(view)); } catch (err) {}
  }
});

/* ── properties view ────────────────────────────────────── */
let prFam = null;

function prCard(r, i) {
  const cond = [r.application, r.graphene_form].filter(Boolean);
  return `<button class="mcard ${r.confidence === "flagged" ? "fl" : ""}"
      style="--i:${i}" data-prid="${r.id}">
    <div class="mhead"><span class="mmat">${esc(r.property_label)}</span>
      <span class="mchem">${esc(r.material || "graphene")}</span></div>
    <div class="mbig">${sig(r.value)}<u>${esc(r.unit)}</u></div>
    ${cond.length ? `<div class="mcond">${cond.map((c) =>
      `<span class="mchip">${esc(c)}</span>`).join("")}</div>` : ""}
    <div class="mpaper">${esc(r.title || "")}</div>
    <div class="mmeta"><span>${esc(r.journal || "")}</span><span>${r.year || ""}</span>
      ${r.confidence === "flagged"
        ? `<span class="mflag">&#9873; flagged</span>` : `<span>verified</span>`}</div>
  </button>`;
}

function paintProps(q = "") {
  const all = DATA.properties || [];
  const fams = DATA.property_families || [];
  const count = (k) => all.filter((r) => r.property_key === k).length;
  $("prfams").innerHTML = [`<button data-f="" aria-pressed="${!prFam}">All <span class="dim">${fmt(all.length)}</span></button>`]
    .concat(fams.filter((f) => count(f.key)).map((f) =>
      `<button data-f="${esc(f.key)}" aria-pressed="${prFam === f.key}">${esc(f.label)}
        <span class="dim">${count(f.key)}</span></button>`)).join("");

  const term = q.toLowerCase().trim();
  const list = all.filter((r) =>
    (!prFam || r.property_key === prFam)
    && (!term || (r.material || "").toLowerCase().includes(term)
        || (r.title || "").toLowerCase().includes(term)
        || (r.application || "").toLowerCase().includes(term)
        || (r.property_label || "").toLowerCase().includes(term)));

  const fam = prFam ? fams.find((f) => f.key === prFam) : null;
  if (fam && list.length >= 2) {
    const s = spread(list.filter((r) => r.confidence === "verified")
      .map((r) => Number(r.value)));
    $("prstat").innerHTML = `<div class="pstat">
      <div><b>${sig(s.median)}</b><u>${esc(fam.unit)}</u><span>median of ${s.n} verified</span></div>
      <div><b>${sig(s.p25)}&ndash;${sig(s.p75)}</b><u>${esc(fam.unit)}</u><span>middle half</span></div>
      <div><b>${sig(s.min)}&ndash;${sig(s.max)}</b><u>${esc(fam.unit)}</u><span>full range</span></div>
    </div>`;
  } else {
    $("prstat").innerHTML = "";
  }

  $("prempty").hidden = list.length > 0;
  if (!list.length) {
    $("prgrid").innerHTML = "";
    $("prempty").innerHTML = `<strong>No measurement matches that.</strong>
      Try a graphene form, an application, or clear the filter.`;
    return;
  }
  const CAP = 120;
  const shown = Math.min(CAP, list.length);
  const what = prFam
    ? `${fmt(list.length)} measurements of ${fam.label.toLowerCase()}`
    : `${fmt(list.length)} measurements across ${fams.filter((f) => count(f.key)).length} properties`;
  $("pr-sub").textContent = list.length > CAP
    ? `${what}, highest first. Showing the top ${shown} \u2014 narrow with the search box.`
    : `${what}, each read from one sentence of one paper.`;
  $("prgrid").innerHTML = list.slice(0, CAP).map((r, i) => prCard(r, i)).join("");
}

$("prq").addEventListener("input", deb((e) => paintProps(e.target.value)));
$("prfams").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  prFam = b.dataset.f || null; paintProps($("prq").value);
});
$("prgrid").addEventListener("click", (e) => {
  const b = e.target.closest("[data-prid]"); if (!b) return;
  const r = (DATA.properties || []).find((x) => String(x.id) === b.dataset.prid);
  if (r) openProp(r);
});

function openConcept(slug) {
  const c = DATA.concepts.find((x) => x.slug === slug);
  if (!c) return;
  const papers = papersAbout(c.title, 6);
  const rows = measurementsAbout(c.title, 5);
  const related = DATA.concepts.filter((x) => x.slug !== c.slug && x.category === c.category)
    .slice(0, 10);
  const calcs = (DATA.calculators || []).filter((k) =>
    terms(c.title).some((w) => `${k.label} ${k.description}`.toLowerCase().includes(w))).slice(0, 6);
  $("conceptbody").innerHTML = `<div class="cpage">
    <button class="btn cback" data-back><svg class="ic" viewBox="0 0 22 22" style="transform:rotate(180deg)"><use href="#i-arrow"/></svg>Knowledge base</button>
    <div class="ckicker">${esc(c.category || "")}</div>
    <h1 class="ctitle">${esc(c.title)}</h1>
    ${c.description ? `<p class="cdesc">${esc(c.description)}</p>` : ""}
    <div class="cbody">${esc(c.summary)}</div>
    <div class="cattr">From ${esc(c.source === "wikipedia" ? "Wikipedia" : c.source || "an open source")},
      licensed ${esc(c.licence || "")}. Stored verbatim so you can check it against the original.
      <a href="${esc(c.url)}" target="_blank" rel="noopener">Open the source</a>.</div>
    ${rows.length ? `<div class="csec"><h3>Measurements involving this</h3>
      <div class="srcs">${rows.map((r, i) => srcCard(r, i + 1)).join("")}</div></div>` : ""}
    ${papers.length ? `<div class="csec"><h3>Papers in the library</h3>
      ${papers.map((p) => `<button class="cpaper" data-pass="${esc(p.i)}">
        <b>${esc(p.t || "")}</b><span>${esc(p.j || "")} \u00b7 ${p.y || ""}</span></button>`).join("")}</div>` : ""}
    ${calcs.length ? `<div class="csec"><h3>Calculators</h3><div class="crel">
      ${calcs.map((k) => `<button data-calc="${esc(k.name)}">${esc(k.label)}</button>`).join("")}</div></div>` : ""}
    ${related.length ? `<div class="csec"><h3>More in ${esc(c.category || "this area")}</h3>
      <div class="crel">${related.map((r) => `<button data-concept="${esc(r.slug)}">${esc(r.title)}</button>`).join("")}</div></div>` : ""}
    <div class="csec"><h3>Ask about it</h3><div class="crel">
      <button data-ask="What is ${esc(c.title)}?">What is ${esc(c.title)}?</button>
      <button data-ask="${esc(c.title)} capacity">Measurements for ${esc(c.title)}</button>
    </div></div></div>`;
  show("concept");
  document.querySelector(".view[data-view=concept] .mid").scrollTop = 0;
}

document.addEventListener("click", async (e) => {
  const liveBtn = e.target.closest("[data-live]");
  if (liveBtn) {
    const host = liveBtn.closest(".out") || liveBtn.closest(".refusal")?.parentElement;
    liveBtn.disabled = true; liveBtn.textContent = "Searching the literature\u2026";
    let panel = document.createElement("div");
    panel.className = "card"; panel.style.marginTop = "16px";
    (host || document.body).appendChild(panel);
    try {
      const r = await fetch(`api/live?q=${encodeURIComponent(liveBtn.dataset.live)}`)
        .then((x) => x.json());
      panel.innerHTML = renderLive(r);
      animateBlocks(panel);
    } catch (err) {
      panel.innerHTML = `<h3>Live search</h3><p class="sub">Could not reach the
        literature service. ${esc(String(err.message || err))}</p>`;
    }
    liveBtn.textContent = "Searched";
    return;
  }
  const c = e.target.closest("[data-concept]");
  if (c) { openConcept(c.dataset.concept); return; }
  const back = e.target.closest("[data-back]");
  if (back) { show("explore"); return; }
  const k = e.target.closest("[data-calc]");
  if (k) { show("calculator"); setTimeout(() => {
    const card = document.querySelector(`.calc[data-n="${k.dataset.calc}"]`);
    if (card) { card.scrollIntoView({ block: "center" });
      card.style.borderColor = "var(--acc)"; } }, 60); return; }
  const q = e.target.closest("[data-ask]");
  if (q) { show("ask"); ask(q.dataset.ask); }
});

/* ── calculators ────────────────────────────────────────── */
const CALCS = [
  ["energy_density", "Specific energy of an electrode.", ["voltage_v", "capacity_mah_g"],
    (i) => ["energy (Wh/kg) = voltage (V) x capacity (mAh/g) / 1000", i.voltage_v * i.capacity_mah_g / 1000, "Wh/kg"]],
  ["specific_capacity", "Capacity from a galvanostatic discharge.", ["current_ma", "time_h", "mass_g"],
    (i) => ["capacity (mAh/g) = current (mA) x time (h) / mass (g)", i.current_ma * i.time_h / i.mass_g, "mAh/g"]],
  ["c_rate", "C-rate from a current density.", ["current_ma_g", "capacity_mah_g"],
    (i) => ["C-rate = current (mA/g) / capacity (mAh/g)", i.current_ma_g / i.capacity_mah_g, "C"]],
  ["coulombic_efficiency", "Charge returned against charge put in.", ["discharge_mah_g", "charge_mah_g"],
    (i) => ["efficiency (%) = discharge / charge x 100", i.discharge_mah_g / i.charge_mah_g * 100, "%"]],
  ["capacity_fade_per_cycle", "Average loss per cycle.", ["initial_mah_g", "final_mah_g", "cycles"],
    (i) => ["fade (%/cycle) = (initial - final) / initial / cycles x 100",
      (i.initial_mah_g - i.final_mah_g) / i.initial_mah_g / i.cycles * 100, "%/cycle"]],
  ["capacity_retention", "How much capacity is left.", ["initial_mah_g", "final_mah_g"],
    (i) => ["retention (%) = final / initial x 100", i.final_mah_g / i.initial_mah_g * 100, "%"]],
  ["cell_to_pack", "Pack energy from cell energy.", ["cell_wh_kg", "pack_fraction"],
    (i) => ["pack (Wh/kg) = cell (Wh/kg) x packing fraction", i.cell_wh_kg * (i.pack_fraction || .75), "Wh/kg"]],
];
const CALC_BY = Object.fromEntries(CALCS.map((c) => [c[0], c]));

function runCalc(name, inputs) {
  const spec = CALC_BY[name];
  if (!spec) throw new Error("unknown calculation");
  const vals = {};
  for (const k of spec[2]) {
    const n = Number(inputs[k]);
    if (!Number.isFinite(n) || n <= 0) {
      if (k === "pack_fraction") { vals[k] = .75; continue; }
      throw new Error(`${k.replace(/_/g, " ")} must be a positive number`);
    }
    vals[k] = n;
  }
  const [formula, result, unit] = spec[3](vals);
  return { name, formula, inputs: vals, result: +result.toFixed(4), unit };
}

/* ── charts ─────────────────────────────────────────────── */
let tipEl = null;
function tip(html, x, y) {
  if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "ctip";
    document.body.appendChild(tipEl); }
  tipEl.innerHTML = html; tipEl.hidden = false;
  const r = tipEl.getBoundingClientRect();
  tipEl.style.left = Math.min(Math.max(8, x - r.width / 2), innerWidth - r.width - 8) + "px";
  tipEl.style.top = Math.max(8, y - r.height - 12) + "px";
}
const untip = () => { if (tipEl) tipEl.hidden = true; };

/* One extreme value flattens a histogram into a single bar and tells the
   reader nothing. Drop the outer 5% at each end for the picture only; the
   headline figure above it still states the real minimum and maximum. */
function trimTails(values, frac = 0.05) {
  const v = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (v.length < 20) return v;
  const k = Math.floor(v.length * frac);
  const cut = v.slice(k, v.length - k);
  return cut.length >= 5 ? cut : v;
}

function histogram(values, unit, label) {
  const W = 560, H = 170, P = { t: 14, r: 12, b: 30, l: 12 };
  const s = spread(values);
  const bins = Math.min(18, Math.max(6, Math.round(Math.sqrt(values.length))));
  const lo = s.min, hi = s.max === s.min ? s.min + 1 : s.max;
  const w = (hi - lo) / bins;
  const counts = new Array(bins).fill(0);
  values.forEach((v) => { counts[Math.min(bins - 1, Math.floor((v - lo) / w))] += 1; });
  const peak = Math.max(...counts, 1);
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const bw = iw / bins;
  const x = (v) => P.l + ((v - lo) / (hi - lo)) * iw;
  let bars = "";
  counts.forEach((c, i) => {
    const h = c ? Math.max(2, (c / peak) * ih) : 0;
    const bx = P.l + i * bw, by = P.t + ih - h;
    const from = lo + i * w, to = lo + (i + 1) * w;
    const q = c / peak > .75 ? "q4" : c / peak > .45 ? "q3" : c / peak > .2 ? "q2" : "q1";
    bars += `<g class="it" data-tip="${esc(`<b>${c} measurement${c === 1 ? "" : "s"}</b>`
      + `${fmt(from, 0)}&ndash;${fmt(to, 0)} ${unit}`)}">
      <rect class="bar ${q}" x="${bx + 1}" y="${by}" width="${Math.max(1, bw - 2)}" height="${h}" rx="2"></rect>
      <rect class="hit" x="${bx}" y="${P.t}" width="${bw}" height="${ih}"></rect></g>`;
  });
  const mx = x(s.median);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
    aria-label="${esc(`Distribution of ${label}: ${values.length} measurements from ${fmt(s.min, 0)} to ${fmt(s.max, 0)} ${unit}, median ${fmt(s.median, 0)}`)}">
    <line class="ax" x1="${P.l}" y1="${P.t + ih}" x2="${W - P.r}" y2="${P.t + ih}"></line>
    ${bars}
    <line class="med" x1="${mx}" y1="${P.t - 4}" x2="${mx}" y2="${P.t + ih}"></line>
    <text class="medlab" x="${Math.min(W - P.r - 50, mx + 5)}" y="${P.t + 4}">median ${fmt(s.median, 0)}</text>
    <text x="${P.l}" y="${H - 10}">${fmt(s.min, 0)}</text>
    <text x="${W - P.r}" y="${H - 10}" text-anchor="end">${fmt(s.max, 0)} ${esc(unit)}</text>
  </svg>`;
}

function hbars(items, unit, label) {
  const rowH = 27, W = 560, P = { t: 6, r: 74, b: 20, l: 150 };
  const H = P.t + items.length * rowH + P.b;
  const max = Math.max(...items.map((i) => i.value), 1);
  const iw = W - P.l - P.r;
  let body = "";
  items.forEach((it, i) => {
    const y = P.t + i * rowH, bw = Math.max(2, (it.value / max) * iw);
    body += `<g class="it" data-tip="${esc(`<b>${it.name}</b>median ${fmt(it.value, 1)} ${unit}`
      + (it.n ? ` &middot; ${it.n} measurements` : "")
      + (it.p25 !== undefined ? `<br>middle half ${fmt(it.p25, 0)}&ndash;${fmt(it.p75, 0)}` : ""))}">
      <text class="lab" x="${P.l - 10}" y="${y + 14}" text-anchor="end">${esc(it.name)}</text>
      <rect class="bar ${it.q || "q3"}" x="${P.l}" y="${y + 5}" width="${bw}" height="11" rx="3"></rect>
      <text class="val" x="${P.l + bw + 7}" y="${y + 14}">${fmt(it.value, it.value < 10 ? 2 : 0)}</text>
      <rect class="hit" x="0" y="${y}" width="${W}" height="${rowH}"></rect></g>`;
  });
  return `<svg class="chart h" viewBox="0 0 ${W} ${H}" role="img"
    aria-label="${esc(label)}">${body}</svg>`;
}

function trendline(points, unit, label) {
  const W = 560, H = 160, P = { t: 14, r: 16, b: 28, l: 44 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const ys = points.map((p) => p.value);
  const lo = Math.min(...ys) * .92, hi = Math.max(...ys) * 1.06;
  const X = (i) => P.l + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const Y = (v) => P.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
  const path = points.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.value).toFixed(1)}`).join("");
  let dots = "", grid = "";
  [0, .5, 1].forEach((f) => { const gy = P.t + ih - f * ih;
    grid += `<line class="gl" x1="${P.l}" y1="${gy}" x2="${W - P.r}" y2="${gy}"></line>
      <text x="${P.l - 8}" y="${gy + 3}" text-anchor="end">${fmt(lo + f * (hi - lo), 0)}</text>`; });
  points.forEach((p, i) => {
    dots += `<g class="it" data-tip="${esc(`<b>${p.name}</b>median ${fmt(p.value, 0)} ${unit} &middot; ${p.n} measurements`)}">
      <circle cx="${X(i)}" cy="${Y(p.value)}" r="3.5" fill="var(--ink)"
        style="--i:${i}"></circle>
      <rect class="hit" x="${X(i) - 16}" y="${P.t}" width="32" height="${ih}"></rect>
      <text x="${X(i)}" y="${H - 9}" text-anchor="middle">${esc(p.name)}</text></g>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
    ${grid}<path d="${path}" data-draw fill="none" stroke="var(--ink)" stroke-width="1.75"
      stroke-linejoin="round" stroke-linecap="round"></path>${dots}</svg>`;
}

document.addEventListener("mousemove", (e) => {
  const g = e.target.closest ? e.target.closest("g.it[data-tip]") : null;
  if (g) tip(g.dataset.tip, e.clientX, e.clientY); else untip();
});
document.addEventListener("mouseleave", untip);

/* ── building an answer ─────────────────────────────────── */
const subject = (f) => [f.partner, f.graphene_form, f.electrode_role, f.battery_type]
  .filter(Boolean).join(" / ") || "the matching measurements";

function metricStats(rows, field) {
  const v = rows.filter((r) => r[field] !== null && r[field] !== undefined)
                .map((r) => Number(r[field])).filter(Number.isFinite);
  return v.length >= 2 ? spread(v) : (v.length === 1
    ? { n: 1, min: v[0], max: v[0], median: v[0], p25: v[0], p75: v[0], values: v } : null);
}

function groupBy(rows, key, field, minN = 3) {
  const m = new Map();
  rows.forEach((r) => {
    const k = r[key]; if (!k || r[field] === null) return;
    if (!m.has(k)) m.set(k, []); m.get(k).push(Number(r[field]));
  });
  return [...m.entries()].filter(([, v]) => v.length >= minN)
    .map(([name, v]) => ({ name, ...spread(v) }))
    .sort((a, b) => b.median - a.median);
}

/* Enough of these terms close together, not merely present somewhere. A
   graphene paper can mention nuclear magnetic resonance in one sentence and a
   CVD reactor in another; that is not an answer about nuclear reactors. */
function coversInWindow(text, needed, window = 240) {
  const low = text.toLowerCase();
  const hits = [];
  for (const term of needed) {
    let at = low.indexOf(term);
    while (at >= 0) { hits.push([at, term]); at = low.indexOf(term, at + Math.max(1, term.length)); }
  }
  if (!hits.length) return 0;
  hits.sort((a, b) => a[0] - b[0]);
  let best = 0, left = 0;
  for (let right = 0; right < hits.length; right++) {
    while (hits[right][0] - hits[left][0] > window) left++;
    best = Math.max(best, new Set(hits.slice(left, right + 1).map((h) => h[1])).size);
  }
  return best;
}

/* ── physical properties ────────────────────────────────── */
/* The battery table answers "how much charge". A researcher asking about
   graphene as a material wants the thermal conductivity, the sheet resistance,
   the modulus. Those live in their own table with their own units, so the
   question has to say which property before a number can mean anything. */
const APP_WORDS = [
  ["composite", ["composite", "nanocomposite", "epoxy", "polymer", "filler", "matrix"]],
  ["membrane", ["membrane", "desalination", "filtration", "nanofiltration", "water"]],
  ["thermal management", ["thermal management", "heat dissipation", "heat spreader",
                          "thermal interface"]],
  ["supercapacitor", ["supercapacitor", "edlc", "pseudocapacit"]],
  ["transparent electrode", ["transparent", "touch screen", "flexible electrode"]],
  ["EMI shielding", ["shielding", "emi", "electromagnetic"]],
  ["sensor", ["sensor", "sensing", "biosensor"]],
  ["transistor", ["transistor", "fet", "device"]],
  ["coating", ["coating", "corrosion", "barrier"]],
];

function matchProperty(low) {
  const fams = DATA.property_families || [];
  let best = null;
  for (const f of fams) {
    for (const a of f.aliases) {
      const at = low.indexOf(a);
      // Longest alias wins: "ionic conductivity" must beat "conductivity".
      if (at >= 0 && (!best || a.length > best.len)) best = { fam: f, len: a.length };
    }
  }
  return best ? best.fam : null;
}

function propertyAnswer(question, low, fam) {
  let rows = (DATA.properties || []).filter((r) => r.property_key === fam.key);
  if (!rows.length) return null;

  // Narrow by what the question is about, but never to nothing: a filter that
  // empties the set tells the reader less than the whole set does.
  let application = null;
  for (const [name, words] of APP_WORDS) {
    if (words.some((w) => low.includes(w))) {
      const sub = rows.filter((r) => r.application === name);
      if (sub.length >= 3) { rows = sub; application = name; }
      break;
    }
  }
  let material = null;
  const form = (DATA.facets.graphene_form || []).map((f) => f.value)
    .find((v) => v && low.includes(v.toLowerCase()));
  if (form) {
    const sub = rows.filter((r) => r.graphene_form === form);
    if (sub.length >= 3) { rows = sub; material = form; }
  }

  const verified = rows.filter((r) => r.confidence === "verified");
  const used = verified.length >= 3 ? verified : rows;
  const stats = metricStats(used, "value");
  if (!stats) return null;
  const byApp = groupBy(used, "application", "value", 3).slice(0, 7);
  const sorted = [...used].sort((a, b) => b.value - a.value);
  return {
    kind: "property", question, family: fam, application, material,
    stats, byApp,
    rows: sorted,
    top: sorted.slice(0, 6),
    flagged: rows.length - verified.length,
    papers: new Set(used.map((r) => r.openalex_id)).size,
  };
}

function build(question) {
  const u = understand(question);

  if (u.blocked) return { kind: "refused", question, reason: u.blocked,
    why: "The library holds measurements reported in papers, not advice, prices or predictions." };

  /* a calculation the researcher supplied the numbers for */
  if (u.wantsCalc) {
    const q = u.quantities;
    let calc = null;
    try {
      if (q.voltage !== null && q.capacity !== null)
        calc = runCalc("energy_density", { voltage_v: q.voltage, capacity_mah_g: q.capacity });
      else if (q.numbers.length >= 3 && /fade|per\s+cycle/.test(u.low))
        calc = runCalc("capacity_fade_per_cycle", { initial_mah_g: Math.max(q.numbers[0], q.numbers[1]),
          final_mah_g: Math.min(q.numbers[0], q.numbers[1]), cycles: q.cycles ?? q.numbers[2] });
      else if (q.numbers.length >= 2 && /retention|retain/.test(u.low))
        calc = runCalc("capacity_retention", { initial_mah_g: Math.max(q.numbers[0], q.numbers[1]),
          final_mah_g: Math.min(q.numbers[0], q.numbers[1]) });
    } catch (e) { calc = { error: e.message }; }
    if (calc && !calc.error) {
      const rows = pick(u.facets);
      const ctx = rows.length >= 3 ? metricStats(rows, "specific_capacity_mah_g") : null;
      return { kind: "calculation", question, calc, facets: u.facets, rows, context: ctx };
    }
    if (calc && calc.error) return { kind: "refused", question, reason: "could not be computed",
      why: calc.error + ". Give the numbers with their units, for example “1200 mAh/g at 3.7 V”." };
  }

  /* a definition, before anything numeric */
  const defQ = isDefinitional(question);
  const hits = findConcepts(question);
  // A question that names a performance quantity wants the numbers, even when
  // it also names a material the knowledge base happens to have an entry for.
  const wantsNumber = u.metrics.length > 0 || u.compare || u.trend || u.wantsCalc;
  // A definitional question still needs the entry to account for most of what
  // was asked. "Solid electrolyte interphase" contains "electrolyte", but
  // answering with the entry for electrolytes would be the wrong answer stated
  // confidently; better to fall through and quote papers that are about it.
  const strongEnough = hits.length && hits[0]._score >= CONCEPT_FLOOR;
  const fam = matchProperty(u.low);
  if (strongEnough && ((defQ && !u.wantsCalc) || !wantsNumber)) {
    const c = hits[0];
    // A term the library also measures gets its numbers alongside the
    // definition: "what is thermal conductivity" deserves both.
    const famForConcept = fam || matchProperty(c.title.toLowerCase());
    return { kind: "concept", question, concept: c,
      property: famForConcept ? propertyAnswer(question, u.low, famForConcept) : null,
      related: hits.slice(1, 5),
      papers: papersAbout(c.title, 4),
      measurements: measurementsAbout(c.title, 4),
      calculators: (DATA.calculators || []).filter((k) => {
        const hay = `${k.label} ${k.description}`.toLowerCase();
        return terms(c.title).some((w) => hay.includes(w));
      }).slice(0, 4) };
  }

  /* a physical property the library holds numbers for */
  if (fam) {
    const pa = propertyAnswer(question, u.low, fam);
    if (pa) return pa;
  }

  const hasFacet = Object.values(u.facets).some(Boolean);
  let rows = hasFacet ? pick(u.facets) : [];
  if (hasFacet && rows.length < 3)
    rows = pick({ partner: u.facets.partner, battery_type: u.facets.battery_type });
  if (hasFacet && rows.length < 3)
    rows = pick({ partner: u.facets.partner || undefined,
      graphene_form: u.facets.partner ? undefined : u.facets.graphene_form });

  /* comparison across material systems */
  if (u.compare && rows.length >= 6) {
    const field = (u.metrics[0] || METRICS[0])[0];
    const unit = (u.metrics[0] || METRICS[0])[1];
    const label = (u.metrics[0] || METRICS[0])[2];
    const groups = groupBy(rows, "material_system", field);
    if (groups.length >= 2)
      return { kind: "comparison", question, facets: u.facets, rows, groups: groups.slice(0, 9),
        field, unit, label };
  }

  /* how a metric has moved year on year */
  if (u.trend && rows.length >= 8) {
    const [field, unit, label] = u.metrics[0] || METRICS[0];
    const years = groupBy(rows, "year", field, 2)
      .map((g) => ({ ...g, name: String(g.name) }))
      .sort((a, b) => Number(a.name) - Number(b.name));
    if (years.length >= 3)
      return { kind: "trend", question, facets: u.facets, rows, years, field, unit, label };
  }

  /* the ordinary case: a quantity, across the matching measurements */
  if (u.metrics.length && rows.length >= 3) {
    const stats = {};
    const missing = [];
    u.metrics.forEach(([f, unit, label]) => {
      const s = metricStats(rows, f);
      if (s) stats[f] = { ...s, unit, label, field: f }; else missing.push(label);
    });
    const others = [];
    METRICS.forEach(([f, unit, label]) => {
      if (stats[f]) return;
      const s = metricStats(rows, f);
      if (s && s.n >= 3) others.push({ ...s, unit, label, field: f });
    });
    const primary = Object.values(stats)[0];
    if (primary) {
      const siblings = groupBy(DATA.rows.filter((r) =>
        (!u.facets.battery_type || r.battery_type === u.facets.battery_type)
        && (!u.facets.electrode_role || r.electrode_role === u.facets.electrode_role)
        && r.confidence !== "unverified"), "material_system", primary.field, 4).slice(0, 8);
      return { kind: "quantitative", question, facets: u.facets, rows, primary,
        secondary: others.slice(0, 5), missing, siblings };
    }
    return { kind: "quantitative", question, facets: u.facets, rows, primary: null,
      secondary: others.slice(0, 6), missing, siblings: [] };
  }

  /* a mechanism question: quote what the papers say */
  const t = terms(question);
  // One term is enough when it is distinctive and the library demonstrably
  // covers it. "C-rate" is a single word, and a fundamental one.
  if (t.length >= 2 || (t.length === 1 && t[0].length >= 4)) {
    const freq = {};
    t.forEach((x) => { freq[x] = 0; });
    const hits = [];
    for (const p of DATA.passages) {
      const low = p.x.toLowerCase();
      const got = t.filter((x) => anyIn(low, x));
      got.forEach((x) => { freq[x] += 1; });
      // Enough of the question's terms, and close enough together to be about
      // it: a paper can mention nuclear magnetic resonance in one sentence and
      // a CVD reactor in another without being about nuclear reactors.
      if (got.length >= Math.min(2, t.length)
          && got.length / t.length >= .6
          && coversInWindow(p.x, t.flatMap(variants)) >= Math.min(2, t.length))
        hits.push({ p, n: got.length });
      if (hits.length > 300) break;
    }
    // The library must demonstrably cover the subject, not merely contain the
    // word. "Nuclear" and "reactor" each appear in under half a percent of
    // passages, as stray mentions of NMR and CVD reactors; "separator" and
    // "Raman" appear in several percent, because the field is actually about
    // them. Below the floor the honest answer is that we do not cover it.
    const floor = Math.max(8, Math.round(DATA.passages.length * COVERAGE_FLOOR));
    if (t.every((x) => freq[x] > 0)
        && Math.min(...t.map((x) => freq[x])) >= floor) {
      const rarest = t.reduce((a, b) => (freq[a] <= freq[b] ? a : b));
      const strong = hits.filter(({ p }) => anyIn(p.x.toLowerCase(), rarest))
        .sort((a, b) => b.n - a.n).slice(0, 6);
      if (strong.length >= 2)
        return { kind: "passages", question, facets: u.facets, passages: strong.map((h) => h.p) };
    }
  }

  if (hits.length && hits[0]._score >= 320) {
    const c = hits[0];
    return { kind: "concept", question, concept: c, related: hits.slice(1, 5),
      papers: papersAbout(c.title, 4), measurements: measurementsAbout(c.title, 4),
      calculators: [] };
  }

  return { kind: "refused", question, reason: "is not covered by the stored papers",
    why: "Nothing in the library matches closely enough to answer it.",
    facets: u.facets, searched: rows.length };
}

/* ── rendering an answer ────────────────────────────────── */
let refSeq = [];
function refFor(row) {
  let i = refSeq.findIndex((r) => r.kind === "e" && r.row.id === row.id);
  if (i < 0) { refSeq.push({ kind: "e", row }); i = refSeq.length - 1; }
  return i + 1;
}
function refForProp(row) {
  let i = refSeq.findIndex((r) => r.kind === "r" && r.row.id === row.id);
  if (i < 0) { refSeq.push({ kind: "r", row }); i = refSeq.length - 1; }
  return i + 1;
}
function refForPassage(p) {
  let i = refSeq.findIndex((r) => r.kind === "p" && r.p.i === p.i);
  if (i < 0) { refSeq.push({ kind: "p", p }); i = refSeq.length - 1; }
  return i + 1;
}

/* Mark the figures a row claims, so the eye lands on them inside the
   sentence rather than hunting for them. */
function highlightText(quote, strings) {
  const needles = [];
  (strings || []).forEach((s) => {
    if (!s) return;
    String(s).split(/\s+/).forEach((tk) => { if (/^[\d.,]/.test(tk)) needles.push(tk.replace(/[^\d.,]/g, "")); });
  });
  const uniq = [...new Set(needles.filter((n) => n && n.length > 1))]
    .sort((a, b) => b.length - a.length);
  let html = esc(quote);
  uniq.forEach((n) => {
    const safe = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    html = html.replace(new RegExp(`(?<![\\d.])${safe}(?![\\d])`, "g"), (m) => `\u0001${m}\u0002`);
  });
  return html.replace(/\u0001/g, "<mark>").replace(/\u0002/g, "</mark>");
}

function highlight(quote, row) {
  const needles = [];
  const push = (v) => { if (v === null || v === undefined || v === "") return;
    const n = Number(v);
    needles.push(Number.isInteger(n) ? String(n) : String(+n.toFixed(2)).replace(/0+$/, "").replace(/\.$/, ""));
    needles.push(String(v).replace(/\.0+$/, "")); };
  ["specific_capacity_mah_g", "initial_capacity_mah_g", "capacity_retention_pct",
   "cycle_count", "c_rate", "first_cycle_ce_pct", "areal_loading_mg_cm2", "temperature_c"]
    .forEach((f) => push(row[f]));
  [row.capacity_as_reported, row.current_density_as_reported].forEach((s) => {
    if (s) String(s).split(/\s+/).forEach((tk) => { if (/^\d/.test(tk)) needles.push(tk); }); });
  const uniq = [...new Set(needles.filter(Boolean))].sort((a, b) => b.length - a.length);
  let html = esc(quote);
  uniq.forEach((n) => {
    const safe = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    html = html.replace(new RegExp(`(?<![\\d.])${safe}(?![\\d])`, "g"), (m) => `\u0001${m}\u0002`);
  });
  return html.replace(/\u0001/g, "<mark>").replace(/\u0002/g, "</mark>");
}

function srcCard(row, n) {
  const flags = row.flags || [];
  return `<div class="src ${row.confidence === "flagged" ? "flagged" : ""}" data-row="${row.id}">
    <div class="n">${n}</div><div>
      <div class="t">${esc(row.title || "")}</div>
      <div class="m"><span>${esc(row.journal || "")}</span><span>${row.year || ""}</span>
        <span>${esc(row.material_system || "")}</span><span>${esc(row.confidence)}</span></div>
      <div class="qt">${highlight((row.source_quote || "").slice(0, 320), row)}</div>
      ${flags.length ? `<div class="fl">&#9873; ${esc(String(flags[0]).split(":")[0].replace(/_/g, " "))}</div>` : ""}
    </div></div>`;
}

function propCard(r, n) {
  return `<div class="src ${r.confidence === "flagged" ? "flagged" : ""}" data-prow="${r.id}">
    <div class="n">${n}</div><div>
      <div class="t">${esc(r.title || "")}</div>
      <div class="m"><span>${esc(r.journal || "")}</span><span>${r.year || ""}</span>
        <span>${esc(r.material || r.graphene_form || "graphene")}</span>
        <span>${esc(r.confidence)}</span></div>
      <div class="qt">${highlightText((r.source_quote || "").slice(0, 320),
                                      [r.value_as_reported])}</div>
      ${r.flags ? `<div class="fl">&#9873; ${esc(String(r.flags).split(";")[0].replace(/_/g, " "))}</div>` : ""}
    </div></div>`;
}

function openProp(r) {
  const vals = [
    ["Property", r.property_label, 1], ["Value", `${fmt(r.value, r.value < 10 ? 3 : 1)} ${r.unit}`, 1],
    ["As the paper wrote it", r.value_as_reported],
    ["Material", r.material], ["Graphene form", r.graphene_form],
    ["Where it is used", r.application],
  ];
  openDrawer("Source", `
    <div class="m dim" style="font:450 12px var(--mono)">${esc(r.journal || "")}${r.year ? ` &middot; ${r.year}` : ""}
      ${r.doi ? ` &middot; <a href="https://doi.org/${esc(r.doi)}" target="_blank" rel="noopener">${esc(r.doi)}</a>` : ""}</div>
    <div style="font:500 15px/1.45 var(--sans);margin:8px 0 0;max-width:58ch">${esc(r.title || "")}</div>
    <h3>The sentence this row came from</h3>
    <blockquote class="quote">${highlightText(r.source_quote || "", [r.value_as_reported])}</blockquote>
    <p class="sub" style="font-size:12.5px">Read from the <b>abstract</b>.
      Confidence <b>${esc(r.confidence)}</b>. ${r.confidence === "verified"
        ? "The figure above appears in this sentence and sits inside the range this property occupies."
        : "The figure above appears in this sentence. A check flagged it; the reason is below."}</p>
    ${r.flags ? `<h3>Why it is flagged</h3><ul class="fls">${
      String(r.flags).split(";").map((f) => `<li>${esc(f.replace(/_/g, " "))}</li>`).join("")}</ul>` : ""}
    <h3>Extracted values</h3>
    <dl class="kv">${vals.filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v, s]) => `<dt>${esc(k)}</dt><dd class="${s ? "s" : ""}">${esc(v)}</dd>`).join("")}</dl>
    <h3>What this does and does not tell you</h3>
    <p class="sub" style="font-size:12.5px">One sentence of one paper, nothing averaged and nothing
      inferred. A property measured on a suspended single sheet and the same property measured on a
      polymer composite differ by three orders of magnitude and both are correct; the sentence is
      there so you can see which one you are reading.</p>`);
}

function passageCard(p, n) {
  return `<div class="src" data-pass="${esc(p.i)}"><div class="n">${n}</div><div>
    <div class="t">${esc(p.t || "")}</div>
    <div class="m"><span>${esc(p.j || "")}</span><span>${p.y || ""}</span><span>abstract</span></div>
    <div class="qt">${esc(p.x.slice(0, 340))}&hellip;</div></div></div>`;
}

function topRows(rows, field, k = 5) {
  return rows.filter((r) => r[field] !== null)
    .sort((a, b) => (b.confidence === "verified") - (a.confidence === "verified")
      || Number(b[field]) - Number(a[field])).slice(0, k);
}

function metricCard(s) {
  return `<div class="metric"><div class="mv">${fmt(s.median, s.median < 10 ? 2 : 0)}<u>${esc(s.unit)}</u></div>
    <div class="mk">${esc(s.label)}</div>
    <div class="mr">${fmt(s.min, 0)}–${fmt(s.max, 0)} &middot; n=${s.n}</div></div>`;
}

function renderAnswer(a) {
  refSeq = [];
  const blocks = [];

  if (a.kind === "refused") {
    blocks.push(`<div class="refusal"><h3>Not in the library</h3>
      <p>This question ${esc(a.reason)}. ${esc(a.why)}</p>
      <p class="dim">The library holds ${fmt(DATA.stats.evidence_rows)} measurements from
        ${fmt(DATA.stats.papers)} papers across graphene — batteries, electronics, sensors,
        membranes, composites, biomedicine and more — plus ${fmt(DATA.stats.concepts)} reference
        entries. Instant mode answers definitions and performance figures by rule. For a
        question that needs reasoning across several of those, switch to Agent.</p></div>`);
    return { html: blocks.join(""), refs: [] };
  }

  if (a.kind === "concept") {
    const c = a.concept;
    blocks.push(`<div class="defcard"><div class="k">reference entry \u00b7 ${esc(c.category || "")}</div>
      <h3>${esc(c.title)}</h3>
      ${c.description ? `<p class="dim" style="font-size:13.5px;margin-bottom:10px">${esc(c.description)}</p>` : ""}
      <p>${esc(c.summary)}</p>
      <div class="src2">From ${esc(c.source === "wikipedia" ? "Wikipedia" : c.source || "an open source")},
        ${esc(c.licence || "")} \u00b7
        <a href="${esc(c.url)}" target="_blank" rel="noopener">read the full entry</a></div></div>`);

    if (a.property) {
      const pr = a.property, f = pr.family, s = pr.stats;
      blocks.push(`<div class="card"><h3>What this library measures it at</h3>
        <div class="pstat"><div><b>${sig(s.median)}</b><u>${esc(f.unit)}</u>
            <span>median of ${s.n} measurements</span></div>
          <div><b>${sig(s.p25)}&ndash;${sig(s.p75)}</b><u>${esc(f.unit)}</u>
            <span>middle half</span></div>
          <div><b>${sig(s.min)}&ndash;${sig(s.max)}</b><u>${esc(f.unit)}</u>
            <span>full range, ${pr.papers} papers</span></div></div>
        ${pr.byApp.length >= 2 ? hbars(pr.byApp.map((g, i) => ({ name: g.name,
            value: g.median, n: g.n, p25: g.p25, p75: g.p75,
            q: i === 0 ? "q4" : i < 3 ? "q3" : "q2" })), f.unit,
            `Median ${f.label} by application`) : ""}
        <div class="srcs" style="margin-top:14px">${pr.top.slice(0, 3)
          .map((r) => propCard(r, refForProp(r))).join("")}</div>
        <p class="sub" style="margin:12px 0 0">Measured on very different things. A suspended
          sheet and a polymer composite are both graphene and sit orders of magnitude apart.</p></div>`);
    }
    if (a.measurements.length) {
      blocks.push(`<div class="card"><h3>What the measurements say about this</h3>
        <div class="srcs">${a.measurements.map((r) => srcCard(r, refFor(r))).join("")}</div></div>`);
    }
    if (a.papers.length) {
      blocks.push(`<div class="csec"><h3>Papers in the library on this</h3>
        ${a.papers.map((p) => `<button class="cpaper" data-pass="${esc(p.i)}">
          <b>${esc(p.t || "")}</b><span>${esc(p.j || "")} \u00b7 ${p.y || ""}</span></button>`).join("")}</div>`);
    }
    if (a.calculators.length) {
      blocks.push(`<div class="csec"><h3>Related calculators</h3><div class="crel">
        ${a.calculators.map((k) => `<button data-calc="${esc(k.name)}">${esc(k.label)}</button>`).join("")}
        </div></div>`);
    }
    if (a.related.length) {
      blocks.push(`<div class="csec"><h3>Related entries</h3><div class="crel">
        ${a.related.map((r) => `<button data-concept="${esc(r.slug)}">${esc(r.title)}</button>`).join("")}
        </div></div>`);
    }
    return { html: blocks.join(""), refs: refSeq };
  }

  if (a.kind === "calculation") {
    const c = a.calc;
    blocks.push(`<div class="headline"><div class="lbl">${esc(c.name.replace(/_/g, " "))}</div>
      <div class="big">${fmt(c.result, 2)}<u>${esc(c.unit)}</u></div>
      <div class="sub"><b>${esc(c.formula)}</b></div>
      <div class="sub">${Object.entries(c.inputs).map(([k, v]) =>
        `${esc(k.replace(/_/g, " "))} = ${fmt(v, 3)}`).join(" &middot; ")}</div></div>`);
    if (a.context) {
      const pct = a.context.values.filter((v) => v <= (a.calc.inputs.capacity_mah_g || 0)).length
        / a.context.n * 100;
      blocks.push(`<div class="card"><h3>How that input compares with the library</h3>
        ${histogram(a.context.values, "mAh/g", "specific capacity")}
        <p class="sub" style="margin:12px 0 0">Across ${a.context.n} measurements of
          ${esc(subject(a.facets))}, the median is <b>${fmt(a.context.median, 0)} mAh/g</b>.
          ${a.calc.inputs.capacity_mah_g ? `Your ${fmt(a.calc.inputs.capacity_mah_g, 0)} mAh/g sits above
          ${fmt(pct, 0)}% of them.` : ""}</p></div>`);
    }
    blocks.push(`<div class="gap">This figure comes from the formula above, not from any
      paper. The library is used only for the comparison.</div>`);
    return { html: blocks.join(""), refs: [] };
  }

  if (a.kind === "passages") {
    blocks.push(`<div class="prose"><p>No comparable numbers were extracted for this question.
      ${a.passages.length} papers discuss it directly, quoted below exactly as written.</p></div>`);
    blocks.push(`<div class="srcs">${a.passages.map((p) =>
      passageCard(p, refForPassage(p))).join("")}</div>`);
    return { html: blocks.join(""), refs: refSeq };
  }

  const papers = new Set(a.rows.map((r) => r.openalex_id)).size;
  const flagged = a.rows.filter((r) => r.confidence === "flagged").length;
  const years = a.rows.map((r) => r.year).filter(Boolean);

  if (a.kind === "comparison") {
    const items = a.groups.map((g, i) => ({ name: g.name, value: g.median, n: g.n,
      p25: g.p25, p75: g.p75, q: i === 0 ? "q4" : i < 3 ? "q3" : "q2" }));
    const best = a.groups[0];
    blocks.push(`<div class="headline"><div class="lbl">highest median ${esc(a.label)}</div>
      <div class="big txt">${esc(best.name)}</div>
      <div class="sub"><b>${fmt(best.median, 1)} ${esc(a.unit)}</b> across ${best.n} measurements
        &middot; middle half ${fmt(best.p25, 0)}–${fmt(best.p75, 0)}</div></div>`);
    blocks.push(`<div class="card"><h3>Median ${esc(a.label)} by material system</h3>
      ${hbars(items, a.unit, `Median ${a.label} by material system`)}
      <p class="sub" style="margin:12px 0 0">Only systems with three or more measurements are
        shown. Medians hide spread — hover any bar for its middle half.</p></div>`);
    const cites = a.groups.slice(0, 4).flatMap((g) =>
      topRows(a.rows.filter((r) => r.material_system === g.name), a.field, 1));
    blocks.push(`<div class="srcs">${cites.map((r) => srcCard(r, refFor(r))).join("")}</div>`);
    blocks.push(gapBlock(a, papers, flagged, years));
    return { html: blocks.join(""), refs: refSeq };
  }

  if (a.kind === "trend") {
    const pts = a.years.map((y) => ({ name: y.name, value: y.median, n: y.n }));
    const first = pts[0], last = pts[pts.length - 1];
    const change = ((last.value - first.value) / first.value) * 100;
    blocks.push(`<div class="headline"><div class="lbl">${esc(a.label)}, ${first.name} to ${last.name}</div>
      <div class="big">${change >= 0 ? "+" : ""}${fmt(change, 0)}<u>%</u></div>
      <div class="sub">median moved from <b>${fmt(first.value, 0)}</b> to
        <b>${fmt(last.value, 0)} ${esc(a.unit)}</b></div></div>`);
    blocks.push(`<div class="card"><h3>Median ${esc(a.label)} by publication year</h3>
      ${trendline(pts, a.unit, `Median ${a.label} by year`)}
      <p class="sub" style="margin:12px 0 0">Each point is the median of that year's
        measurements. A year with few papers moves a long way on little evidence.</p></div>`);
    blocks.push(`<div class="srcs">${topRows(a.rows, a.field, 4)
      .map((r) => srcCard(r, refFor(r))).join("")}</div>`);
    blocks.push(gapBlock(a, papers, flagged, years));
    return { html: blocks.join(""), refs: refSeq };
  }

  if (a.kind === "property") {
    const f = a.family, s = a.stats;
    const scope = a.application ? ` in ${a.application}s` : a.material ? ` for ${a.material}` : "";
    blocks.push(`<div class="headline"><div class="lbl">median ${esc(f.label.toLowerCase())}${esc(scope)}</div>
      <div class="big">${sig(s.median)}<u>${esc(f.unit)}</u></div>
      <div class="sub">from <b>${s.n}</b> measurements across <b>${a.papers}</b> papers
        &middot; middle half <b>${sig(s.p25)}&ndash;${sig(s.p75)}</b>
        &middot; full range ${sig(s.min)}&ndash;${sig(s.max)} ${esc(f.unit)}</div></div>`);

    const right = a.byApp.length >= 2
      ? `<div class="card"><h3>By what it was measured on</h3>
          ${hbars(a.byApp.map((g, i) => ({ name: g.name, value: g.median, n: g.n,
             p25: g.p25, p75: g.p75, q: i === 0 ? "q4" : i < 3 ? "q3" : "q2" })),
             f.unit, `Median ${f.label} by application`)}
          <p class="sub" style="margin:12px 0 0">A single suspended sheet and the same material
            in a polymer sit orders of magnitude apart. Group before comparing.</p></div>`
      : `<div class="card"><h3>The highest reported</h3>
          <table class="mini"><tbody>${a.top.map((r) => `<tr>
            <th>${esc((r.title || r.material || "graphene").slice(0, 58))}${
              (r.title || "").length > 58 ? "&hellip;" : ""}
              <span class="dim" style="display:block;font:450 10.5px var(--mono)">${
                esc([r.material, r.application, r.year].filter(Boolean).join(" \u00b7 "))}</span></th>
            <td class="num">${sig(r.value)}
            <span class="dim">${esc(f.unit)}</span></td></tr>`).join("")}</tbody></table></div>`;

    blocks.push(`<div class="grid2">
      <div class="card"><h3>How those ${s.n} measurements are spread</h3>
        ${histogram(trimTails(a.rows.map((r) => Number(r.value))), f.unit,
                    `${f.label} distribution`)}
        <p class="sub" style="margin:12px 0 0">Each bar counts measurements, not papers. A
          property can span five orders of magnitude, so the highest and lowest 5% are left off
          this chart to keep the rest readable &mdash; the full range is in the figure above, and
          every measurement is under Measurements.</p></div>
      ${right}</div>`);

    blocks.push(`<div class="srcs">${a.top.slice(0, 4)
      .map((r) => propCard(r, refForProp(r))).join("")}</div>`);
    blocks.push(`<div class="gap"><h3>What this does not settle</h3><p>
      ${a.flagged ? `${a.flagged} of these were flagged by a check and are excluded from the
        figures above; they stay visible under Measurements. ` : ""}Every figure was read from one
      sentence of one abstract, so the measurement conditions &mdash; temperature, sample
      thickness, whether the sheet was suspended or supported &mdash; are only whatever that
      sentence happened to state. Open any card to read it.</p></div>`);
    return { html: blocks.join(""), refs: refSeq };
  }

  /* quantitative */
  const p = a.primary;
  if (p) {
    blocks.push(`<div class="headline"><div class="lbl">median ${esc(p.label)} &middot; ${esc(subject(a.facets))}</div>
      <div class="big">${fmt(p.median, p.median < 10 ? 2 : 0)}<u>${esc(p.unit)}</u></div>
      <div class="sub">from <b>${p.n}</b> measurements across <b>${papers}</b> papers
        &middot; middle half <b>${fmt(p.p25, 0)}–${fmt(p.p75, 0)}</b>
        &middot; full range ${fmt(p.min, 0)}–${fmt(p.max, 0)} ${esc(p.unit)}</div></div>`);
    blocks.push(`<div class="grid2">
      <div class="card"><h3>How those ${p.n} measurements are spread</h3>
        ${histogram(p.values, p.unit, p.label)}</div>
      <div class="card"><h3>Conditions reported alongside</h3>
        <div class="metrics">${a.secondary.length ? a.secondary.map(metricCard).join("")
          : `<p class="sub" style="margin:0">These papers report no other conditions.</p>`}</div></div>
    </div>`);
    if (a.siblings.length >= 2) {
      const here = subject(a.facets);
      const items = a.siblings.map((g) => ({ name: g.name, value: g.median, n: g.n,
        p25: g.p25, p75: g.p75,
        q: (a.facets.partner && g.name.toLowerCase().includes(String(a.facets.partner).toLowerCase())) ? "q4" : "q2" }));
      blocks.push(`<div class="card"><h3>Set against other material systems</h3>
        ${hbars(items, p.unit, `Median ${p.label} across material systems`)}
        <p class="sub" style="margin:12px 0 0">Highlighted bars are the systems matching
          ${esc(here)}.</p></div>`);
    }
  } else {
    blocks.push(`<div class="headline"><div class="lbl">${esc(subject(a.facets))}</div>
      <div class="big">${a.rows.length}<u>measurements</u></div>
      <div class="sub">none of them state the quantity you asked about</div></div>`);
    if (a.secondary.length) blocks.push(`<div class="card"><h3>What these papers do report</h3>
      <div class="metrics">${a.secondary.map(metricCard).join("")}</div></div>`);
  }
  const field = p ? p.field : "specific_capacity_mah_g";
  blocks.push(`<div class="srcs">${topRows(a.rows, field, 5)
    .map((r) => srcCard(r, refFor(r))).join("")}</div>`);
  blocks.push(gapBlock(a, papers, flagged, years));
  return { html: blocks.join(""), refs: refSeq };
}

function gapBlock(a, papers, flagged, years) {
  const bits = [];
  bits.push(`Drawn from <b>${a.rows.length}</b> measurements in <b>${papers}</b> papers`);
  if (years.length) bits.push(`published <b>${Math.min(...years)}–${Math.max(...years)}</b>`);
  if (flagged) bits.push(`<b>${flagged}</b> flagged by an automated check and kept, not hidden`);
  let s = bits.join(", ") + ".";
  if (a.missing && a.missing.length)
    s += ` These papers do not state <b>${a.missing.map(esc).join(", ")}</b>.`;
  s += ` Nothing here is estimated: an absent value means the paper never gave one.`;
  return `<div class="gap">${s}</div>`;
}

/* Index everything that should arrive in sequence, measure each line so it
   can draw itself, and run the headline figure up to its value. */
function animateBlocks(root) {
  if (!root) return;
  stagger(root, ".src");
  stagger(root, ".metric");
  root.querySelectorAll("svg.chart").forEach((svg) => {
    svg.querySelectorAll(".bar").forEach((b, i) => b.style.setProperty("--i", i));
    svg.querySelectorAll("path[data-draw]").forEach((p) => {
      try { p.style.setProperty("--len", p.getTotalLength()); } catch (e) { /* no layout */ }
    });
  });
  const big = root.querySelector(".headline .big");
  if (big) {
    const first = big.firstChild;
    if (first && first.nodeType === 3) {
      const raw = first.textContent.trim().replace(/,/g, "");
      const value = Number(raw);
      if (Number.isFinite(value)) {
        const decimals = (raw.split(".")[1] || "").length;
        const span = document.createElement("span");
        big.replaceChild(span, first);
        countUp(span, value, decimals);
      }
    }
  }
}

/* ── views ──────────────────────────────────────────────── */
function show(v) {
  document.querySelectorAll(".sitem").forEach((t) =>
    t.setAttribute("aria-selected", String(t.dataset.view === v
      || (v === "concept" && t.dataset.view === "explore"))));
  document.querySelectorAll(".view").forEach((s) => { s.hidden = s.dataset.view !== v; });
  if (v === "calculator" && !calcsBuilt) buildCalcs($("calcq").value);
  if (v === "explore") paintExplore($("exq").value);
  if (v === "notebook") paintNotebook();
  if (v === "sources" && !$("sb").children.length) paintSources();
  if (v === "evidence" && !$("gb").children.length) reload();
  if (v === "properties") paintProps($("prq").value);

  // Say in plain words what the screen is, before the data arrives.
  // .mid for the single-column screens; .pane for the two that carry a filter
  // rail beside them, where prepending to the section would break the row.
  const section = document.querySelector(`.view[data-view="${v}"]`);
  if (section) mountPrimer(v, section.querySelector(".mid")
                              || section.querySelector(".pane") || section);
}
document.querySelectorAll(".sitem").forEach((t) =>
  t.addEventListener("click", () => show(t.dataset.view)));

/* ── ask flow ───────────────────────────────────────────── */
let busy = false;
function traceFor(a) {
  const s = [];
  s.push(["Parsing the question", Object.entries(a.facets || {}).filter(([, v]) => v)
    .map(([, v]) => v).join(", ") || "no material named", ""]);
  if (a.kind === "refused" && a.reason !== "is not covered by the stored papers")
    s.push(["Checking scope", "outside what measurements can answer", ""]);
  else if (a.kind === "concept") {
    s.push(["Searching the knowledge base", a.concept.title, "match"]);
    if (a.property)
      s.push(["Searching property measurements", a.property.family.label.toLowerCase(),
        `${a.property.stats.n}`]);
    s.push(["Linking papers and measurements", "",
      `${a.papers.length + a.measurements.length}`]);
  }
  else if (a.kind === "calculation")
    s.push(["Running the calculation", a.calc.name.replace(/_/g, " "),
      `${fmt(a.calc.result, 2)} ${a.calc.unit}`]);
  else if (a.kind === "property")
    s.push(["Identifying the property", a.family.label.toLowerCase(), a.family.unit],
      ["Searching property measurements",
        a.application || a.material || "all of graphene", `${a.stats.n}`],
      ["Grouping before comparing", "median per application", `${a.byApp.length}`],
      ["Collecting source sentences", "one per cited number", ""]);
  else if (a.kind === "passages")
    s.push(["Searching measurements", "no numeric match", "0"],
      ["Reading paper abstracts", "keyword match", `${a.passages.length}`]);
  else if (a.kind === "refused")
    s.push(["Searching measurements", "no close match", `${a.searched || 0}`],
      ["Reading paper abstracts", "no close match", "0"]);
  else {
    s.push(["Searching measurements", subject(a.facets), `${a.rows.length}`]);
    if (a.kind === "comparison") s.push(["Grouping by material system", "median per group", `${a.groups.length}`]);
    if (a.kind === "trend") s.push(["Grouping by publication year", "median per year", `${a.years.length}`]);
    if (a.kind === "quantitative" && a.primary)
      s.push(["Computing the spread", a.primary.label, `n=${a.primary.n}`]);
    if (a.kind === "quantitative" && a.siblings && a.siblings.length)
      s.push(["Comparing with other systems", "median per system", `${a.siblings.length}`]);
    s.push(["Collecting source sentences", "one per cited number", ""]);
  }
  return s;
}

async function ask(question) {
  if (busy || !question.trim()) return;
  busy = true;
  $("send").disabled = true;
  $("hero").hidden = true; $("chips").hidden = true;

  const turn = document.createElement("div");
  turn.className = "turn";
  turn.innerHTML = `<div class="q"><div class="av">You</div><div class="t">${esc(question)}</div></div>
    <div class="trace"><div class="trace-h">Working<button class="lnk" data-hide hidden>Hide</button></div>
      <div class="tl"></div></div>
    <div class="out"></div>`;
  $("thread").appendChild(turn);
  turn.scrollIntoView({ behavior: "smooth", block: "start" });

  const a = build(question);
  const steps = traceFor(a);
  const list = turn.querySelector(".tl");
  for (let i = 0; i < steps.length; i++) {
    const [w, d, n] = steps[i];
    const row = document.createElement("div");
    row.className = "tr";
    row.innerHTML = `<span class="d"></span><span class="w">${esc(w)}${d ? ` <b>${esc(d)}</b>` : ""}</span>
      <span class="n">${esc(n)}</span>`;
    list.appendChild(row);
    await new Promise((r) => setTimeout(r, 130));
  }

  const { html, refs } = renderAnswer(a);
  const out = turn.querySelector(".out");
  out.innerHTML = html + `<div class="acts">
    <button class="btn" data-save>Save to notebook</button>
    ${API ? `<button class="btn" data-live="${esc(question)}">Search live literature</button>`
          : ""}
    <span class="dim">${refs.length} source${refs.length === 1 ? "" : "s"}</span></div>`;
  animateBlocks(out);
  turn.querySelector("[data-hide]").hidden = false;
  turn.querySelector("[data-hide]").addEventListener("click", (e) => {
    const tl = turn.querySelector(".tl");
    tl.hidden = !tl.hidden; e.target.textContent = tl.hidden ? "Show" : "Hide";
  });
  out.querySelector("[data-save]").addEventListener("click", (e) => {
    saveNote(question, out.innerText.slice(0, 900), refs.length);
    e.target.textContent = "Saved"; e.target.disabled = true;
  });
  busy = false; $("send").disabled = false; $("ask").focus();
}

$("thread").addEventListener("click", (e) => {
  const r = e.target.closest("[data-row]");
  if (r) { const row = DATA.rows.find((x) => String(x.id) === r.dataset.row);
    if (row) openRow(row); return; }
  const pr = e.target.closest("[data-prow]");
  if (pr) { const row = (DATA.properties || []).find((x) => String(x.id) === pr.dataset.prow);
    if (row) openProp(row); return; }
  const p = e.target.closest("[data-pass]");
  if (p) { const pa = DATA.passages.find((x) => x.i === p.dataset.pass);
    if (pa) openPassage(pa); }
});

const ta = $("ask");
ta.addEventListener("input", () => { ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 170) + "px"; });
ta.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("form").requestSubmit(); } });
$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = ta.value.trim(); if (!q) return;
  ta.value = ""; ta.style.height = "auto";
  (MODE === "agent" ? askAgent : ask)(q);
});

const CHIPS = [
  "What is graphene?",
  "What thermal conductivity do graphene composites reach?",
  "What capacity do silicon graphene anodes reach in lithium-ion batteries?",
  "Sheet resistance of graphene transparent electrodes",
  "What is the Young's modulus of graphene?",
  "Compare material systems on capacity in lithium-ion anodes",
  "Water permeance of graphene oxide membranes",
  "An electrode at 1200 mAh/g and 3.7 V \u2014 what is the energy density?",
  "Explain chemical vapor deposition",
  "How has capacity changed by year for graphene anodes?",
];

/* ── drawer ─────────────────────────────────────────────── */
/* An overlay that vanishes on close feels broken however well it opened, so
   the exit is animated too and the element is hidden only once it finishes.
   The timeout is the fallback for reduced motion, where no animation runs. */
function closeOverlay(el, backdrop) {
  if (el.hidden || el.dataset.closing) return;
  el.dataset.closing = "1";
  el.classList.add("closing"); backdrop.classList.add("closing");
  let done = false;
  const finish = () => {
    if (done) return; done = true;
    el.hidden = true; backdrop.hidden = true;
    el.classList.remove("closing"); backdrop.classList.remove("closing");
    delete el.dataset.closing;
  };
  el.addEventListener("animationend", finish, { once: true });
  setTimeout(finish, 320);
}

function openDrawer(title, html) {
  $("dt").textContent = title; $("db").innerHTML = html;
  $("bd").hidden = false; $("drawer").hidden = false;
  $("drawer").classList.remove("closing"); $("bd").classList.remove("closing");
  stagger($("db"), ".src, mark");
  $("dclose").focus();
}
const closeDrawer = () => closeOverlay($("drawer"), $("bd"));
$("dclose").addEventListener("click", closeDrawer);
$("bd").addEventListener("click", closeDrawer);

function openRow(r) {
  const vals = [
    ["Material system", r.material_system, 1], ["Graphene form", r.graphene_form, 1],
    ["Electrode role", r.electrode_role, 1], ["Chemistry", r.battery_type, 1],
    ["Specific capacity", r.specific_capacity_mah_g !== null ? `${fmt(r.specific_capacity_mah_g, 2)} mAh/g` : null],
    ["As the paper wrote it", r.capacity_as_reported],
    ["Initial capacity", r.initial_capacity_mah_g !== null ? `${fmt(r.initial_capacity_mah_g, 2)} mAh/g` : null],
    ["Current density", r.current_density_ma_g !== null ? `${fmt(r.current_density_ma_g, 2)} mA/g` : null],
    ["As the paper wrote it", r.current_density_as_reported],
    ["C-rate", r.c_rate !== null ? `${fmt(r.c_rate, 2)} C` : null],
    ["Cycles", fmt(r.cycle_count)],
    ["Capacity retention", r.capacity_retention_pct !== null ? `${fmt(r.capacity_retention_pct, 2)} %` : null],
    ["First-cycle efficiency", r.first_cycle_ce_pct !== null ? `${fmt(r.first_cycle_ce_pct, 2)} %` : null],
    ["Voltage window", r.voltage_window_v], ["Electrolyte", r.electrolyte],
    ["Temperature", r.temperature_c !== null ? `${fmt(r.temperature_c, 1)} °C` : null],
    ["Areal loading", r.areal_loading_mg_cm2 !== null ? `${fmt(r.areal_loading_mg_cm2, 2)} mg/cm2` : null],
  ];
  openDrawer("Source", `
    <div class="m dim" style="font:450 12px var(--mono)">${esc(r.journal || "")}${r.year ? ` &middot; ${r.year}` : ""}
      ${r.doi ? ` &middot; <a href="https://doi.org/${esc(r.doi)}" target="_blank" rel="noopener">${esc(r.doi)}</a>` : ""}</div>
    <div style="font:500 15px/1.45 var(--sans);margin:8px 0 0;max-width:58ch">${esc(r.title || "")}</div>
    <h3>The sentence this row came from</h3>
    <blockquote class="quote">${highlight(r.source_quote || "", r)}</blockquote>
    <p class="sub" style="font-size:12.5px">Read from the <b>${esc(r.source_section || "abstract")}</b>.
      Confidence <b>${esc(r.confidence)}</b>. ${r.confidence === "verified"
        ? "Every number above appears in this sentence and passed all automated checks."
        : "Every number above appears in this sentence. A check flagged it; the reason is below."}</p>
    ${(r.flags || []).length ? `<h3>Why it is flagged</h3><ul class="fls">${
      (r.flags || []).map((f) => { const [k, ...rest] = String(f).split(":");
        return `<li>${esc(k.replace(/_/g, " "))}<span>${rest.length ? ": " + esc(rest.join(":")) : ""}</span></li>`;
      }).join("")}</ul>` : ""}
    <h3>Extracted values</h3>
    <dl class="kv">${vals.filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v, s]) => `<dt>${esc(k)}</dt><dd class="${s ? "s" : ""}">${esc(v)}</dd>`).join("")}</dl>
    <h3>What the checks cannot tell you</h3>
    <p class="sub" style="font-size:12.5px">They test physical plausibility, internal arithmetic,
      group outliers and unit sanity. They cannot tell whether a plausible number was measured
      under the conditions this row claims, cannot catch a paper that is itself wrong, and cannot
      judge whether a comparison is scientifically fair. Read the sentence.</p>`);
}

function openPassage(p) {
  openDrawer("Paper", `
    <div class="dim" style="font:450 12px var(--mono)">${esc(p.j || "")}${p.y ? ` &middot; ${p.y}` : ""}
      ${p.d ? ` &middot; <a href="https://doi.org/${esc(p.d)}" target="_blank" rel="noopener">${esc(p.d)}</a>` : ""}</div>
    <div style="font:500 15px/1.45 var(--sans);margin:8px 0 0;max-width:58ch">${esc(p.t || "")}</div>
    <h3>Abstract, as stored</h3><blockquote class="quote">${esc(p.x)}</blockquote>
    <p class="sub" style="font-size:12.5px">No measurement was extracted from this paper for the
      question asked. The text is shown unchanged so you can judge it yourself.</p>`);
}

/* ── evidence table ─────────────────────────────────────── */
const BHUE = { "lithium-ion": "var(--c1)", "sodium-ion": "var(--c2)", "lithium-sulfur": "var(--c3)" };
const FHUE = { rGO: "var(--c1)", "graphene oxide": "var(--c2)", graphene: "var(--c3)" };
const hue = (m, k) => m[k] || "var(--c0)";

const T = { filters: { confidence: "verified" }, sort: "specific_capacity_mah_g",
  dir: "desc", rows: [], total: 0, off: 0, lim: 60, capMax: 1, loading: false,
  layout: "cards" };

const COLS = [
  ["material_system", "Material", "", (r) =>
    `<span class="chip"><i class="dot" style="background:${hue(FHUE, r.graphene_form)}"></i>${esc(r.material_system || "-")}</span>`],
  ["battery_type", "Chemistry", "", (r) => r.battery_type
    ? `<span class="chip"><i class="dot" style="background:${hue(BHUE, r.battery_type)}"></i>${esc(r.battery_type)}</span>` : NR],
  ["electrode_role", "Role", "", (r) => esc(r.electrode_role || "") || NR],
  ["specific_capacity_mah_g", "Capacity", "num", (r) => {
    if (r.specific_capacity_mah_g === null) return NR;
    const v = Number(r.specific_capacity_mah_g);
    const pct = Math.max(2, Math.min(100, v / T.capMax * 100));
    const q = v > 2000 ? "q4" : v > 1000 ? "q3" : v > 400 ? "q2" : "q1";
    return `<span class="barcell"><span>${fmt(v, 1)}<span class="u">mAh/g</span></span>
      <span class="minibar ${q}" aria-hidden="true"><i style="width:${pct}%"></i></span></span>`; }],
  ["current_density_ma_g", "Current", "num", (r) => r.current_density_ma_g === null ? NR
    : `${fmt(r.current_density_ma_g, 1)}<span class="u">mA/g</span>`],
  ["c_rate", "Rate", "num", (r) => r.c_rate === null ? NR : `${fmt(r.c_rate, 2)}<span class="u">C</span>`],
  ["cycle_count", "Cycles", "num", (r) => r.cycle_count === null ? NR : fmt(r.cycle_count)],
  ["capacity_retention_pct", "Retention", "num", (r) => r.capacity_retention_pct === null ? NR
    : `${fmt(r.capacity_retention_pct, 1)}<span class="u">%</span>`],
  ["first_cycle_ce_pct", "First-cycle CE", "num", (r) => r.first_cycle_ce_pct === null ? NR
    : `${fmt(r.first_cycle_ce_pct, 1)}<span class="u">%</span>`],
  ["year", "Year", "num", (r) => r.year ? String(r.year) : NR],
  ["title", "Paper", "", (r) => `${r.confidence === "flagged"
    ? '<span style="color:var(--flag)" title="Flagged">&#9873;</span> ' : ""}${esc(r.title || "")}`],
];

function head() {
  $("gh").innerHTML = COLS.map(([k, l, c]) => {
    const on = T.sort === k;
    return `<th class="${c}" data-k="${k}" tabindex="0" role="columnheader"${
      on ? ` aria-sort="${T.dir === "desc" ? "descending" : "ascending"}"` : ""}>${esc(l)}${
      on ? `<span class="ar">${T.dir === "desc" ? "↓" : "↑"}</span>` : ""}</th>`;
  }).join("");
  $("gh").querySelectorAll("th").forEach((th) => {
    const go = () => { if (T.sort === th.dataset.k) T.dir = T.dir === "desc" ? "asc" : "desc";
      else { T.sort = th.dataset.k; T.dir = "desc"; } reload(); };
    th.addEventListener("click", go);
    th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}

function keep(r, f) {
  const t = (s) => String(s || "").toLowerCase();
  if (f.confidence && r.confidence !== f.confidence) return false;
  if (f.material && !t(r.material_system).includes(t(f.material))) return false;
  if (f.graphene_form && r.graphene_form !== f.graphene_form) return false;
  if (f.electrode_role && r.electrode_role !== f.electrode_role) return false;
  if (f.battery_type && r.battery_type !== f.battery_type) return false;
  if (f.year_min != null && !(r.year >= f.year_min)) return false;
  if (f.year_max != null && !(r.year <= f.year_max)) return false;
  if (f.capacity_min != null && !(r.specific_capacity_mah_g >= f.capacity_min)) return false;
  if (f.capacity_max != null && !(r.specific_capacity_mah_g <= f.capacity_max)) return false;
  if (f.cycles_min != null && !(r.cycle_count >= f.cycles_min)) return false;
  if (f.q) { const s = t(f.q);
    if (!(t(r.title).includes(s) || t(r.source_quote).includes(s) || t(r.material_system).includes(s))) return false; }
  return true;
}

const sorted = (rows) => rows.slice().sort((a, b) => {
  const d = T.dir === "desc" ? -1 : 1, x = a[T.sort], y = b[T.sort];
  if (x === null || x === undefined) return 1;
  if (y === null || y === undefined) return -1;
  return typeof x === "string" ? d * x.localeCompare(y) : d * (x - y);
});

function reload() {
  T.off = 0; T.rows = [];
  $("gb").innerHTML = ""; $("mcards").innerHTML = "";
  head(); more();
}

/* One measurement as something a person can read, rather than a row of cells.
   The dense table is still a click away for anyone who wants it. */
function mcard(r, i) {
  const cond = [];
  if (r.current_density_ma_g !== null) cond.push(`${fmt(r.current_density_ma_g, 0)} mA/g`);
  if (r.c_rate !== null) cond.push(`${fmt(r.c_rate, 2)} C`);
  if (r.cycle_count !== null) cond.push(`${fmt(r.cycle_count)} cycles`);
  if (r.capacity_retention_pct !== null) cond.push(`${fmt(r.capacity_retention_pct, 0)}% kept`);
  if (r.first_cycle_ce_pct !== null) cond.push(`${fmt(r.first_cycle_ce_pct, 0)}% first cycle`);
  const headline = r.specific_capacity_mah_g !== null
    ? `${fmt(r.specific_capacity_mah_g, 0)}<u>mAh/g</u>`
    : (r.capacity_retention_pct !== null
        ? `${fmt(r.capacity_retention_pct, 0)}<u>% retained</u>` : `<span class="nr">no headline figure</span>`);
  return `<button class="mcard ${r.confidence === "flagged" ? "fl" : ""}"
      style="--i:${i}" data-id="${r.id}">
    <div class="mhead"><span class="mmat">${esc(r.material_system || "unnamed")}</span>
      <span class="mchem">${esc(r.battery_type || "chemistry not stated")}${
        r.electrode_role ? " \u00b7 " + esc(r.electrode_role) : ""}</span></div>
    <div class="mbig">${headline}</div>
    ${cond.length ? `<div class="mcond">${cond.map((c) =>
      `<span class="mchip">${esc(c)}</span>`).join("")}</div>` : ""}
    <div class="mpaper">${esc(r.title || "")}</div>
    <div class="mmeta"><span>${esc(r.journal || "")}</span><span>${r.year || ""}</span>
      ${r.confidence === "flagged"
        ? `<span class="mflag">&#9873; flagged</span>` : `<span>verified</span>`}</div>
  </button>`;
}

function setLayout(mode) {
  T.layout = mode;
  document.querySelectorAll("[data-grid]").forEach((b) =>
    b.setAttribute("aria-checked", String(b.dataset.grid === mode)));
  $("mcards").hidden = mode !== "cards";
  $("mtable").hidden = mode !== "table";
  $("mnote").innerHTML = mode === "cards"
    ? `Each card is one measurement, taken from one sentence of one paper. Click it
       to read that sentence. <button class="lnk" id="more">What the checks cover</button>`
    : `Every number was read from one sentence of one paper. An empty cell means the
       paper did not state the value.
       <button class="lnk" id="more">What the checks cover</button>`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-grid]");
  if (b) setLayout(b.dataset.grid);
  const card = e.target.closest(".mcard");
  if (card) { const r = DATA.rows.find((x) => String(x.id) === card.dataset.id);
    if (r) openRow(r); }
});

function more() {
  if (T.loading) return; T.loading = true;
  const all = sorted(DATA.rows.filter((r) => keep(r, T.filters)));
  T.total = all.length;
  if (!T.off) { const top = all.find((r) => r.specific_capacity_mah_g !== null);
    T.capMax = Math.max(400, top ? Number(top.specific_capacity_mah_g) : 400); }
  const page = all.slice(T.off, T.off + T.lim);
  T.rows.push(...page); T.off += page.length;
  $("mcards").insertAdjacentHTML("beforeend", page.map((r, i) => mcard(r, i)).join(""));
  $("gb").insertAdjacentHTML("beforeend", page.map((r) =>
    `<tr class="${r.confidence === "flagged" ? "fl" : ""}" data-id="${r.id}" tabindex="0">${
      COLS.map(([, , c, f]) => `<td class="${c}">${f(r)}</td>`).join("")}</tr>`).join(""));
  $("rc").textContent = `${T.total.toLocaleString("en-GB")} measurement${T.total === 1 ? "" : "s"}`;
  $("rd").textContent = `showing ${T.rows.length.toLocaleString("en-GB")}`;
  $("ge").hidden = T.total !== 0;
  $("mtable").hidden = T.layout !== "table";
  $("mcards").hidden = T.layout !== "cards";
  if (!T.total) $("ge").innerHTML = `<strong>No measurements match these filters.</strong>
    Clear the narrowest one first — capacity range and minimum cycles exclude the most rows,
    because many papers do not state them.`;
  T.loading = false;
}

$("gw").addEventListener("scroll", (e) => {
  const el = e.target;
  if (el.scrollTop + el.clientHeight > el.scrollHeight - 420 && T.rows.length < T.total) more();
});
$("gb").addEventListener("click", (e) => {
  const tr = e.target.closest("tr");
  if (tr) { const r = DATA.rows.find((x) => String(x.id) === tr.dataset.id); if (r) openRow(r); } });
$("gb").addEventListener("keydown", (e) => {
  const tr = e.target.closest("tr"); if (!tr) return;
  if (e.key === "Enter") { e.preventDefault();
    const r = DATA.rows.find((x) => String(x.id) === tr.dataset.id); if (r) openRow(r); }
  if (e.key === "ArrowDown" && tr.nextElementSibling) { e.preventDefault(); tr.nextElementSibling.focus(); }
  if (e.key === "ArrowUp" && tr.previousElementSibling) { e.preventDefault(); tr.previousElementSibling.focus(); }
});

const FL = { confidence: "Confidence", battery_type: "Chemistry", graphene_form: "Graphene form",
  electrode_role: "Electrode role", material_system: "Material system" };
const FP = { confidence: "confidence", battery_type: "battery_type", graphene_form: "graphene_form",
  electrode_role: "electrode_role", material_system: "material" };

function paintFacets() {
  Object.keys(FL).forEach((k) => {
    const host = $("f-" + k); if (!host) return;
    const items = (DATA.facets[k] || []).slice(0, k === "material_system" ? 18 : 12);
    host.innerHTML = `<h3>${esc(FL[k])}</h3>` + items.map((it) => {
      const col = k === "battery_type" ? hue(BHUE, it.value) : k === "graphene_form" ? hue(FHUE, it.value)
        : k === "confidence" ? (it.value === "flagged" ? "var(--flag)" : "var(--c0)") : null;
      return `<button class="fi" data-f="${k}" data-v="${esc(it.value)}" aria-pressed="${
        String(T.filters[FP[k]] === it.value)}">${col ? `<i class="dot" style="background:${col}"></i>` : ""}
        <span>${k === "confidence" && it.value === "flagged" ? "&#9873; " : ""}${esc(it.value)}</span>
        <span class="n">${it.count.toLocaleString("en-GB")}</span></button>`;
    }).join("");
  });
  document.querySelectorAll(".fi").forEach((b) => b.addEventListener("click", () => {
    const p = FP[b.dataset.f], on = b.getAttribute("aria-pressed") === "true";
    document.querySelectorAll(`.fi[data-f="${b.dataset.f}"]`).forEach((o) => o.setAttribute("aria-pressed", "false"));
    if (on) delete T.filters[p]; else { b.setAttribute("aria-pressed", "true"); T.filters[p] = b.dataset.v; }
    reload();
  }));
}

// declared as a function so listeners registered earlier in the file can use it
function deb(fn, ms = 240) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
[["fq", "q"], ["fcmin", "capacity_min", Number], ["fcmax", "capacity_max", Number],
 ["fcyc", "cycles_min", Number], ["fymin", "year_min", Number], ["fymax", "year_max", Number]]
  .forEach(([id, p, cast = (v) => v]) => {
    const el = $(id);
    el.addEventListener("input", deb(() => { const v = el.value.trim();
      if (v === "") delete T.filters[p]; else T.filters[p] = cast(v); reload(); }));
  });

$("clear").addEventListener("click", () => {
  T.filters = {};
  document.querySelectorAll(".fi").forEach((b) => b.setAttribute("aria-pressed", "false"));
  ["fq", "fcmin", "fcmax", "fcyc", "fymin", "fymax"].forEach((i) => { $(i).value = ""; });
  $("preset").value = "default"; reload();
});
const PRESETS = { default: { confidence: "verified" }, all: {}, flagged: { confidence: "flagged" },
  longlife: { cycles_min: 500 }, silicon: { q: "si/", electrode_role: "anode" },
  sulfur: { q: "s/", electrode_role: "cathode" }, recent: { year_min: 2024 } };
$("preset").addEventListener("change", (e) => {
  T.filters = { ...PRESETS[e.target.value] };
  document.querySelectorAll(".fi").forEach((b) =>
    b.setAttribute("aria-pressed", String(T.filters[FP[b.dataset.f]] === b.dataset.v)));
  reload();
});

const XCOLS = ["material_system", "graphene_form", "electrode_role", "battery_type",
  "specific_capacity_mah_g", "capacity_as_reported", "current_density_ma_g", "c_rate",
  "cycle_count", "capacity_retention_pct", "first_cycle_ce_pct", "voltage_window_v",
  "electrolyte", "temperature_c", "areal_loading_mg_cm2", "confidence", "flags",
  "title", "year", "journal", "doi", "source_section", "source_quote"];
$("csv").addEventListener("click", () => {
  const rows = sorted(DATA.rows.filter((r) => keep(r, T.filters)));
  const cell = (v) => { const s = Array.isArray(v) ? v.join("; ") : (v ?? "");
    return /[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s); };
  const csv = [XCOLS.join(",")].concat(rows.map((r) => XCOLS.map((c) => cell(r[c])).join(","))).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url;
  a.download = "graphene-evidence.csv"; a.click(); URL.revokeObjectURL(url);
});
$("more").addEventListener("click", () => {
  const c = DATA.stats.checks || {};
  $("mnote").innerHTML = `Each row is scoped to a single sentence, so every number in it was
    reported together. Checks cover capacity above ${c.capacity_hard_max_mah_g ?? 5000} mAh/g,
    retention above 100%, cycles above ${(c.cycle_hard_max ?? 1e5).toLocaleString("en-GB")},
    temperature outside ${(c.temperature_range_c || [-40, 200]).join(" to ")} °C, voltage outside
    ${(c.voltage_range_v || [0, 5]).join("–")} V, retention arithmetic, group outliers beyond
    ${c.outlier_sigma ?? 3.5} robust sigma, and unit mix-ups. <b>They cannot</b> tell whether a
    plausible number was measured under the conditions a row claims, catch a paper that is itself
    wrong, or judge whether a comparison is fair. ${fmt(DATA.stats.verified)} rows passed every
    check; ${fmt(DATA.stats.flagged)} are flagged and kept, never deleted.`;
});

/* ── calculators ────────────────────────────────────────── */
let calcsBuilt = false;
function buildCalcs(filter = "") {
  const all = DATA.calculators || [];
  const t = filter.toLowerCase().trim();
  const list = all.filter((c) => !t
    || c.label.toLowerCase().includes(t) || c.description.toLowerCase().includes(t)
    || c.group.toLowerCase().includes(t));
  const groups = {};
  list.forEach((c) => { (groups[c.group] = groups[c.group] || []).push(c); });
  $("calcs").innerHTML = Object.entries(groups).map(([g, items], gi) => `
    <div class="cgroup" style="--g:${gi}"><h3>${esc(g)} \u00b7 ${items.length}</h3>
    <div class="calcs">${items.map((c, ci) => `
      <div class="calc" style="--i:${ci}" data-n="${esc(c.name)}">
        <h3>${esc(c.label)}</h3><div class="d">${esc(c.description)}</div>
        <code class="fx">${esc(c.formula)}</code>
        <div class="ci">${c.inputs.map((i) => `<label class="fld">
          <span>${esc(i.label)}</span>
          <input type="number" step="any" data-i="${esc(i.name)}"
            value="${i.sample !== null && i.sample !== undefined ? esc(i.sample) : ""}"></label>`).join("")}
          <button class="btn pri" data-run>Calculate</button></div>
        <div class="co"></div>
        ${c.note ? `<div class="note2">${esc(c.note)}</div>` : ""}
      </div>`).join("")}</div></div>`).join("")
    || `<div class="empty"><strong>No calculator matches that.</strong>
        Try "capacity", "energy", "Raman" or "cell".</div>`;
  calcsBuilt = true;
}
$("calcq").addEventListener("input", deb((e) => buildCalcs(e.target.value)));
$("calcs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-run]"); if (!b) return;
  const card = b.closest(".calc"), out = card.querySelector(".co");
  const spec = (DATA.calculators || []).find((c) => c.name === card.dataset.n);
  if (!spec) return;
  const raw = {};
  card.querySelectorAll("[data-i]").forEach((el) => { raw[el.dataset.i] = el.value; });
  out.classList.add("on");
  let res;
  try { res = calcRun(spec.name, raw, spec); }
  catch (err) { out.innerHTML = `<div class="f">${esc(err.message)}</div>`; return; }
  let cmp = "";
  const capLike = ["theoretical_capacity", "specific_capacity"].includes(res.name)
    ? res.result : (res.inputs.capacity_mah_g || null);
  if (capLike) {
    const all = DATA.rows.filter((r) => r.specific_capacity_mah_g !== null
      && r.confidence !== "unverified").map((r) => Number(r.specific_capacity_mah_g));
    if (all.length) {
      const below = all.filter((v) => v <= capLike).length / all.length * 100;
      cmp = `<div class="cmp">${fmt(capLike, 0)} mAh/g sits above <b>${fmt(below, 0)}%</b>
        of the ${fmt(all.length)} measurements in the library
        (median ${fmt(spread(all).median, 0)} mAh/g).</div>`;
    }
  }
  out.innerHTML = `<div class="r">${fmt(res.result, 4)}<u>${esc(res.unit)}</u></div>
    <div class="cmp dim">${Object.entries(res.inputs).map(([k, v]) =>
      `${esc(k.replace(/_/g, " "))} = ${fmt(v, 4)}`).join("  &middot;  ")}</div>${cmp}`;
});

/* ── sources ────────────────────────────────────────────── */
function paintSources(q = "") {
  const by = new Map();
  DATA.rows.forEach((r) => {
    const cur = by.get(r.openalex_id) || { ...r, n: 0 };
    cur.n += 1; by.set(r.openalex_id, cur);
  });
  let rows = [...by.values()];
  if (q) { const t = q.toLowerCase();
    rows = rows.filter((r) => String(r.title || "").toLowerCase().includes(t)
      || String(r.journal || "").toLowerCase().includes(t)); }
  rows.sort((a, b) => b.n - a.n);
  $("sc").textContent = rows.length.toLocaleString("en-GB");
  $("sb").innerHTML = rows.slice(0, 700).map((r) => `<tr data-id="${r.id}">
    <td style="max-width:420px">${esc(r.title || "")}</td>
    <td class="num">${r.year ? String(r.year) : NR}</td>
    <td>${esc(r.journal || "") || NR}</td>
    <td>${esc(r.source_section || "abstract")}</td>
    <td>${esc(r.confidence)}</td><td class="num">${fmt(r.n)}</td>
    <td>${r.doi ? `<a href="https://doi.org/${esc(r.doi)}" target="_blank" rel="noopener">doi</a>` : NR}</td></tr>`).join("");
}
$("sq").addEventListener("input", deb((e) => paintSources(e.target.value.trim())));
$("sb").addEventListener("click", (e) => {
  const tr = e.target.closest("tr"); if (!tr || e.target.closest("a")) return;
  const r = DATA.rows.find((x) => String(x.id) === tr.dataset.id); if (r) openRow(r);
});

/* ── notebook ───────────────────────────────────────────── */
let notes = [];
const NKEY = "gba.notes.v1";
function loadNotes() { try { notes = JSON.parse(localStorage.getItem(NKEY) || "[]"); }
  catch (e) { notes = []; } paintCount(); }
function saveNote(q, a, n) {
  notes.unshift({ q, a, n, at: new Date().toISOString() });
  notes = notes.slice(0, 80);
  try { localStorage.setItem(NKEY, JSON.stringify(notes)); } catch (e) { /* private mode */ }
  paintCount(); paintNotebook();
}
function paintCount() { const el = $("nbn"); el.textContent = notes.length; el.hidden = !notes.length; }
function paintNotebook() {
  $("nbs").innerHTML = notes.length ? notes.map((n, i) => `<div class="nb">
    <div class="q2">${esc(n.q)}</div>
    <div class="a2">${esc(String(n.a).replace(/\s+/g, " ").slice(0, 440))}&hellip;</div>
    <div class="m2"><span>${n.n} sources</span><span>${esc(String(n.at).slice(0, 16).replace("T", " "))}</span>
      <button class="lnk" data-del="${i}">Remove</button></div></div>`).join("")
    : `<div class="empty"><strong>Nothing saved yet.</strong>Ask a question, then choose
       Save to notebook under the answer.</div>`;
}
$("nbs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-del]"); if (!b) return;
  notes.splice(Number(b.dataset.del), 1);
  try { localStorage.setItem(NKEY, JSON.stringify(notes)); } catch (err) {}
  paintCount(); paintNotebook();
});

/* ── theme, palette, keyboard ───────────────────────────── */
try { const s = localStorage.getItem("gba.theme"); if (s) document.documentElement.dataset.theme = s; }
catch (e) {}
/* What theme is actually showing right now: an explicit choice if one has
   been made, otherwise whatever the operating system asked for.

   This used to be decided by comparing the computed background colour against
   the string "rgb(7,9,16)". The dark background is #07090D, which is
   rgb(7,9,13), so the comparison never matched, the toggle always chose dark,
   and once dark there was no way back to light. Read the state, do not
   infer it from a pixel. */
function currentTheme() {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark" : "light";
}

function applyTheme(next) {
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("gba.theme", next); } catch (e) {}
  const btn = $("theme");
  if (btn) {
    btn.setAttribute("aria-pressed", String(next === "dark"));
    btn.title = next === "dark" ? "Switch to light" : "Switch to dark";
  }
  // The canvases read their colours from the stylesheet once per frame, but
  // a paused one needs telling.
  window.dispatchEvent(new CustomEvent("gba:theme", { detail: next }));
}

$("theme").addEventListener("click", () => {
  // Cross-fade the whole page rather than snapping between palettes.
  document.documentElement.classList.add("theming");
  setTimeout(() => document.documentElement.classList.remove("theming"), 620);
  applyTheme(currentTheme() === "dark" ? "light" : "dark");
});
applyTheme(currentTheme());

let palItems = [], palIdx = 0;
const openPal = () => { $("palbd").hidden = false; $("pal").hidden = false;
  $("pal").classList.remove("closing"); $("palbd").classList.remove("closing");
  $("palin").value = ""; paintPal(""); $("palin").focus(); };
const closePal = () => closeOverlay($("pal"), $("palbd"));
function paintPal(term) {
  const t = term.toLowerCase();
  const base = [
    ["Ask the agent", "section", () => show("ask")],
    ["Knowledge base", "section", () => show("explore")],
    ["Evidence table", "section", () => show("evidence")],
    ["Calculators", "section", () => show("calculator")],
    ["Notebook", "section", () => show("notebook")],
    ["Sources", "section", () => show("sources")],
    ["Show flagged rows only", "filter", () => { T.filters = { confidence: "flagged" }; show("evidence"); reload(); }],
    ["Show verified rows only", "filter", () => { T.filters = { confidence: "verified" }; show("evidence"); reload(); }],
    ["Clear all filters", "filter", () => $("clear").click()],
    ["Export the current view", "export", () => $("csv").click()],
  ].filter(([l]) => !t || l.toLowerCase().includes(t));
  palItems = base.map(([label, hint, run]) => ({ label, hint, run }));
  if (term.trim().length > 1) {
    DATA.concepts.filter((c) => c.title.toLowerCase().includes(t)).slice(0, 6)
      .forEach((c) => palItems.unshift({ label: c.title, hint: "entry",
        run: () => openConcept(c.slug) }));
    (DATA.calculators || []).filter((c) => c.label.toLowerCase().includes(t)).slice(0, 4)
      .forEach((c) => palItems.push({ label: c.label, hint: "calculator",
        run: () => { show("calculator"); } }));
  }
  if (term.trim().length > 2) {
    palItems.unshift({ label: `Filter evidence for "${term}"`, hint: "filter",
      run: () => { T.filters = { ...T.filters, q: term }; $("fq").value = term; show("evidence"); reload(); } });
    palItems.push({ label: `Ask: "${term}"`, hint: "question", run: () => { show("ask"); ask(term); } });
  }
  palIdx = 0;
  $("pall").innerHTML = palItems.map((i, n) => `<li role="option" data-n="${n}"
    aria-selected="${n === 0}">${esc(i.label)}<span class="h">${esc(i.hint)}</span></li>`).join("");
}
$("palin").addEventListener("input", (e) => paintPal(e.target.value));
$("pall").addEventListener("click", (e) => { const li = e.target.closest("li");
  if (li) { palItems[Number(li.dataset.n)].run(); closePal(); } });
$("palin").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault();
    palIdx = (palIdx + (e.key === "ArrowDown" ? 1 : -1) + palItems.length) % palItems.length;
    $("pall").querySelectorAll("li").forEach((li, n) => li.setAttribute("aria-selected", String(n === palIdx)));
    $("pall").children[palIdx]?.scrollIntoView({ block: "nearest" }); }
  if (e.key === "Enter" && palItems[palIdx]) { palItems[palIdx].run(); closePal(); }
});
$("pal-open").addEventListener("click", openPal);
$("palbd").addEventListener("click", closePal);
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPal(); }
  if (e.key === "Escape") { closePal(); closeDrawer(); }
  if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
    e.preventDefault(); show("ask"); $("ask").focus(); }
});

/* ── boot ───────────────────────────────────────────────── */
async function loadData() {
  try {
    const probe = await fetch("api/bundle", { headers: { accept: "application/json" } });
    if (probe.ok) { DATA = await probe.json(); API = true; return; }
  } catch (e) { /* static deployment */ }
  DATA = await fetch("data.json").then((r) => r.json());
}

(async function start() {
  const scroll = $("scroll");
  if (scroll) scroll.insertAdjacentHTML("afterbegin",
    `<div class="skel" id="skel"><i class="a"></i><i class="b"></i><i class="c"></i>
      <i class="d"></i><i class="e"></i>
      <div class="skel-note">loading the library\u2026</div></div>`);
  const hideSkel = () => { const el = $("skel"); if (el) el.remove(); };
  try { await loadData(); }
  catch (e) {
    hideSkel();
    $("thread").innerHTML = `<div class="refusal"><h3>The library could not be loaded</h3>
      <p>Reload the page. If it keeps failing the data file is missing from the deployment.</p></div>`;
    return;
  }
  hideSkel();
  const s = DATA.stats;
  document.title = `Graphene Research Agent · ${fmt(s.evidence_rows)} measurements`;
  $("strip").innerHTML = [
    [fmt((s.evidence_rows || 0) + (s.property_rows || 0)), "measurements"],
    [fmt(s.papers), "papers"],
    [fmt(s.property_families || 0), "properties measured"],
    [`${s.year_range[0]}–${s.year_range[1]}`, "published"],
    [fmt(DATA.concepts.length), "reference entries"],
  ].map(([v, k], i) => `<div class="stat" style="--i:${i}"><div class="v">${esc(v)}</div>
      <div class="k">${esc(k)}</div></div>`).join("");
  const setN = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  setN("n-con", fmt(DATA.concepts.length));
  setN("n-ev", fmt(s.evidence_rows));
  setN("n-prop", fmt((DATA.properties || []).length));
  setN("n-calc", (DATA.calculators || []).length);
  setN("n-pap", fmt(s.papers));
  $("chips").innerHTML = CHIPS.map((q, i) =>
    `<button style="--i:${i}" data-q="${esc(q)}">${esc(q)}</button>`).join("");
  $("chips").addEventListener("click", (e) => { const b = e.target.closest("button");
    if (b) (MODE === "agent" ? askAgent : ask)(b.dataset.q); });
  paintFacets(); head(); loadNotes(); probeAgent();
  // The opening sequence is one-shot. Clearing the class once it has played
  // stops every later tab switch from replaying the whole arrival.
  setTimeout(() => document.documentElement.classList.remove("booting"), 2200);
  // Exposed so tests/scorecard_ui.js can drive the shipped engine directly.
  window.DATA = DATA; window.build = build;
})();

/* ═══════════════════ agent mode ═══════════════════
   The deterministic engine answers instantly and free. The agent plans for
   itself, calls tools, and can answer things nobody coded a rule for; it runs
   on the server's own key, so no visitor is ever asked to pay or sign in. */

let MODE = "instant";
let AGENT = { available: false, replay: false, saved: [], provider: null,
              model: null, tools: 0 };

async function probeAgent() {
  // Three states, not two. With a model key the agent reasons live. Without
  // one it can still replay any question it has already answered, because a
  // stored run is a finished answer and needs no key, no network and no
  // quota. Only a deployment with neither a key nor a stored run is dead.
  if (API) try {
    const s = await fetch("api/agent/status").then((r) => r.json());
    AGENT = { available: !!s.configured, replay: !s.configured && !!s.replayable,
              saved: s.saved || [], provider: s.provider, model: s.model,
              tools: s.tools || 0 };
  } catch (e) { AGENT.available = false; AGENT.replay = false; }

  const btn = document.querySelector('.mode[data-mode="agent"]');
  if (!btn) return;
  if (AGENT.available || AGENT.replay) {
    btn.disabled = false;
    btn.removeAttribute("style");
    btn.title = AGENT.replay
      ? "Replays the questions it has already researched"
      : `Plans its own steps across ${AGENT.tools} tools`;
    if (AGENT.replay) btn.classList.add("replayonly");
  } else {
    btn.disabled = true;
    btn.title = API ? "No model key is set on the server"
                    : "Agent mode needs the full service, not the static copy";
    btn.style.opacity = ".45"; btn.style.cursor = "not-allowed";
  }
}

/* The questions the agent has already researched. In replay mode these are
   the only ones that answer, so they are offered rather than left to guess. */
function agentChips() {
  const box = $("chips");
  if (!box) return;
  if (MODE !== "agent" || !AGENT.saved.length) return;
  box.innerHTML = `<div class="chipnote">${AGENT.replay
      ? "Already researched \u2014 these replay instantly, step by step, with no model needed"
      : "Researched before \u2014 these replay instantly and identically"}</div>`
    + AGENT.saved.slice(0, 6).map((s, i) =>
      `<button style="--i:${i}" data-q="${esc(s.question)}" class="agentchip">
        <svg class="ic" viewBox="0 0 22 22"><use href="#i-spark"/></svg>
        ${esc(s.question)}</button>`).join("");
  box.hidden = false;
}

function setMode(mode) {
  if (mode === "agent" && !(AGENT.available || AGENT.replay)) return;
  MODE = mode;
  document.querySelectorAll(".mode").forEach((b) =>
    b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
  const hint = $("hint");
  if (hint) hint.textContent = mode === "agent"
    ? (AGENT.replay
        ? `Replaying ${AGENT.saved.length} researched questions, step by step. Free.`
        : `Plans its own steps across ${AGENT.tools} tools. Slower, costs a little.`)
    : "Rules only. Instant and free.";
  if (mode === "agent") agentChips();
  else if ($("chips")) {
    $("chips").innerHTML = CHIPS.map((q, i) =>
      `<button style="--i:${i}" data-q="${esc(q)}">${esc(q)}</button>`).join("");
  }
}
document.addEventListener("click", (e) => {
  const b = e.target.closest(".mode");
  if (b && !b.disabled) setMode(b.dataset.mode);
});

/* ---- a small markdown renderer; the agent answers in markdown ---- */
function md(src, refs) {
  const lines = String(src || "").split("\n");
  let html = "", list = null, table = false;
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  const closeTable = () => { if (table) { html += "</tbody></table>"; table = false; } };
  const inline = (s) => {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "<em>$1</em>");
    t = t.replace(/\[([EP]W?\d+)\]/g, (m, id) => {
      const n = refs.index.get(id);
      return n ? `<button class="cite" data-ref="${esc(id)}" title="Show the source">${n}</button>` : "";
    });
    return t;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*\|(.+)\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split("|").map((c) => c.trim());
      if (/^[\s|:-]+$/.test(line)) continue;
      if (!table) { closeList(); html += "<table><tbody><tr>"
        + cells.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr>"; table = true; continue; }
      html += "<tr>" + cells.map((c) => {
        const num = /^[\s]*[\d.,+\-]+\s*\S{0,8}$/.test(c);
        return `<td class="${num ? "num" : ""}">${inline(c)}</td>`;
      }).join("") + "</tr>";
      continue;
    }
    closeTable();
    if (!line.trim()) { closeList(); continue; }
    let m;
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) { closeList(); html += `<h3>${inline(m[1])}</h3>`; continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (list !== "ul") { closeList(); html += "<ul>"; list = "ul"; }
      html += `<li>${inline(m[1])}</li>`; continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== "ol") { closeList(); html += "<ol>"; list = "ol"; }
      html += `<li>${inline(m[1])}</li>`; continue;
    }
    closeList();
    html += `<p>${inline(line)}</p>`;
  }
  closeList(); closeTable();
  return html;
}

function agentRefs(text) {
  const index = new Map(), items = [];
  for (const id of [...String(text).matchAll(/\[([EP]W?\d+)\]/g)].map((m) => m[1])) {
    if (index.has(id)) continue;
    let item = null;
    if (id[0] === "E") {
      const row = DATA.rows.find((r) => "E" + r.id === id);
      if (row) item = { kind: "evidence", id, row };
    } else {
      const wid = id.slice(1);
      const p = DATA.passages.find((x) => x.i === wid);
      if (p) item = { kind: "passage", id, p };
    }
    index.set(id, index.size + 1);
    items.push(item || { kind: "unknown", id });
  }
  return { index, items };
}

function agentSources(refs) {
  const known = refs.items.filter((i) => i.kind !== "unknown");
  if (!known.length) return "";
  return `<details class="disclose"><summary>Sources
    <span class="dim">${known.length}</span>
    <svg class="ic" viewBox="0 0 22 22"><use href="#i-chev"/></svg></summary>
    <div class="inner2"><div class="srcs">${known.map((it) => {
      const n = refs.index.get(it.id);
      if (it.kind === "evidence") return srcCard(it.row, n);
      return `<div class="src" data-pass="${esc(it.p.i)}"><div class="n">${n}</div><div>
        <div class="t">${esc(it.p.t || "")}</div>
        <div class="m"><span>${esc(it.p.j || "")}</span><span>${it.p.y || ""}</span></div>
        <div class="qt">${esc(it.p.x.slice(0, 280))}&hellip;</div></div></div>`;
    }).join("")}</div></div></details>`;
}

async function askAgent(question) {
  if (busy || !question.trim()) return;
  busy = true; $("send").disabled = true;
  $("hero").hidden = true; $("chips").hidden = true;

  const turn = document.createElement("div");
  turn.className = "turn";
  turn.innerHTML = `<div class="q"><div class="av">You</div><div class="t">${esc(question)}</div></div>
    <div class="research" aria-hidden="true">
      <canvas class="rcanvas"></canvas>
      <div class="rveil"></div>
      <div class="rlabel"><span class="rdot"></span><span class="rtext">Reading the library</span>
        <span class="rcount"></span></div>
    </div>
    <details class="steps" open><summary><span class="sdot live"></span>
      <span class="slabel">Thinking</span>
      <svg class="ic" viewBox="0 0 22 22"><use href="#i-chev"/></svg></summary>
      <div class="body"></div></details>
    <div class="out"></div>`;
  $("thread").appendChild(turn);
  turn.scrollIntoView({ behavior: "smooth", block: "start" });

  const body = turn.querySelector(".steps .body");
  const label = turn.querySelector(".slabel");
  const stage = turn.querySelector(".research");
  const rtext = turn.querySelector(".rtext");
  let calls = 0;
  let paced = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /* Roughly what each step costs when the agent is really thinking, so a
     replay reads at the speed of work rather than the speed of a disk. */
  const PACE = { start: 260, thinking: 900, tool_call: 620, tool_result: 540,
                 correcting: 1100, answer: 700 };
  const anim = window.ResearchAnim
    ? ResearchAnim.create(turn.querySelector(".rcanvas"), { side: 26 })
    : { step() {}, done() {}, stop() {} };
  const SAYS = {
    describe_library: "Checking what the library holds",
    search_measurements: "Searching the measurements",
    compare_materials: "Ranking material systems",
    trend_by_year: "Tracking change by year",
    search_literature: "Reading the papers",
    knowledge_lookup: "Looking up the fundamentals",
    compound_lookup: "Checking the chemistry",
    calculate: "Running the calculation",
    convert_units: "Converting units",
    sql_query: "Querying the library directly",
    live_search: "Fetching new work from OpenAlex",
    extract_from_text: "Reading the text you gave it",
    run_analysis: "Running its own analysis",
  };
  const out = turn.querySelector(".out");
  const figures = [];
  const step = (what, detail, result) => {
    const row = document.createElement("div");
    row.className = "step2";
    row.innerHTML = `<span class="sdot"></span>
      <span>${esc(what)} ${detail ? `<b>${esc(detail)}</b>` : ""}</span>
      <span class="r">${esc(result || "")}</span>`;
    body.appendChild(row);
    body.parentElement.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  try {
    const res = await fetch("api/agent", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch (e) { continue; }

        // A stored run arrives in a single burst. Rendering it as fast as it
        // is read would finish before the first frame is painted, and the
        // viewer would see nothing of the research the screen exists to show.
        // So a replay is played back, not dumped - each step at about the
        // pace the original took. It is the same run either way; only the
        // clock differs, and the answer says it is a replay.
        if (ev.replayed) {
          paced = true;
          await sleep(PACE[ev.type] || 320);
        }

        if (ev.type === "start") label.textContent = paced
          ? `Replaying \u00b7 ${ev.model}` : `Working \u00b7 ${ev.model}`;
        else if (ev.type === "thinking") {
          const t = document.createElement("div");
          t.className = "think"; t.textContent = ev.text.slice(0, 260) + "…";
          body.appendChild(t);
        }
        else if (ev.type === "tool_call") {
          step("Calling", ev.name, "");
          anim.step();
          calls += 1;
          if (rtext) rtext.textContent = SAYS[ev.name] || "Working";
          const rc = turn.querySelector(".rcount");
          if (rc) rc.textContent = `step ${calls}`;
        }
        else if (ev.type === "tool_result") {
          const last = body.querySelector(".step2:last-of-type .r");
          if (last) last.textContent = ev.summary || "";
        }
        else if (ev.type === "correcting") {
          step("Checking its own citations", "rewriting", "failed first pass");
          anim.step();
          if (rtext) rtext.textContent = "Checking its own citations";
        }
        else if (ev.type === "answer") {
          anim.done();
          if (stage) { stage.classList.add("settled");
            setTimeout(() => stage.remove(), 700); }
          const v = ev.verification || {};
          const refs = agentRefs(ev.text);
          const clean = v.clean;
          out.innerHTML =
            `<div class="prose">${md(ev.text, refs)}</div>`
            + (ev.figures || []).map((f) =>
                `<div class="figwrap"><img alt="Chart produced by the analysis"
                  src="data:image/png;base64,${f.png_base64}"></div>`).join("")
            + agentSources(refs)
            + `<div class="acts">
                 <button class="btn" data-save>Save to notebook</button>
                 ${ev.replayed ? `<span class="badge-v">Replayed, identical to before</span>` : ""}
                 <span class="badge-v ${clean ? "ok" : "warn"}">${clean
                   ? "Every figure traced to a source"
                   : `${(v.numbers_unsupported || []).length} figure(s) unverified`}</span>
                 <span class="dim">${ev.rounds} steps · ${ev.seconds}s</span></div>`;
          label.textContent = `Worked for ${ev.seconds}s across ${ev.rounds} steps`;
          turn.querySelector(".sdot").classList.remove("live");
          turn.querySelector(".steps").open = false;
          animateBlocks(out);
          out.querySelector("[data-save]")?.addEventListener("click", (e) => {
            saveNote(question, out.innerText.slice(0, 900), refs.items.length);
            e.target.textContent = "Saved"; e.target.disabled = true;
          });
        }
        else if (ev.type === "error") {
          anim.stop(); if (stage) stage.remove();
          turn.querySelector(".sdot").classList.remove("live");
          label.textContent = "Could not finish";
          // In replay mode a new question is not a failure, it is simply one
          // the agent has not been asked yet. Say that, and offer the ones it
          // has, rather than printing a key-is-missing error at a researcher.
          if (ev.code === "no_model" && AGENT.replay) {
            out.innerHTML = `<div class="refusal"><h3>Not researched yet</h3>
              <p>This deployment replays questions the agent has already worked
                 through. It has not been asked this one, and it will not guess.</p>
              <p class="dim">These it has researched &mdash; each replays in full,
                 step by step:</p>
              <div class="chips inline">${AGENT.saved.map((s, i) =>
                `<button style="--i:${i}" class="agentchip" data-q="${esc(s.question)}">
                  <svg class="ic" viewBox="0 0 22 22"><use href="#i-spark"/></svg>
                  ${esc(s.question)}</button>`).join("")}</div>
              <p class="dim" style="margin-top:14px">To let it research anything,
                 set a model key on the server. Instant mode answers this question
                 now, by rule, and needs no model.</p></div>`;
            out.querySelectorAll("[data-q]").forEach((bq) =>
              bq.addEventListener("click", () => askAgent(bq.dataset.q)));
          } else {
            out.innerHTML = `<div class="refusal"><h3>The agent could not answer</h3>
              <p>${esc(ev.message)}</p>
              <p class="dim">Instant mode still works and needs no model.</p></div>`;
          }
        }
      }
    }
  } catch (err) {
    anim.stop(); if (stage) stage.remove();
    out.innerHTML = `<div class="refusal"><h3>The agent could not be reached</h3>
      <p>${esc(String(err.message || err))}</p></div>`;
  } finally {
    busy = false; $("send").disabled = false; $("ask").focus();
  }
}
