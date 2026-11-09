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
      detail = a.kind === "concept" ? a.concept.title : "";
    } catch (e) { detail = e.message; }
    const got = kind === "concept" ? "concept"
      : kind === "refused" ? "refused"
      : kind === "passages" ? "sources"
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
  console.log(`\nUI scorecard: ${pass}/${results.length}`);
  if (errors.length) console.log("console errors:\n  " + errors.slice(0, 5).join("\n  "));

  await browser.close();
  process.exit(pass === results.length && errors.length === 0 ? 0 : 1);
})();
