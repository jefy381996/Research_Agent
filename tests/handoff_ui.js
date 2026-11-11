/* When one engine does not answer the question, the other gets a turn.
 *
 * The subtlety is what counts as "does not answer". Instant almost never
 * refuses: it picks whichever branch it can match and returns something. Asked
 * why silicon anodes crack, it returns a table of capacities; asked how much
 * graphene strengthens epoxy, it returns quoted prose with no figure in it.
 * Both look like answers and neither is one, and the first version of this
 * handoff escalated on outright refusals only, so in practice it never fired.
 *
 * So these cases test the shape of the answer against the shape of the
 * question, and the two guards that stop the switching running away: an
 * out-of-remit question is never escalated, and a handed-over run never hands
 * back.
 *
 * Run against a served instance:  node tests/handoff_ui.js [url]
 */
const { chromium } = require("playwright");
const URL = process.argv[2] || "http://127.0.0.1:8099/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Which questions should be handed to the agent, and which Instant answers
   properly on its own. Checked against the predicate, with no model needed. */
const SHAPES = [
  // asked why; rules can only match and count
  [true,  "Why do silicon anodes crack during cycling?"],
  [true,  "What limits the cycle life of silicon graphene anodes?"],
  [true,  "How does nitrogen doping change graphene's conductivity?"],
  // asked which is better; needs weighing, not matching
  [true,  "What is the best electrolyte for a lithium-sulfur cell?"],
  // asked how much and got prose with no figure in it
  [true,  "How much does graphene improve the strength of epoxy?"],
  // nothing in the library matched at all
  [true,  "What is the melting point of tungsten?"],

  // Instant answered the shape that was asked for; leave it alone
  [false, "What is graphene?"],
  [false, "Explain chemical vapor deposition"],
  [false, "What capacity do silicon graphene anodes reach?"],
  [false, "What thermal conductivity do graphene composites reach?"],
  [false, "Compare material systems on capacity in lithium-ion anodes"],
  [false, "How has capacity changed by year for graphene anodes?"],
  [false, "An electrode at 1200 mAh/g and 3.7 V, what is the energy density?"],

  // outside the remit: a decision the agent is held to as well, not a miss
  [false, "Which graphene company should I invest in?"],
  [false, "What will battery prices be in 2030?"],
  [false, "Write me a poem about the sea."],
  [false, "Should I buy a graphene battery?"],
];

/* End to end, with the agent reachable. */
const FLOWS = [
  ["a near miss is handed to the agent", "instant",
   "Why do silicon anodes crack during cycling?", 2, "Trying the agent instead"],
  ["a good answer is left alone", "instant",
   "What capacity do silicon graphene anodes reach?", 1, null],
  ["an out-of-remit question is never handed over", "instant",
   "Write me a poem about the sea.", 1, null],
  ["the agent falls back when it cannot run", "agent",
   "What is an anode?", 1, "Trying instant mode instead"],
];

async function run(page, mode, question, wait) {
  await page.evaluate(() => { document.getElementById("thread").innerHTML = ""; });
  await page.locator(`.mode[data-mode="${mode}"]`).click().catch(() => {});
  await sleep(250);
  await page.fill("#ask", question);
  await page.click("#send");
  await sleep(wait);
  return page.evaluate(() => [...document.querySelectorAll("#thread .turn")].map((t) => ({
    continued: t.classList.contains("continued"),
    handoff: (t.querySelector(".handoff")?.innerText || "").replace(/\s+/g, " ").trim(),
    shown: !!t.querySelector(".defcard, .headline, .srcs, .prose, .refusal"),
  })));
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.DATA && window.DATA.rows
    && window.DATA.rows.length > 0, null, { timeout: 60000 });
  await sleep(1200);

  let pass = 0, total = 0;

  const shapes = await page.evaluate((cases) => cases.map(([want, q]) => {
    const a = window.build(q);
    return { want, q, kind: a.kind, wanted: a.wanted, got: worthEscalating(a) };
  }), SHAPES);
  for (const r of shapes) {
    total += 1;
    const ok = r.got === r.want;
    pass += ok ? 1 : 0;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${r.want ? "hand over" : "keep     "}`
      + `  ${String(r.wanted).padEnd(10)} ${String(r.kind).padEnd(12)} ${r.q.slice(0, 50)}`);
  }

  // The deployment this runs on has no model key, so stand in for one: what
  // is under test is the routing, not the model.
  await page.evaluate(() => { window.agentCanTry = () => true; });

  for (const [name, mode, q, wantTurns, wantHandoff] of FLOWS) {
    total += 1;
    const turns = await run(page, mode, q, 9000);
    const handoff = turns.find((t) => t.continued);
    const ok = turns.length === wantTurns
      && (wantHandoff ? !!handoff && handoff.handoff.includes(wantHandoff) : !handoff)
      && turns.some((t) => t.shown);
    pass += ok ? 1 : 0;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) console.log(`        ${turns.length} turn(s), handoff `
      + `${handoff ? JSON.stringify(handoff.handoff.slice(0, 60)) : "none"}`);
  }

  // A handed-over run must never hand back, however long we wait.
  total += 1;
  const chain = await run(page, "instant", "What is the melting point of tungsten?", 12000);
  const noLoop = chain.length <= 2;
  pass += noLoop ? 1 : 0;
  console.log(`  ${noLoop ? "PASS" : "FAIL"}  a handed-over run never hands back `
    + `(${chain.length} turns)`);

  console.log(`\nHandoff scorecard: ${pass}/${total}`);
  if (errors.length) console.log("console errors:\n  " + errors.slice(0, 5).join("\n  "));

  await browser.close();
  process.exit(pass === total && errors.length === 0 ? 0 : 1);
})();
