/* When one engine comes back empty, the other gets a turn.
 *
 * The risk in automatic switching is not that it fails to fire; it is that it
 * fires when it should not - escalating a question both engines are meant to
 * refuse, or handing back and forth forever. Each case below is one of those.
 *
 * Run against a served instance:  node tests/handoff_ui.js [url]
 */
const { chromium } = require("playwright");
const URL = process.argv[2] || "http://127.0.0.1:8099/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* [name, mode, question, expected turns, what the handoff should say] */
const CASES = [
  ["instant answers, no handoff", "instant",
   "What is graphene?", 1, null],

  ["instant refuses out of remit, must NOT escalate", "instant",
   "Which graphene battery company should I invest in?", 1, null],

  ["instant misses, agent unreachable, no pointless round trip", "instant",
   "What is the melting point of tungsten?", 1, null],

  ["agent replays what it researched, no handoff", "agent",
   "What is the median capacity of Si/rGO anodes?", 1, null],

  ["agent cannot answer, falls back to instant", "agent",
   "What is graphene?", 1, "Trying instant mode instead"],

  ["agent cannot answer a definition it never researched", "agent",
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
    answered: !!t.querySelector(".defcard, .headline, .srcs, .prose"),
    refused: !!t.querySelector(".refusal"),
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

  let pass = 0;
  for (const [name, mode, q, wantTurns, wantHandoff] of CASES) {
    const turns = await run(page, mode, q, mode === "agent" ? 9000 : 4000);
    const handoff = turns.find((t) => t.continued);
    const okTurns = turns.length === wantTurns;
    const okHandoff = wantHandoff
      ? !!handoff && handoff.handoff.includes(wantHandoff)
      : !handoff;
    // whichever engine ends up answering, the reader must get something
    const okAnswer = turns.some((t) => t.answered || t.refused);
    const ok = okTurns && okHandoff && okAnswer;
    pass += ok ? 1 : 0;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) {
      console.log(`        turns ${turns.length} (want ${wantTurns})`
        + `  handoff ${handoff ? JSON.stringify(handoff.handoff.slice(0, 70)) : "none"}`
        + `  (want ${wantHandoff ? JSON.stringify(wantHandoff) : "none"})`);
    }
  }

  /* A handed-over run must never hand back. Force escalation on, then confirm
     the chain stops at two turns however long we wait. */
  await page.evaluate(() => { window.agentCanTry = () => true; });
  const chain = await run(page, "instant", "What is the melting point of tungsten?", 11000);
  const noLoop = chain.length <= 2;
  pass += noLoop ? 1 : 0;
  console.log(`  ${noLoop ? "PASS" : "FAIL"}  a handed-over run never hands back `
    + `(${chain.length} turn${chain.length === 1 ? "" : "s"})`);

  const total = CASES.length + 1;
  console.log(`\nHandoff scorecard: ${pass}/${total}`);
  if (errors.length) console.log("console errors:\n  " + errors.slice(0, 5).join("\n  "));

  await browser.close();
  process.exit(pass === total && errors.length === 0 ? 0 : 1);
})();
