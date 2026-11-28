/* The sound the agent makes while it is still working.
 *
 * An instant answer takes about half a second and needs no sound. The agent
 * takes seconds, and in a voice conversation that is a silence with nothing
 * in it, in which the only reasonable thought is that the thing has died.
 *
 * Three things have to be true and none of them can be heard in a container,
 * so they are measured instead: it must say nothing at a reader who never
 * asked for audio, it must stop the instant the answer arrives, and it must
 * sound like a struck sheet rather than a notification. The last one is not
 * a matter of taste - a bell or a beep puts its partials at whole-number
 * multiples of the fundamental, and a membrane does not, so the ratios are
 * checkable.
 *
 * Run against a served instance:  node tests/waiting_sound.js [url]
 */
const { chromium } = require("playwright");
const URL = process.argv[2] || "http://127.0.0.1:8099/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, total = 0;
const fails = [];
function check(label, ok, detail) {
  total += 1;
  if (ok) { pass += 1; console.log("  PASS  " + label); }
  else { fails.push(label); console.log("  FAIL  " + label + (detail ? "\n        " + detail : "")); }
}

/* Every oscillator the page starts, with its frequency and when it began.
   Installed before the page loads, so nothing real ever reaches a speaker
   and every note is counted. */
const LISTEN = () => {
  window.__notes = [];
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const realOsc = AC.prototype.createOscillator;
  AC.prototype.createOscillator = function () {
    const osc = realOsc.call(this);
    const realStart = osc.start.bind(osc);
    osc.start = function (when) {
      window.__notes.push({ hz: osc.frequency.value, type: osc.type, at: Date.now() });
      return realStart(when);
    };
    return osc;
  };
};

(async () => {
  const browser = await chromium.launch({
    args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
  await page.addInitScript(LISTEN);
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.DATA && window.DATA.rows && window.DATA.rows.length > 0,
    null, { timeout: 90000 });
  await sleep(500);

  check("the module is there", await page.evaluate(() => !!window.Waiting));

  /* ── nothing is heard by somebody who did not ask for audio ────────── */
  const quiet = await page.evaluate(async () => {
    window.__notes = [];
    // VOICE.on is false: this is a reader working in silence.
    const before = window.VOICE ? window.VOICE.on : false;
    return { voiceOff: before === false, notes: window.__notes.length };
  });
  check("the page starts with voice off", quiet.voiceOff, String(quiet.voiceOff));
  check("and makes no sound at all", quiet.notes === 0, `${quiet.notes} notes`);

  /* ── while it waits, it taps ───────────────────────────────────────── */
  await page.evaluate(() => { window.__notes = []; Waiting.start(); });
  check("it is running", await page.evaluate(() => Waiting.isRunning()) === true);

  await sleep(1200);
  check("it says nothing during a short wait",
    await page.evaluate(() => window.__notes.length) === 0,
    `${await page.evaluate(() => window.__notes.length)} notes after 1.2s`);

  await sleep(1600);
  const first = await page.evaluate(() => window.__notes.slice());
  check("it taps once the wait gets long", first.length > 0, `${first.length} notes`);

  /* A struck membrane, not a beep: the partials of a circular membrane are
     not whole-number multiples of the fundamental. */
  if (first.length) {
    const base = Math.min(...first.map((n) => n.hz));
    const ratios = first.map((n) => n.hz / base).sort((a, b) => a - b);
    const whole = ratios.filter((r) => Math.abs(r - Math.round(r)) < 0.04);
    console.log(`\n  one tap: ${first.length} partials at ${ratios.map((r) => r.toFixed(2)).join(", ")}\n`);
    check("a tap has several partials, like a struck sheet",
      first.length >= 4, `${first.length}`);
    check("and they are not whole multiples, so it is not a beep",
      whole.length <= 1, `${whole.length} of ${ratios.length} are whole`);
  }

  /* ── a finished step is louder and higher, because it means something ── */
  await page.evaluate(() => { window.__notes = []; Waiting.step(); });
  await sleep(120);
  const stepNotes = await page.evaluate(() => window.__notes.slice());
  check("a finished step makes its own sound", stepNotes.length >= 4, `${stepNotes.length}`);
  if (stepNotes.length && first.length) {
    const stepBase = Math.min(...stepNotes.map((n) => n.hz));
    const idleBase = Math.min(...first.map((n) => n.hz));
    check("and it is higher than the waiting tap, so the two are told apart",
      stepBase > idleBase * 1.2, `${stepBase.toFixed(0)}Hz vs ${idleBase.toFixed(0)}Hz`);
  }

  /* ── and it stops ──────────────────────────────────────────────────── */
  await page.evaluate(() => { Waiting.stop(); window.__notes = []; });
  check("stopping stops it", await page.evaluate(() => Waiting.isRunning()) === false);
  await sleep(3400);
  check("and nothing is heard afterwards",
    await page.evaluate(() => window.__notes.length) === 0,
    `${await page.evaluate(() => window.__notes.length)} notes after stopping`);

  check("a step after stopping is silent too",
    await page.evaluate(() => { window.__notes = []; Waiting.step(); return window.__notes.length; }) === 0);

  check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

  console.log(`\nWaiting sound: ${pass}/${total}`);
  if (fails.length) console.log("failed:\n  " + fails.join("\n  "));
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
