/* The listening loop itself.
 *
 * voice_ui.js tests the pure parts. This tests the part that actually broke
 * in use: a recogniser that stops and is never restarted, and a microphone
 * that hears the app's own answer. Neither can be tested with a real
 * recogniser - there is no microphone here and Chrome's recogniser needs a
 * network - so a fake one is installed before the page loads, which is the
 * only moment it can be, because voice.js reads SpeechRecognition once.
 *
 * Run against a served instance:  node tests/voice_live.js [url]
 */
const { chromium } = require("playwright");
const URL = process.argv[2] || "http://127.0.0.1:8099/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAKE = () => {
  window.__rec = { starts: 0, stops: 0, aborts: 0, last: null };
  window.SpeechRecognition = class {
    constructor() { window.__rec.last = this; }
    start() { window.__rec.starts += 1; if (this.onstart) this.onstart(); }
    stop() { window.__rec.stops += 1; }
    abort() { window.__rec.aborts += 1; }
  };
  window.__synth = { spoken: [], cancels: 0, current: null };
  // speechSynthesis is a read-only accessor on window: a plain assignment
  // does nothing and leaves the real headless synthesiser in place, which
  // never fires onstart, so the test reads as though speaking never began.
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: {
      getVoices: () => [],
      speak(u) {
        window.__synth.spoken.push(u.text);
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
  // Where the module's callbacks land, so the test can see them.
  window.__spy = { heard: [], partial: [], states: [] };
};

let pass = 0, total = 0;
const fails = [];
function check(label, ok, detail) {
  total += 1;
  if (ok) { pass += 1; console.log("  PASS  " + label); }
  else { fails.push(label); console.log("  FAIL  " + label + (detail ? "\n        " + detail : "")); }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(FAKE);
  await page.goto(URL, { waitUntil: "networkidle" });

  const begin = () => page.evaluate(() => {
    window.__spy = { heard: [], partial: [], states: [] };
    window.__rec.starts = 0;
    Voice.stopListening();
    window.__rec.starts = 0;
    return Voice.listen({
      onHeard: (t) => window.__spy.heard.push(t),
      onPartial: (t) => window.__spy.partial.push(t),
      onState: (s, d) => window.__spy.states.push(s + (d ? ":" + d : "")),
    });
  });

  /* ── the recogniser is kept alive ─────────────────────── */

  check("listening starts", await begin() === true);
  check("the recogniser was started once",
    await page.evaluate(() => window.__rec.starts) === 1);

  // Chrome ends recognition after about a minute of quiet. Nothing in the
  // first version restarted it, so hands-free died silently.
  await page.evaluate(() => window.__rec.last.onend());
  await sleep(600);
  check("it restarts itself after the browser ends the session",
    await page.evaluate(() => window.__rec.starts) >= 2,
    "starts=" + await page.evaluate(() => window.__rec.starts));
  check("and it still wants to be listening",
    await page.evaluate(() => Voice.wantsToListen()) === true);

  // Stopping must actually stop.
  await begin();
  await page.evaluate(() => { window.__held = window.__rec.last; Voice.stopListening(); });
  const before = await page.evaluate(() => window.__rec.starts);
  await page.evaluate(() => { if (window.__held.onend) window.__held.onend(); });
  await sleep(500);
  check("after being stopped it does not restart",
    await page.evaluate(() => window.__rec.starts) === before);
  check("and it no longer wants to listen",
    await page.evaluate(() => Voice.wantsToListen()) === false);

  // A blocked microphone is terminal: restarting would spin forever.
  await begin();
  await page.evaluate(() => {
    window.__rec.last.onerror({ error: "not-allowed" });
    window.__rec.last.onend();
  });
  await sleep(500);
  check("a blocked microphone stops the loop rather than spinning",
    await page.evaluate(() => Voice.wantsToListen()) === false);
  check("and the reason is reported",
    (await page.evaluate(() => window.__spy.states.join(","))).includes("not-allowed"));

  // A recogniser that cannot start must give up rather than loop.
  await begin();
  for (let i = 0; i < 9; i++) {
    await page.evaluate(() => { if (window.__rec.last.onend) window.__rec.last.onend(); });
    await sleep(120);
  }
  await sleep(1200);
  check("repeated immediate failures eventually give up",
    await page.evaluate(() => Voice.wantsToListen()) === false);
  check("and say so",
    (await page.evaluate(() => window.__spy.states.join(","))).includes("could-not-restart"));

  /* ── our own voice is not a question ─────────────────── */

  const sentence = "The median specific capacity is 969 milliamp hours per gram "
                 + "across 412 measurements from 288 papers";

  const fire = (text, final) => page.evaluate(([t, f]) => {
    window.__rec.last.onresult({
      resultIndex: 0,
      results: [Object.assign([{ transcript: t }], { isFinal: f })],
    });
  }, [text, final !== false]);

  await begin();
  await page.evaluate((s) => Voice.speak(s), sentence);
  check("the answer is being spoken",
    await page.evaluate(() => Voice.isSpeaking()) === true);

  await fire("the median specific capacity is 969 milliamp hours");
  check("the app hearing itself is not taken as a question",
    await page.evaluate(() => window.__spy.heard.length) === 0,
    JSON.stringify(await page.evaluate(() => window.__spy.heard)));
  check("and it does not cut its own answer off",
    await page.evaluate(() => Voice.isSpeaking()) === true);

  // A person talking over it is a different matter.
  await fire("what about reduced graphene oxide");
  check("a real interruption is heard",
    await page.evaluate(() => window.__spy.heard.length) === 1,
    JSON.stringify(await page.evaluate(() => window.__spy.heard)));
  check("and it stops talking",
    await page.evaluate(() => Voice.isSpeaking()) === false);
  check("the synthesiser was actually cancelled",
    await page.evaluate(() => window.__synth.cancels) > 0);

  // "Stop" must work even though we are saying words.
  await begin();
  await page.evaluate((s) => Voice.speak(s), sentence);
  await fire("stop");
  check("'stop' gets through while it is speaking",
    (await page.evaluate(() => window.__spy.heard.join("|"))).toLowerCase().includes("stop"));
  check("and silences it",
    await page.evaluate(() => Voice.isSpeaking()) === false);

  // The speakers keep arriving for a moment after the voice stops.
  await begin();
  await page.evaluate((s) => Voice.speak(s), sentence);
  await page.evaluate(() => { const u = window.__synth.current; if (u.onend) u.onend(); });
  check("speaking has finished",
    await page.evaluate(() => Voice.isSpeaking()) === false);
  await fire("across 412 measurements from 288 papers");
  check("an echo arriving just after the voice stops is still ignored",
    await page.evaluate(() => window.__spy.heard.length) === 0,
    JSON.stringify(await page.evaluate(() => window.__spy.heard)));

  // And once the tail has passed, the same words are a legitimate question.
  await sleep(900);
  await fire("across 412 measurements from 288 papers");
  check("but the same words later are heard normally",
    await page.evaluate(() => window.__spy.heard.length) === 1);

  // Nothing suppressed when not speaking at all.
  await begin();
  await fire("how many cycles do sodium ion graphene anodes survive");
  check("an ordinary question in silence is heard",
    await page.evaluate(() => window.__spy.heard.length) === 1);

  console.log(`\nVoice loop scorecard: ${pass}/${total}`);
  if (fails.length) console.log("failed:\n  " + fails.join("\n  "));
  if (errors.length) console.log("console errors:\n  " + errors.slice(0, 5).join("\n  "));
  await browser.close();
  process.exit(pass === total ? 0 : 1);
})();
