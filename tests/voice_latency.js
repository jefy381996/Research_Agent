/* How long the voice loop takes, and whether it ever hears itself.
 *
 * Two of the three numbers that matter can be measured honestly here and one
 * cannot. The recogniser's own delay belongs to the browser and the network
 * behind it, and the synthesiser's startup belongs to the operating system;
 * neither exists in a headless container. What does exist, and what was
 * actually slow, is everything between: the moment a sentence is recognised,
 * through finding the measurements and building the answer, to the first word
 * going to the voice. That is the application's share, it is the only share
 * the application can fix, and it is what is budgeted here.
 *
 * Run against a served instance:  node tests/voice_latency.js [url]
 */
const { chromium } = require("playwright");
const URL = process.argv[2] || "http://127.0.0.1:8099/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const THROTTLE = 4;            // roughly a mid-range phone against this box
const TURNS = 6;
/* The whole point of answering by rule rather than by model is that it is
   fast enough to hold a conversation. A second is the limit past which a
   person starts to wonder whether it heard them. */
const BUDGET_MS = 1000;

const QUESTIONS = [
  "what capacity do silicon anodes reach",
  "what is the thermal conductivity of graphene composites",
  "sheet resistance of graphene transparent electrodes",
  "what is the Young's modulus of graphene",
  "water permeance of graphene oxide membranes",
  "how many cycles do graphene anodes survive",
];

let pass = 0, total = 0;
const fails = [];
function check(label, ok, detail) {
  total += 1;
  if (ok) { pass += 1; console.log("  PASS  " + label); }
  else { fails.push(label); console.log("  FAIL  " + label + (detail ? "\n        " + detail : "")); }
}

/* A recogniser and a voice whose timing the test owns. Installed before the
   page loads so the application wires itself to these and nothing else. */
const FAKE = () => {
  window.__rec = { starts: 0, last: null, liveWhileSpeaking: 0 };
  window.SpeechRecognition = class {
    constructor() { window.__rec.last = this; }
    start() { window.__rec.starts += 1; window.__rec.live = this; }
    stop() { window.__rec.live = null; }
    abort() { window.__rec.live = null; }
  };
  window.__synth = { spoken: [], at: [], current: null, cancels: 0 };
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: {
      getVoices: () => [],
      speak(u) {
        window.__synth.spoken.push(u.text);
        window.__synth.at.push(performance.now());
        window.__synth.current = u;
        if (u.onstart) u.onstart();
      },
      cancel() { window.__synth.cancels += 1; },
    },
  });
  Object.defineProperty(window, "SpeechSynthesisUtterance", {
    configurable: true,
    value: class { constructor(t) { this.text = t; } },
  });
};

const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  await page.addInitScript(FAKE);
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => window.DATA && window.DATA.rows && window.DATA.rows.length > 0,
    null, { timeout: 90000 });
  await page.waitForTimeout(1500);

  // Start a conversation the way a person does: by pressing the one button.
  await page.click("#mic");
  await page.waitForTimeout(400);
  check("pressing the button starts listening",
    await page.evaluate(() => document.getElementById("mic").getAttribute("aria-pressed")) === "true");

  const times = [];
  let heardItself = 0;

  for (const q of QUESTIONS) {
    const spokenBefore = await page.evaluate(() => window.__synth.spoken.length);
    const t = await page.evaluate((text) => {
      const start = performance.now();
      window.__t0 = start;
      const r = window.__rec.last;
      r.onresult({
        resultIndex: 0,
        results: [Object.assign([{ transcript: text }], { isFinal: true })],
      });
      return start;
    }, q);

    // Wait for the first word to reach the voice.
    try {
      await page.waitForFunction(
        (n) => window.__synth.spoken.length > n, spokenBefore, { timeout: 15000 });
    } catch (e) {
      check(`answered "${q.slice(0, 32)}..."`, false, "nothing was spoken within 15s");
      continue;
    }
    const ms = await page.evaluate(() => window.__synth.at[window.__synth.at.length - 1] - window.__t0);
    times.push(ms);

    // While it speaks, nothing may be listening. Anything the recogniser
    // could deliver here is an echo waiting to happen.
    const live = await page.evaluate(() => ({
      earsLive: !!window.__rec.live,
      listening: Voice.isListening(),
      canDeliver: typeof window.__rec.last.onresult === "function",
    }));
    if (live.earsLive || live.listening || live.canDeliver) heardItself += 1;

    // Let the answer finish so the next turn starts from listening.
    await page.evaluate(() => { const u = window.__synth.current; if (u && u.onend) u.onend(); });
    await page.waitForTimeout(260);
  }

  const median = pct(times, 0.5), worst = Math.max(...times);
  console.log(`\n  ${times.length} turns at ${THROTTLE}x throttle on a phone viewport`);
  console.log(`  recognised -> first word out: median ${median.toFixed(0)}ms,`
    + ` worst ${worst.toFixed(0)}ms`);
  console.log(`  (the recogniser's own delay and the voice's startup are the`);
  console.log(`   browser's, not this application's, and are not in these numbers)\n`);

  check(`every turn answered`, times.length === QUESTIONS.length,
    `${times.length} of ${QUESTIONS.length}`);
  check(`median under ${BUDGET_MS}ms`, median < BUDGET_MS, `${median.toFixed(0)}ms`);
  check(`worst turn under ${BUDGET_MS}ms`, worst < BUDGET_MS, `${worst.toFixed(0)}ms`);
  check("it never had its ears open while speaking", heardItself === 0,
    `${heardItself} of ${QUESTIONS.length} turns`);

  // Stopping has to be immediate: it is what a person does when it is wrong.
  await page.evaluate(() => { Voice.speak("A long sentence that is still being read out loud"); });
  await page.waitForTimeout(120);
  const stopMs = await page.evaluate(async () => {
    const t0 = performance.now();
    document.getElementById("mic").click();
    await new Promise((r) => setTimeout(r, 0));
    return performance.now() - t0;
  });
  const after = await page.evaluate(() => ({
    speaking: Voice.isSpeaking(), state: Voice.state(),
    pressed: document.getElementById("mic").getAttribute("aria-pressed"),
  }));
  console.log(`  pressing the button to stop took ${stopMs.toFixed(0)}ms\n`);
  check("pressing it again stops the voice at once", !after.speaking && stopMs < 100,
    `${stopMs.toFixed(0)}ms, speaking=${after.speaking}`);
  check("and the button says so", after.pressed === "false", after.pressed);

  check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

  console.log(`\nVoice latency: ${pass}/${total}`);
  if (fails.length) console.log("failed:\n  " + fails.join("\n  "));
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
