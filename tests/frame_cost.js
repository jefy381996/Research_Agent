/* What the interface costs to look at, on a phone that is not fast.
 *
 * Animation is the one part of this project where "it feels fine" is a lie
 * told by a fast machine. The background lattice redraws every bond and every
 * node sixty times a second; on a desktop that is invisible and on a cheap
 * phone it is the whole budget. So this throttles the processor to something
 * like a mid-range phone, sits on each screen doing nothing, and measures
 * what the page spends while the user is simply reading.
 *
 * Three numbers matter, and the third is the one that is felt:
 *
 *   long tasks   - stretches over 50ms where the page cannot respond to a tap
 *   p95 frame    - the slow frames, not the average, because the average
 *                  hides every stutter that is actually noticed
 *   janky        - share of frames that missed 60fps
 *
 * Run against a served instance:  node tests/frame_cost.js [url] [--budget]
 * With --budget it exits non-zero if a screen is over the limits below, which
 * is how this becomes a test rather than a report.
 */
const { chromium } = require("playwright");

const URL = process.argv[2] && !process.argv[2].startsWith("--")
  ? process.argv[2] : "http://127.0.0.1:8080/";
const BUDGET = process.argv.includes("--budget");
const THROTTLE = 4;            // roughly a mid-range phone against this box
const SAMPLE_MS = 4000;
const SETTLE_MS = 1800;        // let boot animations finish first

// What a screen is allowed to cost while the reader is doing nothing.
const LIMITS = { longTasks: 2, p95: 34, janky: 0.25 };

// Navigated by calling the app's own switcher rather than clicking: on a
// phone the navigation lives in a drawer, and opening it would measure the
// drawer rather than the screen.
const SCREENS = ["home", "evidence", "properties"];
const VIEW_OF = { home: "ask", evidence: "evidence", properties: "properties" };

const PROBE = `
  window.__frames = [];
  window.__long = [];
  (function sample(prev) {
    requestAnimationFrame((t) => {
      if (prev) window.__frames.push(t - prev);
      sample(t);
    });
  })(0);
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__long.push(e.duration);
    }).observe({ entryTypes: ["longtask"] });
  } catch (e) {}
`;

const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true,
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  await page.addInitScript(PROBE);

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.DATA && window.DATA.rows
    && window.DATA.rows.length > 0, null, { timeout: 90000 });

  // How much there is to draw, which is the thing to reduce.
  const scene = await page.evaluate(() => {
    const c = document.getElementById("lattice");
    return {
      canvases: document.querySelectorAll("canvas").length,
      lattice: c ? `${c.width}x${c.height}` : "none",
      keyframed: [...document.styleSheets].reduce((n, sheet) => {
        try {
          return n + [...sheet.cssRules].filter((r) => r.type === 7).length;
        } catch (e) { return n; }
      }, 0),
    };
  });

  console.log(`Frame cost at ${THROTTLE}x throttle, phone viewport`);
  console.log(`  canvases ${scene.canvases}, lattice ${scene.lattice},`
    + ` ${scene.keyframed} keyframe animations defined\n`);

  let over = 0;
  for (const name of SCREENS) {
    await page.evaluate((v) => show(v), VIEW_OF[name]);
    await page.waitForTimeout(SETTLE_MS);
    await page.evaluate(() => { window.__frames = []; window.__long = []; });
    await page.waitForTimeout(SAMPLE_MS);
    const { frames, long } = await page.evaluate(() => ({
      frames: window.__frames, long: window.__long,
    }));
    const janky = frames.filter((f) => f > 16.7).length / Math.max(frames.length, 1);
    const p95 = pct(frames, 0.95);
    const longTotal = long.reduce((a, b) => a + b, 0);
    const bad = long.length > LIMITS.longTasks || p95 > LIMITS.p95
      || janky > LIMITS.janky;
    if (bad) over += 1;
    console.log(`  ${name.padEnd(13)} ${bad ? "OVER " : "ok   "}`
      + ` p95 ${p95.toFixed(1).padStart(6)}ms`
      + `  median ${pct(frames, 0.5).toFixed(1).padStart(5)}ms`
      + `  janky ${(janky * 100).toFixed(0).padStart(3)}%`
      + `  long tasks ${String(long.length).padStart(2)}`
      + ` (${longTotal.toFixed(0)}ms)`);
  }

  console.log(`\n  budget: at most ${LIMITS.longTasks} long tasks,`
    + ` p95 under ${LIMITS.p95}ms, under ${LIMITS.janky * 100}% janky frames`);
  if (over) console.log(`  ${over} screen(s) over budget`);
  await browser.close();
  process.exit(BUDGET && over ? 1 : 0);
})();
