/* Scorecard for the engine that actually ships.
 *
 * The Python tests cover the API's engine. The interface runs its own copy in
 * the browser, so this drives the real page in a real browser and checks that
 * each question produces the kind of answer it should. Run it against a
 * served instance:  node tests/scorecard_ui.js [url]
 */
const { chromium } = require("playwright");

const URL = process.argv[2] || "http://127.0.0.1:8080/";

const CASES = [
  // definitions, the basics the library must cover
  ["What is graphene?", "concept"],
  ["What is a lithium-ion battery?", "concept"],
  ["Explain chemical vapor deposition", "concept"],
  ["What is an anode?", "concept"],
  ["Define electrolyte", "concept"],
  ["What is Raman spectroscopy?", "concept"],
  // measurements
  ["What capacity do silicon graphene anodes reach in lithium-ion batteries?", "number"],
  ["capacity retention of sulfur rGO cathodes in lithium-sulfur", "number"],
  ["How many cycles do sodium-ion graphene anodes survive?", "number"],
  ["coulombic efficiency of silicon graphene anodes", "number"],
  // comparison and trend
  ["Compare material systems on capacity in lithium-ion anodes", "number"],
  ["How has capacity changed by year for graphene anodes?", "number"],
  // calculation
  ["An electrode at 1200 mAh/g and 3.7 V, what is the energy density?", "number"],
  // physical properties: the half of graphene that is not a battery
  ["What thermal conductivity do graphene composites reach?", "property"],
  ["sheet resistance of graphene transparent electrodes", "property"],
  ["carrier mobility of graphene", "property"],
  ["specific surface area of reduced graphene oxide", "property"],
  ["optical transmittance of graphene films", "property"],
  ["water permeance of graphene oxide membranes", "property"],
  ["EMI shielding effectiveness of graphene composites", "property"],
  ["specific capacitance of rGO supercapacitors", "property"],
  // a term the library both defines and measures answers with both
  ["What is the Young's modulus of graphene?", "concept"],
  // mechanism, and terms papers write differently from the way people ask
  ["Do graphene separators suppress lithium dendrites?", "sources"],
  // Answered from the knowledge base now that the entry exists; it fell back
  // to quoted papers before the reference collection reached it.
  ["What is the solid electrolyte interphase?", "concept"],
  ["What is C-rate?", "sources"],
  ["How is graphene made?", "sources"],
  // must refuse
  ["What is the melting point of tungsten?", "refused"],
  ["Who won the 2022 football world cup?", "refused"],
  ["What is the best pizza topping?", "refused"],
  ["How do I file a UK tax return?", "refused"],
  ["Which graphene battery company should I invest in?", "refused"],
  ["What will battery prices be in 2030?", "refused"],
  ["How do I build a nuclear reactor?", "refused"],
  ["Write me a poem about the sea.", "refused"],
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.DATA && window.DATA.rows
    && window.DATA.rows.length > 0, null, { timeout: 60000 });

  const results = await page.evaluate((cases) => cases.map(([q, want]) => {
    let kind = "error", detail = "";
    try {
      const a = build(q);
      kind = a.kind;
      detail = a.kind === "concept"
        ? a.concept.title + (a.property ? ` + ${a.property.stats.n} measurements` : "")
        : a.kind === "property" ? `${a.family.label}, n=${a.stats.n}` : "";
    } catch (e) { detail = e.message; }
    const got = kind === "concept" ? "concept"
      : kind === "refused" ? "refused"
      : kind === "passages" ? "sources"
      : kind === "property" ? "property"
      : ["quantitative", "comparison", "trend", "calculation"].includes(kind) ? "number"
      : kind;
    return { q, want, got, kind, detail };
  }), CASES);

  let pass = 0;
  for (const r of results) {
    const ok = r.got === r.want;
    pass += ok ? 1 : 0;
    console.log(`  ${ok ? "PASS" : "FAIL"}  want ${r.want.padEnd(8)} got ${String(r.got).padEnd(8)}`
      + ` ${r.q.slice(0, 54)}${r.detail ? "  [" + r.detail + "]" : ""}`);
  }
  /* ── the figures the page puts on screen ──────────────
     papers_with_text was counted from paper_sections, a derived table that is
     stripped before shipping and rebuilt on boot, so every static build
     reported nought papers with text. Nothing asserted on it, so it shipped.
     These are cheap and would have caught it. */
  const extra = [];
  const S = await page.evaluate(() => window.DATA.stats);
  const chk = (label, ok, detail) => extra.push({ label, ok, detail });

  chk("the library reports some papers", S.papers > 0, `papers=${S.papers}`);
  chk("and some of them have text", S.papers_with_text > 0,
    `papers_with_text=${S.papers_with_text}`);
  chk("text count never exceeds the paper count",
    S.papers_with_text <= S.papers, `${S.papers_with_text} > ${S.papers}`);
  chk("measurements come from a countable set of papers",
    S.papers_with_measurement > 0 && S.papers_with_measurement <= S.papers,
    `contributing=${S.papers_with_measurement}`);
  chk("both halves of the measurements are present",
    S.evidence_rows > 0 && S.property_rows > 0,
    `evidence=${S.evidence_rows} properties=${S.property_rows}`);

  // How papers were found must account for all of them, exactly once.
  chk("the provenance split adds up to the whole library",
    S.title_matched + S.abstract_only === S.papers,
    `${S.title_matched} + ${S.abstract_only} != ${S.papers}`);
  chk("the battery-context papers are a subset, not a surprise",
    S.context_only >= 0 && S.context_only <= S.papers, `context=${S.context_only}`);
  chk("and so are the measurements they account for",
    S.context_measurements >= 0 &&
    S.context_measurements <= S.evidence_rows + S.property_rows,
    `context_rows=${S.context_measurements}`);

  // The strip is what a visitor actually reads.
  const strip = await page.evaluate(() =>
    [...document.querySelectorAll("#strip .stat")].map((e) => ({
      v: e.querySelector(".v").textContent.trim(),
      k: e.querySelector(".k").textContent.trim(),
    })));
  chk("the stat strip rendered", strip.length >= 4, `${strip.length} stats`);
  chk("no figure on it is zero or blank",
    strip.every((x) => x.v && x.v !== "0"), JSON.stringify(strip));
  const measured = strip.find((x) => x.k === "measurements");
  chk("the strip counts both halves, not just the battery one",
    !!measured && measured.v.replace(/,/g, "") ===
      String(S.evidence_rows + S.property_rows),
    measured ? measured.v : "(missing)");
  const papers = strip.find((x) => x.k === "papers");
  chk("and agrees with the data on papers",
    !!papers && papers.v.replace(/,/g, "") === String(S.papers),
    papers ? papers.v : "(missing)");

  // Nothing written for a smaller library may be left hard-coded in copy.
  const stale = await page.evaluate(() => {
    const d = document.createElement("div");
    d.innerHTML = ["ask", "sources", "evidence", "properties", "explore",
                   "calculator", "mydata", "notebook"]
      .map((v) => (typeof primerHTML === "function" ? primerHTML(v) : "")).join("");
    const txt = d.textContent;
    return {
      tokens: txt.match(/\{[a-zA-Z]+\}/g) || [],
      old: txt.match(/\b(?:37,027|19,208|4,745|2,794|1,951|2,228)\b/g) || [],
    };
  });
  chk("every figure in the primers was filled from the data",
    stale.tokens.length === 0, stale.tokens.join(","));
  chk("no count from an older build is hard-coded in the copy",
    stale.old.length === 0, stale.old.join(","));

  for (const e of extra) {
    pass += e.ok ? 1 : 0;
    results.push({ q: e.label, want: "ok", got: e.ok ? "ok" : "BAD", detail: e.detail });
    console.log(`  ${e.ok ? "PASS" : "FAIL"}  ${e.label}`
      + (e.ok ? "" : `\n        ${e.detail || ""}`));
  }

  console.log(`\nUI scorecard: ${pass}/${results.length}`);
  if (errors.length) console.log("console errors:\n  " + errors.slice(0, 5).join("\n  "));

  await browser.close();
  process.exit(pass === results.length && errors.length === 0 ? 0 : 1);
})();
