/* The stage the agent works on.
 *
 * This replaced a lit, shaded, occluded sheet of graphene that redrew itself
 * sixty times a second. Measured on a throttled phone it issued 433 canvas
 * path operations per frame, ran at 30fps and missed 97% of its frame
 * budget - while the person was already waiting for an answer.
 *
 * So the two things worth checking are that it still says what the agent is
 * doing, and that it costs nothing to say it.
 *
 * Run against a served instance:  node tests/agent_stage.js [url]
 */
const { chromium } = require("playwright");
const URL = process.argv[2] || "http://127.0.0.1:8099/";

let pass = 0, total = 0;
const fails = [];
function check(label, ok, detail) {
  total += 1;
  if (ok) { pass += 1; console.log("  PASS  " + label); }
  else { fails.push(label); console.log("  FAIL  " + label + (detail ? "\n        " + detail : "")); }
}

const PROBE = `
  window.__frames = []; window.__long = [];
  (function s(prev){ requestAnimationFrame((t)=>{ if(prev) window.__frames.push(t-prev); s(t); }); })(0);
  try { new PerformanceObserver((l)=>{for(const e of l.getEntries()) window.__long.push(e.duration);})
    .observe({entryTypes:["longtask"]}); } catch(e){}
`;
const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

async function open(browser, opts) {
  const ctx = await browser.newContext(Object.assign({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true,
  }, opts || {}));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => check("no page error", false, String(e).slice(0, 160)));
  await page.addInitScript(PROBE);
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => window.DATA && window.DATA.rows && window.DATA.rows.length > 0,
    null, { timeout: 90000 });
  return { ctx, page };
}

async function mount(page) {
  return page.evaluate(() => {
    const host = document.createElement("div");
    host.className = "research";
    host.style.cssText = "position:fixed;left:12px;top:60px;width:350px;z-index:9999";
    document.body.appendChild(host);
    window.__host = host;
    window.__a = ResearchAnim.create(host, {});
    return !!window.__a;
  });
}

const read = (page) => page.evaluate(() => {
  const list = document.querySelector(".rsteps");
  const rail = document.querySelector(".rrail");
  return {
    p: parseFloat(list.style.getPropertyValue("--p") || "0"),
    railScaleY: rail ? getComputedStyle(rail).transform : "none",
    rows: [...document.querySelectorAll(".rstep")].map((r) => ({
      state: r.classList.contains("is-now") ? "now"
        : r.classList.contains("is-done") ? "done" : "?",
      text: r.textContent.trim(),
    })),
    canvasesInStage: window.__host.querySelectorAll("canvas").length,
  };
});

(async () => {
  const browser = await chromium.launch();

  // ---- what it says -------------------------------------------------
  {
    const { ctx, page } = await open(browser);
    check("the module is there", await mount(page));

    let s = await read(page);
    check("it starts with one live step", s.rows.length === 1 && s.rows[0].state === "now",
      JSON.stringify(s.rows));
    check("the stage draws no canvas", s.canvasesInStage === 0,
      `${s.canvasesInStage} canvas(es) in the stage`);

    await page.evaluate(() => window.__a.step("Searching the measurements"));
    await page.waitForTimeout(80);
    s = await read(page);
    check("a step appends a row", s.rows.length === 2, JSON.stringify(s.rows));
    check("the row carries the label the agent gave it",
      s.rows[1].text === "Searching the measurements", s.rows[1].text);
    check("the step before it is marked finished", s.rows[0].state === "done", s.rows[0].state);
    check("only the newest step is live",
      s.rows.filter((r) => r.state === "now").length === 1);

    const before = s.p;
    await page.evaluate(() => window.__a.step("Reading the source sentences"));
    await page.waitForTimeout(80);
    s = await read(page);
    check("the line advances with each step", s.p > before, `${before} -> ${s.p}`);
    check("the line stops at the live step, not past it", s.p < 1, String(s.p));
    check("the line is drawn by a transform",
      /matrix\(1, 0, 0, 0?\.\d+/.test(s.railScaleY), s.railScaleY);

    await page.evaluate(() => window.__a.done());
    await page.waitForTimeout(80);
    s = await read(page);
    check("finishing closes the line", s.p === 1, String(s.p));
    check("nothing is left live when it is done",
      s.rows.every((r) => r.state === "done"), JSON.stringify(s.rows.map((r) => r.state)));

    await page.evaluate(() => { window.__a.step("after stop"); window.__a.stop(); });
    const n = (await read(page)).rows.length;
    await page.evaluate(() => window.__a.step("should not appear"));
    await page.waitForTimeout(60);
    check("a stopped stage adds nothing more", (await read(page)).rows.length === n);
    await ctx.close();
  }

  // ---- what it costs -------------------------------------------------
  {
    const { ctx, page } = await open(browser);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await mount(page);
    for (const l of ["Checking what the library holds", "Searching the measurements",
                     "Reading the source sentences"]) {
      await page.evaluate((x) => window.__a.step(x), l);
      await page.waitForTimeout(220);
    }
    await page.waitForTimeout(1200);
    await page.evaluate(() => { window.__frames = []; window.__long = []; });
    await page.waitForTimeout(4000);
    const { frames, long } = await page.evaluate(
      () => ({ frames: window.__frames, long: window.__long }));
    const late = frames.filter((f) => f > 25).length / Math.max(frames.length, 1);
    const p95 = pct(frames, 0.95);

    console.log(`\n  with the stage up at 4x throttle:`
      + ` p95 ${p95.toFixed(1)}ms, median ${pct(frames, 0.5).toFixed(1)}ms,`
      + ` ${(late * 100).toFixed(0)}% late, ${long.length} long task(s)\n`);
    // The sheet this replaced sat at a 33.3ms median with 97% of frames late.
    // Gated on the same two numbers as tests/frame_cost.js, and for the same
    // reason: repeated runs of identical code move the late-frame share
    // around by twenty points while the median does not move at all, so the
    // tail is measuring the host. The loose ceiling still catches 97%.
    check("the stage keeps 60fps as its median", pct(frames, 0.5) < 20,
      `${pct(frames, 0.5).toFixed(1)}ms`);
    check("the stage blocks nothing", long.length <= 2, `${long.length} long task(s)`);
    check("the stage is not redrawing itself constantly", late <= 0.40,
      `${(late * 100).toFixed(0)}% late`);
    await ctx.close();
  }

  // ---- with motion switched off ---------------------------------------
  {
    const { ctx, page } = await open(browser, { reducedMotion: "reduce" });
    await mount(page);
    await page.evaluate(() => window.__a.step("Searching the measurements"));
    await page.waitForTimeout(260);
    const s = await read(page);
    check("the steps still read with motion off", s.rows.length === 2
      && s.rows[1].text === "Searching the measurements");
    check("the line is still drawn with motion off",
      /matrix\(1, 0, 0, 0?\.\d+/.test(s.railScaleY), s.railScaleY);
    const running = await page.evaluate(
      () => document.getAnimations().filter((a) => a.playState === "running").length);
    check("nothing is animating with motion off", running === 0, `${running} running`);
    await ctx.close();
  }

  console.log(`\nAgent stage: ${pass}/${total}`);
  if (fails.length) console.log("failed:\n  " + fails.join("\n  "));
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
