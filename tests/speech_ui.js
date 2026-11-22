/* Speech that runs on the visitor's machine.
 *
 * The models cannot be downloaded in a test - they are a hundred and sixty
 * megabytes - and there is no microphone here either. What is tested is the
 * part that decides whether to download them at all, which is where a wrong
 * answer costs the most: offering a hundred and sixty megabytes to a phone on
 * a metered connection, or running a voice on a processor that takes three
 * seconds to speak one.
 *
 * Run against a served instance:  node tests/speech_ui.js [url]
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

const CAP = (over) => Object.assign({
  gpu: false, gpuSoftware: false, gpuName: "", cores: 8, memory: 8,
  saveData: false, slowNetwork: false, cached: false, secure: true,
}, over || {});

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.LocalSpeech && window.Voice, { timeout: 30000 });

  const plan = (over) => page.evaluate((c) => window.LocalSpeech.plan(c), CAP(over));

  /* ── nothing is downloaded without being asked ────────── */
  const sizes = await page.evaluate(() => window.LocalSpeech.sizes);
  check("the download sizes are stated, not guessed at runtime",
    sizes.earsSmall.mb > 0 && sizes.earsLarge.mb > 0 && sizes.voice.mb > 0,
    JSON.stringify(sizes));

  /* ── who gets offered what ────────────────────────────── */
  const gpu = await plan({ gpu: true });
  check("a machine with a real graphics card is offered both halves",
    gpu.ears === "earsLarge" && gpu.voice === "voice", JSON.stringify(gpu));
  check("and the size quoted is both models added up",
    gpu.mb === sizes.earsLarge.mb + sizes.voice.mb, `${gpu.mb}`);

  const cpu = await plan({ gpu: false });
  check("a machine without one is offered the ears only",
    cpu.ears === "earsSmall" && cpu.voice === null, JSON.stringify(cpu));
  check("it is offered the smaller listener, which a processor can keep up with",
    cpu.ears === "earsSmall" && sizes.earsSmall.mb < sizes.earsLarge.mb);
  check("and the size quoted is only what it will actually fetch",
    cpu.mb === sizes.earsSmall.mb, `${cpu.mb}`);
  check("and it says why the voice is missing rather than hiding it",
    /too slow|no graphics|graphics card/i.test(cpu.why), cpu.why);

  // A software adapter answers like a graphics card and then runs on the
  // processor anyway, slower than not asking.
  const soft = await plan({ gpu: false, gpuSoftware: true });
  check("a software graphics adapter does not count as a graphics card",
    soft.voice === null, JSON.stringify(soft));
  check("and is named as the reason", /no real graphics card/i.test(soft.why), soft.why);

  const swName = await page.evaluate(() => [
    window.LocalSpeech.softwareAdapter({ architecture: "swiftshader" }),
    window.LocalSpeech.softwareAdapter({ architecture: "llvmpipe" }),
    window.LocalSpeech.softwareAdapter({ description: "Microsoft Basic Render Driver" }),
    window.LocalSpeech.softwareAdapter({ vendor: "apple", architecture: "metal-3" }),
    window.LocalSpeech.softwareAdapter({ vendor: "nvidia", architecture: "turing" }),
  ]);
  check("swiftshader, llvmpipe and the basic renderer are all recognised",
    swName[0] && swName[1] && swName[2], JSON.stringify(swName));
  check("a real card is not", !swName[3] && !swName[4], JSON.stringify(swName));

  /* ── when not to offer it at all ──────────────────────── */
  for (const [label, over, why] of [
    ["data saver is on", { saveData: true }, /data saver/i],
    ["the connection is 2g", { slowNetwork: true }, /slow/i],
    ["there are too few cores", { cores: 2 }, /core/i],
    ["there is too little memory", { memory: 2 }, /memory/i],
    ["the page is not on a secure connection", { secure: false }, /secure/i],
  ]) {
    const p = await plan(over);
    check(`nothing is offered when ${label}`, p.ears === null && p.mb === 0,
      JSON.stringify(p));
    check(`  and the reason given is about ${label}`, why.test(p.why), p.why);
  }

  check("unknown memory is not treated as too little",
    (await plan({ memory: null })).ears !== null);

  /* ── a second visit must not be warned about a download ── */
  const again = await plan({ gpu: true, cached: true });
  check("an already-downloaded engine is known to be cached", again.cached === true);

  /* ── the control on screen ────────────────────────────── */
  const btn = await page.evaluate(() => {
    const b = document.getElementById("localvoice");
    return b ? { present: true, pressed: b.getAttribute("aria-pressed"),
                 label: (document.getElementById("lvlabel") || {}).textContent || "",
                 title: b.title, hidden: b.hidden, disabled: b.disabled } : { present: false };
  });
  check("the control exists", btn.present === true);
  check("it starts switched off", btn.pressed === "false");
  check("nothing has been downloaded just by opening the page",
    await page.evaluate(() => window.LocalSpeech.ready().ears === false
                           && window.LocalSpeech.ready().voice === false));
  check("and the microphone has not been opened either",
    await page.evaluate(() => window.LocalSpeech.isMicOpen() === false));

  /* ── the voice layer still answers for both engines ───── */
  const sw = await page.evaluate(() => {
    const before = window.Voice.usingLocal();
    window.Voice.useLocal({ ears: true, voice: false });
    const mid = window.Voice.usingLocal();
    window.Voice.useLocal({ ears: false, voice: false });
    return { before, mid, after: window.Voice.usingLocal() };
  });
  check("the engine can be switched to the local ears", sw.mid.ears === true);
  check("and switched back", sw.after.ears === false && sw.before.ears === false);

  /* ── speaking a long answer a sentence at a time ──────── */
  const sent = await page.evaluate(() => window.LocalSpeech.sentences(
    "The median is 969 mAh/g. Half fall between 691 and 1,516! Is that useful? Yes."));
  check("an answer is split into sentences so the first can start early",
    sent.length === 4, JSON.stringify(sent));
  check("and nothing is lost in the split",
    sent.join(" ").replace(/\s+/g, " ") ===
      "The median is 969 mAh/g. Half fall between 691 and 1,516! Is that useful? Yes.",
    sent.join(" "));
  check("an empty answer produces nothing to say",
    (await page.evaluate(() => window.LocalSpeech.sentences(""))).length === 0);

  /* ── the mishearings the round-trip actually produced ─── */
  const heard = await page.evaluate(() => ({
    roundTrip: Voice.fixTerms("reduced graphing oxide shows a specific capacity of 969"),
    mangled: Voice.fixTerms("gapheene anodes"),
    swapped: Voice.fixTerms("garphene"),
    plural: Voice.fixTerms("silicon anodes reach"),
    realWord: Voice.fixTerms("graphic design"),
    graphingAlone: Voice.fixTerms("I am graphing the results"),
  }));
  check("the mishearing the round-trip produced is corrected",
    /reduced graphene oxide/.test(heard.roundTrip), heard.roundTrip);
  check("so is a mispronunciation nobody listed", heard.mangled === "graphene anodes",
    heard.mangled);
  check("and a transposition", heard.swapped === "graphene", heard.swapped);
  check("a plural is not rewritten to its stem",
    heard.plural === "silicon anodes reach", heard.plural);
  check("an ordinary English word near a term is left alone",
    heard.realWord === "graphic design", heard.realWord);
  check("and 'graphing' on its own is still graphing",
    heard.graphingAlone === "I am graphing the results", heard.graphingAlone);

  /* ── the three bugs that made it unusable ─────────────── */
  /* All three were invisible on the machine this was written on, which has no
     graphics card: the listener only went to the graphics card where one
     existed, the voice only downloaded 310 MB where one existed, and neither
     could hang where neither ran. The guards read the source, because that is
     where the mistakes were. */
  const src = await page.evaluate(async () => (await fetch("speech.js")).text());

  check("the voice fetches the size the button promised",
    sizes.voice.dtype === "q8",
    `dtype=${sizes.voice.dtype} (fp32 is 310 MB against the ${sizes.voice.mb} MB advertised)`);
  check("and the advertised size is in the range the q8 file actually is",
    sizes.voice.mb >= 80 && sizes.voice.mb <= 95, `${sizes.voice.mb} MB`);

  const asrBlock = (src.match(/automatic-speech-recognition[\s\S]{0,260}/) || [""])[0];
  check("the listener is never put on the graphics card",
    /device:\s*"wasm"/.test(asrBlock) && !/device:\s*p\.voice/.test(asrBlock),
    asrBlock.replace(/\s+/g, " ").slice(0, 150));

  check("transcribing cannot wait for ever",
    /withTimeout\(\s*asr\(/.test(src.replace(/\s+/g, " ")) ||
    /withTimeout\(asr\(/.test(src.replace(/\s+/g, "")),
    "no timeout around the transcription call");
  check("and neither can the check that the voice is fast enough",
    /withTimeout\(/.test((src.match(/checking the voice is fast enough[\s\S]{0,420}/) || [""])[0]),
    "the speed check itself could hang");
  check("a voice that is too slow is dropped rather than used",
    /VOICE_MAX_FACTOR/.test(src) && /voiceRejected/.test(src));
  check("and what happened is reported back",
    "voiceRejected" in (await page.evaluate(() => window.LocalSpeech.ready())));

  const vj = await page.evaluate(async () => (await fetch("voice.js")).text());
  check("repeated local failures hand the microphone back to the browser",
    /localFails\s*>=\s*2/.test(vj) && /local-gave-up/.test(vj));
  check("and the person is told that is what happened",
    /local-gave-up/.test(await page.evaluate(async () => (await fetch("app.js")).text())));

  /* ── the hosted option ────────────────────────────────── */
  /* This suite runs against the static copy, which has no server behind it,
     so the hosted button must not be offered here: it would be a promise the
     page cannot keep. */
  const svc = await page.evaluate(async () => {
    const s = await window.LocalSpeech.service();
    const btn = document.getElementById("servervoice");
    return { reported: s, offered: !!(btn && !btn.hidden) };
  });
  check("a page with no server behind it reports no hosted speech",
    svc.reported.listen === false, JSON.stringify(svc.reported));
  check("and does not offer the button", svc.offered === false);

  // The recording posted to the service has to be a wav a recogniser accepts.
  const wav = await page.evaluate(() => {
    const a = new Float32Array(16000);
    for (let i = 0; i < a.length; i++) a[i] = Math.sin(i / 8) * 0.2;
    const b = window.LocalSpeech.toWav(a, 16000);
    return b.size;
  });
  check("a recording is packaged as a wav of the right size",
    wav === 44 + 16000 * 2, `${wav} bytes`);

  const hdr = await page.evaluate(async () => {
    const a = new Float32Array(800);
    const buf = await window.LocalSpeech.toWav(a, 16000).arrayBuffer();
    const d = new DataView(buf), t = (o) => String.fromCharCode(
      d.getUint8(o), d.getUint8(o + 1), d.getUint8(o + 2), d.getUint8(o + 3));
    return { riff: t(0), wave: t(8), fmt: d.getUint16(20, true),
             ch: d.getUint16(22, true), rate: d.getUint32(24, true),
             bits: d.getUint16(34, true) };
  });
  check("with a header a recogniser will accept",
    hdr.riff === "RIFF" && hdr.wave === "WAVE" && hdr.fmt === 1 &&
    hdr.ch === 1 && hdr.rate === 16000 && hdr.bits === 16, JSON.stringify(hdr));

  // One set of ears at a time, whichever way round they are turned on.
  const route = await page.evaluate(() => {
    window.Voice.useLocal({ ears: true, voice: false, via: "service" });
    const a = window.Voice.usingLocal();
    window.Voice.useLocal({ ears: true, voice: false });
    const b = window.Voice.usingLocal();
    window.Voice.useLocal({ ears: false, voice: false });
    return { service: a, device: b, off: window.Voice.usingLocal() };
  });
  check("the ears can be pointed at the service", route.service.via === "service");
  check("and back at the machine", route.device.via === "device");
  check("and switched off entirely", route.off.ears === false);

  const appjs = await page.evaluate(async () => (await fetch("app.js")).text());
  check("turning one engine on turns the other off",
    /one set of ears at a time/.test(appjs) &&
    /SERVER\.on = false/.test(appjs) && /LOCAL\.on = false/.test(appjs));
  check("the hosted option says plainly that audio leaves the machine",
    /sent there to be/.test(appjs));

  console.log(`\nSpeech scorecard: ${pass}/${total}`);
  if (fails.length) console.log("failed:\n  " + fails.join("\n  "));
  if (errors.length) console.log("console errors:\n  " + errors.slice(0, 5).join("\n  "));
  await browser.close();
  process.exit(pass === total && errors.length === 0 ? 0 : 1);
})();
