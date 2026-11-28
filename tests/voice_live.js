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
  /* This file is about the browser's own ears. Whether the machine
     running it happens to have a speech key configured must not change
     what is tested, so the hosted service is reported as absent here;
     tests/voice_hosted.js is where the other path is driven. */
  await page.route("**/api/voice/status", (r) => r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ listen: false, speak: false,
                           listen_model: "", speak_voice: "" }),
  }));
  await page.goto(URL, { waitUntil: "networkidle" });

  /* Starting is no longer synchronous: the toggle asks the server which ears
     to use before it opens any, so that it does not start on the browser's
     and switch a moment later. */
  const begin = async () => {
    const r = await beginNow();
    await sleep(120);
    return r;
  };
  const beginNow = () => page.evaluate(() => {
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
    const r = window.__rec.last;
    r.onerror({ error: "not-allowed" });
    // A fatal error detaches the recogniser, so onend may already be gone.
    if (typeof r.onend === "function") r.onend();
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

  /* ── the ears are shut while it speaks ──────────────────────────────
     The old loop ran the recogniser straight through the answer and tried
     to recognise its own sentence coming back, which is why it sometimes
     asked itself its own question. Nothing listens now while an answer is
     being read, so there is no echo to catch - and the fake recogniser is
     the thing that proves it, because the module detaches it. */

  const sentence = "The median specific capacity is 969 milliamp hours per gram "
                 + "across 412 measurements from 288 papers";

  const fire = (text, final) => page.evaluate(([t, f]) => {
    const r = window.__rec.last;
    if (!r || typeof r.onresult !== "function") return "detached";
    r.onresult({
      resultIndex: 0,
      results: [Object.assign([{ transcript: t }], { isFinal: f })],
    });
    return "delivered";
  }, [text, final !== false]);

  await begin();
  const stopsBefore = await page.evaluate(() => window.__rec.stops + window.__rec.aborts);
  await fire("what capacity do silicon anodes reach");
  await sleep(120);
  check("a question is handed over",
    await page.evaluate(() => window.__spy.heard.length) === 1,
    JSON.stringify(await page.evaluate(() => window.__spy.heard)));
  check("and hearing it shuts the ears straight away",
    await page.evaluate(() => window.__rec.stops + window.__rec.aborts) > stopsBefore);

  await page.evaluate((s) => Voice.speak(s), sentence);
  await sleep(120);
  check("the answer is being spoken",
    await page.evaluate(() => Voice.isSpeaking()) === true);
  check("and nothing is listening while it is",
    await page.evaluate(() => Voice.isListening()) === false);
  check("so the app's own sentence cannot even reach it",
    await fire("the median specific capacity is 969 milliamp hours") === "detached");
  check("and the answer is not cut off by itself",
    await page.evaluate(() => Voice.isSpeaking()) === true);

  // When the answer ends, listening resumes without anyone asking.
  const startsBefore = await page.evaluate(() => window.__rec.starts);
  await page.evaluate(() => { const u = window.__synth.current; if (u && u.onend) u.onend(); });
  await sleep(200);
  check("the answer finishing puts the ears back",
    await page.evaluate(() => window.__rec.starts) > startsBefore);
  check("and it is listening again",
    await page.evaluate(() => Voice.isListening()) === true);
  check("the same words are an ordinary question once it has stopped talking",
    await fire("across 412 measurements from 288 papers") === "delivered");
  await sleep(120);
  check("and they are heard",
    await page.evaluate(() => window.__spy.heard.length) === 2,
    JSON.stringify(await page.evaluate(() => window.__spy.heard)));

  /* Interrupting is now a matter of loudness rather than of words, and it
     needs a microphone this browser has not got. What must be true without
     one is that losing it costs only the interrupting. */
  check("without a microphone there is no interrupting",
    await page.evaluate(() => Voice.canInterrupt()) === false);
  // The question just fired has not been answered by this harness, so the
  // engine is waiting on one. What matters is that it is still in the
  // conversation rather than shut down for want of a microphone.
  check("and the conversation carries on without it",
    await page.evaluate(() => Voice.wantsToListen()) === true
      && await page.evaluate(() => Voice.state()) !== "off",
    await page.evaluate(() => Voice.state()));

  /* If an answer never arrives, the ears must come back on their own.
     They are shut on purpose between hearing a question and speaking the
     reply, so anything that throws in between would otherwise leave the
     conversation deaf with no sign of why. This waits the real limit out
     rather than inspecting a timer, because the limit is the behaviour. */
  await begin();
  await page.evaluate(() => {
    window.__spy.heard = [];
    // Hand over a question and then do nothing at all about it.
    window.__rec.last.onresult({
      resultIndex: 0,
      results: [Object.assign([{ transcript: "a question nobody answers" }], { isFinal: true })],
    });
  });
  await sleep(300);
  check("while it waits for an answer, nothing is listening",
    await page.evaluate(() => Voice.state()) === "thinking",
    await page.evaluate(() => Voice.state()));
  const startsBeforeWait = await page.evaluate(() => window.__rec.starts);
  await sleep(13000);
  check("an answer that never comes does not leave it deaf",
    await page.evaluate(() => Voice.state()) === "listening",
    await page.evaluate(() => Voice.state()));
  check("and the ears were actually reopened",
    await page.evaluate(() => window.__rec.starts) > startsBeforeWait);
  check("and it said why",
    (await page.evaluate(() => window.__spy.states.join(","))).includes("no-answer-came"));

  // Stopping silences the voice as well as the ears.
  await page.evaluate((s) => Voice.speak(s), sentence);
  await sleep(80);
  const cancelsBefore = await page.evaluate(() => window.__synth.cancels);
  await page.evaluate(() => Voice.stopListening());
  await sleep(120);
  check("stopping cancels the synthesiser",
    await page.evaluate(() => window.__synth.cancels) > cancelsBefore);
  check("and it is off",
    await page.evaluate(() => Voice.state()) === "off");


  console.log(`\nVoice loop scorecard: ${pass}/${total}`);
  if (fails.length) console.log("failed:\n  " + fails.join("\n  "));
  if (errors.length) console.log("console errors:\n  " + errors.slice(0, 5).join("\n  "));
  await browser.close();
  process.exit(pass === total ? 0 : 1);
})();
