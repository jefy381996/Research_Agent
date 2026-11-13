/* A researcher's own data, in the browser that added it.
 *
 * Two properties matter more than the feature itself. A supplied figure must
 * never be countable as published evidence, so the library's totals must not
 * move. And nothing may reach the server, because this deployment has no login
 * and unpublished results are what a researcher would be adding - so a second,
 * separate browser must see nothing of the first one's data.
 *
 * Run against a served instance:  node tests/mydata_ui.js [url]
 */
const { chromium } = require("playwright");
const URL = process.argv[2] || "http://127.0.0.1:8099/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SAMPLE = "The Si/rGO composite anode delivered a reversible capacity of "
  + "1842 mAh g-1 at 200 mA g-1 and retained 87% of it after 500 cycles. The "
  + "electrode showed a thermal conductivity of 12.6 W/mK and a sheet "
  + "resistance of 48 ohm/sq. BET analysis gave a specific surface area of "
  + "412 m2 g-1.";

async function open(browser) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.DATA && window.DATA.rows
    && window.DATA.rows.length > 0, null, { timeout: 60000 });
  await sleep(1200);
  return page;
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  let pass = 0, total = 0;
  const check = (name, ok, detail) => {
    total += 1; pass += ok ? 1 : 0;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok && detail !== undefined) console.log(`        ${detail}`);
  };

  const page = await open(browser);
  page.on("pageerror", (e) => errors.push(String(e.message)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  const libraryBefore = await page.evaluate(() => ({
    ev: document.getElementById("n-ev").textContent,
    pr: document.getElementById("n-prop").textContent,
  }));

  await page.click('[data-view="mydata"]');
  await sleep(700);
  check("the screen opens with an empty state",
    await page.locator("#mdempty").isVisible());

  await page.fill("#mdtitle", "Si/graphene cell, run 14");
  await page.fill("#mdtext", SAMPLE);
  await page.click("#mdgo");
  await sleep(4000);

  const added = await page.evaluate(() => ({
    sets: document.querySelectorAll(".mdset").length,
    cards: document.querySelectorAll("#mdsets .mcard").length,
    tagged: document.querySelectorAll("#mdsets .mcard .mtag").length,
    badge: document.getElementById("n-mine").textContent,
  }));
  check("the figures are read and shown", added.sets === 1 && added.cards >= 4,
    JSON.stringify(added));
  check("every supplied row is tagged as the researcher's own",
    added.cards > 0 && added.tagged === added.cards, JSON.stringify(added));

  const libraryAfter = await page.evaluate(() => ({
    ev: document.getElementById("n-ev").textContent,
    pr: document.getElementById("n-prop").textContent,
  }));
  check("the library's totals do not move",
    libraryAfter.ev === libraryBefore.ev && libraryAfter.pr === libraryBefore.pr,
    `${JSON.stringify(libraryBefore)} -> ${JSON.stringify(libraryAfter)}`);

  // the sentence behind a supplied figure is there, exactly as for the library
  await page.locator("#mdsets .mcard").first().click();
  await sleep(800);
  const quote = await page.locator("#db blockquote").first().innerText().catch(() => "");
  check("a supplied figure carries the sentence it came from",
    quote.includes("1842") || quote.includes("12.6"), quote.slice(0, 70));
  await page.click("#dclose"); await sleep(400);

  await page.reload({ waitUntil: "networkidle" });
  await sleep(2600);
  await page.click('[data-view="mydata"]'); await sleep(700);
  check("it survives a reload",
    (await page.locator(".mdset").count()) === 1);

  /* The property that matters most: a second browser is a second researcher,
     and must see nothing of the first one's unpublished work. */
  const other = await open(browser);
  await other.click('[data-view="mydata"]'); await sleep(700);
  const leaked = await other.locator(".mdset").count();
  check("another browser sees none of it", leaked === 0, `${leaked} set(s) leaked`);
  await other.close();

  // deleting asks twice
  await page.locator("[data-mddelete]").first().click(); await sleep(400);
  const stillThere = await page.locator(".mdset").count();
  await page.locator("[data-mddelete]").first().click(); await sleep(700);
  const gone = await page.locator(".mdset").count();
  check("deleting takes two presses", stillThere === 1 && gone === 0,
    `after first ${stillThere}, after second ${gone}`);

  // and the refusals are useful rather than silent
  await page.fill("#mdtext", "too short");
  await page.click("#mdgo"); await sleep(1500);
  const short = await page.locator("#mdstat").innerText();
  check("text that is too short is refused with a reason",
    /sentence or two/i.test(short), short);

  await page.fill("#mdtext", "Graphene was prepared by chemical vapour deposition "
    + "on copper foil and transferred onto a silicon wafer for further study.");
  await page.click("#mdgo"); await sleep(3000);
  const none = await page.locator("#mdstat").innerText();
  check("prose with no figures says so rather than inventing one",
    /No figures were found/i.test(none), none);

  /* The order a researcher expects: the library, then their own data, then
     the agent. And the matching that decides it, which has to be conservative
     - a researcher who sees their own run attached to somebody else's
     question stops trusting the screen. */
  await page.fill("#mdtitle", "Zr/rGO run 7");
  await page.fill("#mdtext", "The Zr/rGO hybrid anode delivered a reversible capacity "
    + "of 2460 mAh g-1 at 300 mA g-1 and retained 93% of it after 400 cycles. The "
    + "Zr/rGO film showed a thermal conductivity of 44.5 W/mK.");
  await page.click("#mdgo");
  await sleep(4000);

  const MATCH = [
    [true,  "What capacity do rGO anodes reach?",            "names the form they used"],
    [true,  "What thermal conductivity do graphene composites reach?", "names the property"],
    [true,  "How did Zr/rGO run 7 perform?",                 "names their set"],
    [false, "What capacity do silicon graphene anodes reach?", "silicon; theirs is rGO"],
    [false, "What capacity do anodes reach?",                "generic; would match everything"],
    [false, "What is graphene?",                             "a definition"],
    [false, "Compare material systems on capacity in lithium-ion anodes", "library comparison"],
  ];
  const matched = await page.evaluate((cs) => cs.map(([want, q, why]) =>
    ({ want, q, why, got: !!myAnswer(q) })), MATCH);
  for (const r of matched) {
    check(`${r.want ? "shows" : "hides "} their data: ${r.why}`, r.got === r.want,
      `"${r.q}"`);
  }

  /* The cascade itself: a question the library cannot answer, which their own
     data can. */
  await page.click('[data-view="ask"]'); await sleep(500);
  await page.evaluate(() => { document.getElementById("thread").innerHTML = ""; });
  await page.fill("#ask", "How did Zr/rGO run 7 perform?");
  await page.click("#send");
  await sleep(6500);
  const cascade = await page.evaluate(() =>
    [...document.querySelectorAll("#thread .turn")].map((t) => ({
      continued: t.classList.contains("continued"),
      handoff: (t.querySelector(".handoff")?.innerText || "").replace(/\s+/g, " "),
      fromMine: !!t.querySelector(".headline.mine"),
    })));
  check("the library comes up short, then their own data answers",
    cascade.length === 2 && cascade[1].continued && cascade[1].fromMine
      && /your own data/i.test(cascade[1].handoff),
    JSON.stringify(cascade));

  /* And beside a library answer, when both have something to say. */
  await page.evaluate(() => { document.getElementById("thread").innerHTML = ""; });
  await page.fill("#ask", "What thermal conductivity do graphene composites reach?");
  await page.click("#send");
  await sleep(4000);
  const beside = await page.evaluate(() => {
    const s = document.querySelector(".minestrip");
    return { library: !!document.querySelector(".headline:not(.mine)"),
             strip: !!s, cards: s ? s.querySelectorAll(".mcard").length : 0 };
  });
  check("their figures sit beside a library answer, not inside it",
    beside.library && beside.strip && beside.cards > 0, JSON.stringify(beside));

  console.log(`\nMy-data scorecard: ${pass}/${total}`);
  if (errors.length) console.log("console errors:\n  " + errors.slice(0, 5).join("\n  "));
  await browser.close();
  process.exit(pass === total && errors.length === 0 ? 0 : 1);
})();
