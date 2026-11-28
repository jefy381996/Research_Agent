/* The paid ears: recording, knowing when a sentence ended, and sending it.
 *
 * The browser's own recogniser streams and tells you when it thinks you have
 * stopped. The hosted one does not: it is handed a finished recording, so
 * something in the page has to decide when the sentence was over. That
 * decision is the part most likely to misbehave in a real room - cutting
 * somebody off mid-sentence, or sitting there recording a quiet room - and
 * it cannot be tested with a real microphone in a container.
 *
 * So the microphone is faked at the level the code actually reads it: a
 * loudness meter this test drives directly. Loud means somebody is talking,
 * quiet means they stopped, and what is checked is what the page does about
 * it - including that it never posts a recording of silence, which would be
 * billed.
 *
 * Run against a served instance:  node tests/voice_hosted.js [url]
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

/* A microphone whose loudness the test sets, a recorder that records
   nothing in particular, and no browser recogniser at all - so if the page
   manages to hold a conversation here, it did it with the hosted ears. */
const FAKE_MIC = () => {
  window.__loud = 0;                       // 0 is a silent room
  window.__rec = { made: 0, started: 0, stopped: 0, state: "inactive" };

  delete window.SpeechRecognition;
  delete window.webkitSpeechRecognition;

  const track = { stop() {}, kind: "audio" };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: () => Promise.resolve(stream) },
  });

  class FakeAnalyser {
    constructor() { this.fftSize = 512; this.smoothingTimeConstant = 0; }
    getByteTimeDomainData(buf) {
      // 128 is silence; the further from it, the louder.
      const amp = Math.round(window.__loud * 127);
      for (let i = 0; i < buf.length; i++) buf[i] = 128 + (i % 2 ? amp : -amp);
    }
  }
  class FakeCtx {
    constructor() { this.state = "running"; }
    createAnalyser() { return new FakeAnalyser(); }
    createMediaStreamSource() { return { connect() {} }; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  window.AudioContext = FakeCtx;
  window.webkitAudioContext = FakeCtx;

  class FakeRecorder {
    constructor() { window.__rec.made += 1; this.state = "inactive"; }
    static isTypeSupported() { return true; }
    start() { this.state = "recording"; window.__rec.state = "recording"; window.__rec.started += 1; }
    stop() {
      this.state = "inactive"; window.__rec.state = "inactive"; window.__rec.stopped += 1;
      if (this.ondataavailable) this.ondataavailable({ data: new Blob(["x"], { type: "audio/webm" }) });
      if (this.onstop) this.onstop();
    }
  }
  window.MediaRecorder = FakeRecorder;
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));

  // The server says it can hear; the transcription is ours to control.
  let posts = 0;
  await page.route("**/api/voice/status", (r) => r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ listen: true, speak: false,
                           listen_model: "whisper-large-v3-turbo", speak_voice: "" }),
  }));
  await page.route("**/api/voice/transcribe", (r) => {
    posts += 1;
    r.fulfill({ status: 200, contentType: "application/json",
                body: JSON.stringify({ text: "what about rGO" }) });
  });

  await page.addInitScript(FAKE_MIC);
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.DATA && window.DATA.rows && window.DATA.rows.length > 0,
    null, { timeout: 90000 });
  await sleep(600);

  check("this browser has no recogniser of its own",
    await page.evaluate(() => !window.SpeechRecognition && !window.webkitSpeechRecognition));
  check("and it can still listen, because the service can",
    await page.evaluate(() => Voice.supported().listen) === true);
  check("which is reported as the hosted ears",
    await page.evaluate(() => Voice.supported().via) === "hosted");

  const heard = [];
  await page.exposeFunction("__heard", (t) => heard.push(t));
  await page.evaluate(() => Voice.listen({
    onHeard: (t) => { window.__heard(t); Voice.speak("The median is 969."); },
  }));
  await sleep(500);
  check("pressing the toggle starts recording",
    await page.evaluate(() => window.__rec.started) === 1,
    JSON.stringify(await page.evaluate(() => window.__rec)));

  /* A quiet room must never be sent anywhere: it would be billed and it
     would produce nothing. */
  await sleep(1800);
  check("silence alone is never sent", posts === 0, `${posts} posted`);
  check("and it is still recording, waiting",
    await page.evaluate(() => window.__rec.state) === "recording");

  /* Somebody speaks, then stops. */
  await page.evaluate(() => { window.__loud = 0.6; });
  await sleep(700);
  check("talking does not cut in halfway", posts === 0, `${posts} posted`);
  await page.evaluate(() => { window.__loud = 0; });

  // Quiet for less than the end-of-sentence pause: still their turn.
  await sleep(400);
  check("a short pause mid-sentence is not the end of it", posts === 0, `${posts} posted`);

  await sleep(1200);
  check("a real pause ends the sentence and sends it", posts === 1, `${posts} posted`);
  await sleep(400);
  check("and what came back is handed over", heard.length === 1 && heard[0] === "what about rGO",
    JSON.stringify(heard));

  // Let the answer finish, which is what puts the ears back.
  await page.evaluate(() => { const u = window.__synth && window.__synth.current; if (u && u.onend) u.onend(); });
  await sleep(600);

  /* A cough is not a sentence. */
  const before = posts;
  await page.evaluate(() => { window.__loud = 0.6; });
  await sleep(80);
  await page.evaluate(() => { window.__loud = 0; });
  await sleep(1600);
  check("a brief noise is not treated as speech", posts === before, `${posts - before} extra`);

  /* And when the service stops answering, the conversation does not end. */
  await page.unroute("**/api/voice/transcribe");
  await page.route("**/api/voice/transcribe", (r) => r.fulfill({ status: 502, body: "no" }));
  await page.evaluate(() => { window.__loud = 0.6; });
  await sleep(700);
  await page.evaluate(() => { window.__loud = 0; });
  await sleep(1600);
  const after = await page.evaluate(() => ({
    wants: Voice.wantsToListen(), state: Voice.state(), via: Voice.supported().via,
  }));
  check("a failing service falls back rather than going deaf",
    after.wants === true && after.via !== "hosted", JSON.stringify(after));

  await page.evaluate(() => Voice.stopListening());
  await sleep(200);
  check("stopping stops the recorder",
    await page.evaluate(() => window.__rec.state) === "inactive");
  check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

  console.log(`\nHosted ears: ${pass}/${total}`);
  if (fails.length) console.log("failed:\n  " + fails.join("\n  "));
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
