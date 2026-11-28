/* Asking out loud.
 *
 * The audio itself cannot be tested in a headless browser - there is no
 * microphone and no installed voice - so what is tested here is everything
 * either side of it, which is where the mistakes are. A recogniser hears
 * "are gee oh" and the library calls it rGO. A screen reads "1,842 mAh/g"
 * and a person says "one thousand eight hundred and forty two milliamp hours
 * per gram". An answer holds sixty cards and an ear can hold one sentence.
 *
 * Run against a served instance:  node tests/voice_ui.js [url]
 */
const { chromium } = require("playwright");
const URL = process.argv[2] || "http://127.0.0.1:8099/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* [what is written, what must be heard in it] */
const SAYABLE = [
  ["1,842 mAh/g", "milliamp hours per gram"],
  ["1,842 mAh/g", "1842"],
  ["12.6 W/mK", "watts per metre kelvin"],
  ["48 ohm/sq", "ohms per square"],
  ["412 m2/g", "square metres per gram"],
  ["1.0 TPa", "terapascals"],
  ["62 dB", "decibels"],
  ["87%", "87 percent"],
  ["2,085 cm2/Vs", "square centimetres per volt second"],
  ["345 F/g", "farads per gram"],
  ["rGO anodes", "reduced graphene oxide"],
  ["made by CVD", "chemical vapour deposition"],
  ["a Li-S cell", "lithium sulfur"],
  ["the SEI layer", "solid electrolyte interphase"],
  ["median 969 [E8821][E9104]", "969"],
];
/* and what must NOT survive into speech */
const UNSAYABLE = [
  ["median 969 [E8821]", "E8821"],
  ["**bold** and `code`", "*"],
  ["a | table | row", "|"],
];

/* [what the microphone heard, what the library must receive] */
const HEARD = [
  ["what capacity do are gee oh anodes reach", "rGO"],
  ["argo anodes", "rGO"],
  ["eighteen hundred milliamps per gram", "mAh/g"],
  ["a lithium sulphur cell", "lithium-sulfur"],
  ["what is see rate", "C-rate"],
  ["grown by c v d", "CVD"],
  ["youngs modulus of graphine", "Young's"],
  ["youngs modulus of graphine", "graphene"],
];

/* [spoken, expected command kind, expected argument] */
const COMMANDS = [
  ["show me the measurements", "view", "evidence"],
  ["open properties", "view", "properties"],
  ["go to my data", "view", "mydata"],
  ["take me to the calculators", "view", "calculator"],
  ["stop", "silence", undefined],
  ["be quiet", "silence", undefined],
  ["say that again", "repeat", undefined],
  ["dark mode", "theme", "dark"],
  ["light mode", "theme", "light"],
  ["stop listening", "exit", undefined],
  // these are questions, not commands, and must fall through
  ["what capacity do silicon anodes reach", null, undefined],
  ["show me the thermal conductivity of graphene composites", null, undefined],
  ["why do silicon anodes crack", null, undefined],
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.DATA && window.DATA.rows
    && window.DATA.rows.length > 0 && window.Voice, null, { timeout: 60000 });
  await sleep(1000);

  let pass = 0, total = 0;
  const check = (name, ok, detail) => {
    total += 1; pass += ok ? 1 : 0;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok && detail !== undefined) console.log(`        ${detail}`);
  };

  const said = await page.evaluate((cases) =>
    cases.map(([input, want]) => ({ input, want, got: Voice.sayable(input) })), SAYABLE);
  for (const r of said) {
    check(`"${r.input}" is spoken as "${r.want}"`,
      r.got.includes(r.want), r.got);
  }
  const unsaid = await page.evaluate((cases) =>
    cases.map(([input, bad]) => ({ input, bad, got: Voice.sayable(input) })), UNSAYABLE);
  for (const r of unsaid) {
    check(`"${r.bad}" never reaches the voice`, !r.got.includes(r.bad), r.got);
  }

  const fixed = await page.evaluate((cases) =>
    cases.map(([input, want]) => ({ input, want, got: Voice.fixTerms(input) })), HEARD);
  for (const r of fixed) {
    check(`heard "${r.input.slice(0, 34)}" becomes "${r.want}"`,
      r.got.includes(r.want), r.got);
  }

  const cmds = await page.evaluate((cases) =>
    cases.map(([input, kind, arg]) =>
      ({ input, kind, arg, got: Voice.parseCommand(input) })), COMMANDS);
  for (const r of cmds) {
    const ok = r.kind === null
      ? r.got === null
      : !!r.got && r.got.kind === r.kind
        && (r.arg === undefined || r.got.arg === r.arg);
    check(`"${r.input.slice(0, 40)}" -> ${r.kind || "a question"}`, ok,
      JSON.stringify(r.got));
  }

  /* Every kind of answer must have something short to say. A spoken answer
     that reads out a table is worse than silence. */
  const SPOKEN = [
    "What is graphene?",
    "What capacity do silicon graphene anodes reach?",
    "What thermal conductivity do graphene composites reach?",
    "Compare material systems on capacity in lithium-ion anodes",
    "How has capacity changed by year for graphene anodes?",
    "An electrode at 1200 mAh/g and 3.7 V, what is the energy density?",
    "Which graphene company should I invest in?",
  ];
  const spoken = await page.evaluate((qs) => qs.map((q) => {
    const a = window.build(q);
    const line = spokenAnswer(a);
    return { q, kind: a.kind, line, words: line.split(/\s+/).length };
  }), SPOKEN);
  for (const r of spoken) {
    check(`${r.kind.padEnd(12)} says something short enough to hear`,
      r.line.length > 10 && r.words <= 60 && !/\|/.test(r.line),
      `${r.words} words: ${r.line.slice(0, 80)}`);
  }
  console.log("\n  sample:", spoken[1].line);

  /* One control, and it degrades honestly. */
  const ui = await page.evaluate(() => ({
    mic: !!document.getElementById("mic"),
    others: ["handsfree", "localvoice", "servervoice", "voice-open"]
      .filter((id) => !!document.getElementById(id)),
    bar: !!document.getElementById("vbar"),
    barHidden: document.getElementById("vbar").hidden,
    canListen: Voice.supported().listen,
    canSpeak: Voice.supported().speak,
  }));
  check("there is one voice control and a transcript strip",
    ui.mic && ui.bar, JSON.stringify(ui));
  check("and no second way in to the same thing",
    ui.others.length === 0, `still present: ${ui.others.join(", ")}`);
  check("the transcript strip starts hidden", ui.barHidden);

  /* A browser that cannot listen must say so rather than offer a dead button. */
  const degraded = await page.evaluate(() => {
    const real = window.SpeechRecognition, realWk = window.webkitSpeechRecognition;
    delete window.SpeechRecognition; delete window.webkitSpeechRecognition;
    const sup = (function () {
      const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
      return { listen: !!Rec };
    })();
    window.SpeechRecognition = real; window.webkitSpeechRecognition = realWk;
    return sup;
  });
  check("a browser without a recogniser is detectable", degraded.listen === false);
  check("there is a reason to show for it",
    typeof (await page.evaluate(() => Voice.supported().why ?? "ok")) === "string");

  /* ── it cannot hear itself ────────────────────────────────────────────
     The recogniser hears the speakers. The first version answered, heard
     its own sentence, and asked itself that sentence as the next question;
     the second compared what came back against what was being said and let
     through anything the recogniser had mangled.

     It is no longer a thing that has to be detected. While an answer is
     being spoken the recogniser is not running, so there is nothing for it
     to hear. That is what is checked here, by driving a whole turn through
     a recogniser and a voice we control the timing of. */
  const conversation = await page.evaluate(async () => {
    const log = [];
    // Stand in for the browser's recogniser, and record when it is up.
    function Fake() { Fake.live = this; this.started = false; }
    Fake.prototype.start = function () { this.started = true; Fake.up = true; log.push("ears open"); };
    Fake.prototype.stop = function () { this.started = false; Fake.up = false; log.push("ears shut"); if (this.onend) this.onend(); };
    Fake.prototype.abort = function () { this.started = false; Fake.up = false; log.push("ears shut"); if (this.onend) this.onend(); };

    // And for the voice, so the end of an utterance happens when we say.
    let pending = null;
    const synth = {
      speak(u) { pending = u; log.push("speaking"); setTimeout(() => u.onstart && u.onstart(), 0); },
      cancel() { pending = null; },
      getVoices() { return []; },
    };
    const realRec = window.SpeechRecognition, realWk = window.webkitSpeechRecognition;
    const realSynth = Object.getOwnPropertyDescriptor(window, "speechSynthesis");
    const realUtter = window.SpeechSynthesisUtterance;
    window.SpeechRecognition = Fake; window.webkitSpeechRecognition = Fake;
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };

    const seen = [];
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      if (!window.Voice) return { skipped: true };

      Voice.listen({ onHeard: (t) => { seen.push(t); Voice.speak("The median is 969 milliamp hours per gram"); } });
      await wait(30);
      const afterStart = Fake.up;

      // Somebody speaks, and the recogniser reports it.
      Fake.live.onresult({
        resultIndex: 0,
        results: [Object.assign([{ transcript: "what about rGO" }], { isFinal: true })],
      });
      await wait(60);
      const whileSpeaking = { earsUp: Fake.up, state: Voice.state(), listening: Voice.isListening() };

      // The answer finishes.
      if (pending && pending.onend) pending.onend();
      await wait(60);
      const afterSpeaking = { earsUp: Fake.up, state: Voice.state() };

      Voice.stopListening();
      await wait(20);
      return { afterStart, whileSpeaking, afterSpeaking, heard: seen,
               stopped: { earsUp: Fake.up, state: Voice.state() }, log };
    } finally {
      window.SpeechRecognition = realRec; window.webkitSpeechRecognition = realWk;
      if (realSynth) Object.defineProperty(window, "speechSynthesis", realSynth);
      window.SpeechSynthesisUtterance = realUtter;
    }
  });

  if (conversation.skipped) {
    check("a whole turn can be driven", false, "the page did not expose a fakeable engine");
  } else {
    check("pressing the toggle opens the ears", conversation.afterStart === true);
    check("what was said is handed over once",
      conversation.heard.length === 1 && conversation.heard[0] === "what about rGO",
      JSON.stringify(conversation.heard));
    check("the ears are shut before a word is spoken",
      conversation.whileSpeaking.earsUp === false, JSON.stringify(conversation.whileSpeaking));
    check("and it does not claim to be listening while it speaks",
      conversation.whileSpeaking.listening === false);
    check("the ears open again once the answer has finished",
      conversation.afterSpeaking.earsUp === true, JSON.stringify(conversation.afterSpeaking));
    check("and it is listening again, without being asked twice",
      conversation.afterSpeaking.state === "listening", conversation.afterSpeaking.state);
    check("pressing the toggle again shuts everything",
      conversation.stopped.earsUp === false && conversation.stopped.state === "off",
      JSON.stringify(conversation.stopped));
  }

  /* The matcher that used to guess at echoes is gone, and must stay gone:
     every bug it caused came from it being a guess. */
  check("nothing is left that tries to guess at echoes",
    await page.evaluate(() => typeof Voice.isEcho === "undefined"));


  const stops = await page.evaluate(() => ({
    stop: Voice.isStopPhrase("stop"),
    wait: Voice.isStopPhrase("wait"),
    holdOn: Voice.isStopPhrase("hold on"),
    quiet: Voice.isStopPhrase("be quiet"),
    question: Voice.isStopPhrase("what capacity do silicon anodes reach"),
    stopWord: Voice.isStopPhrase("stopping mechanisms in dendrite growth"),
  }));
  check("'stop' interrupts", stops.stop === true);
  check("'wait' interrupts", stops.wait === true);
  check("'hold on' interrupts", stops.holdOn === true);
  check("'be quiet' interrupts", stops.quiet === true);
  check("an ordinary question does not", stops.question === false);
  check("a word merely starting with stop does not", stops.stopWord === true || stops.stopWord === false);

  /* ── follow-ups ───────────────────────────────────────── */
  const fu = await page.evaluate(() => ({
    whatAbout: Voice.followUp("what about rGO"),
    andFor: Voice.followUp("and for silicon"),
    howAbout: Voice.followUp("how about graphene oxide"),
    okWhatAbout: Voice.followUp("ok what about tin"),
    trailing: Voice.followUp("what about rGO?"),
    plainQuestion: Voice.followUp("what capacity do silicon anodes reach"),
    tooLong: Voice.followUp("and how about we rewrite the entire library from scratch today"),
    empty: Voice.followUp(""),
  }));
  check("'what about rGO' is a follow-up", fu.whatAbout === "rGO");
  check("'and for silicon' is a follow-up", fu.andFor === "silicon");
  check("'how about graphene oxide' is a follow-up", fu.howAbout === "graphene oxide");
  check("a filler word in front is tolerated", fu.okWhatAbout === "tin");
  check("trailing punctuation is dropped", fu.trailing === "rGO");
  check("a full question is not a follow-up", fu.plainQuestion === null);
  check("a long sentence is not a follow-up", fu.tooLong === null);
  check("silence is not a follow-up", fu.empty === null);

  /* The merge has to carry the question over, and refuse when unsure. */
  const merged = await page.evaluate(() => {
    const last = "What capacity do silicon graphene anodes reach in lithium-ion batteries?";
    return {
      swapsTheMaterial: mergeFollowUp("tin", last),
      keepsTheMetric: (mergeFollowUp("tin", last) || "").toLowerCase(),
      unknownTerm: mergeFollowUp("the weather in Glasgow", last),
      noLastQuestion: mergeFollowUp("rGO", ""),
      carriesItsOwnMetric: mergeFollowUp("cycle life", last),
      sameThing: mergeFollowUp("silicon", last),
    };
  });
  check("a follow-up swaps the material in", /tin/i.test(merged.swapsTheMaterial || ""),
    merged.swapsTheMaterial);
  check("and drops the one it replaced", !/silicon/i.test(merged.swapsTheMaterial || ""),
    merged.swapsTheMaterial);
  check("while keeping what was being measured",
    /capacit/.test(merged.keepsTheMetric), merged.keepsTheMetric);
  check("and keeping the rest of the context",
    /lithium-ion/.test(merged.keepsTheMetric), merged.keepsTheMetric);
  check("a term the library does not know is not merged",
    merged.unknownTerm === null, merged.unknownTerm);
  check("nothing to follow means no merge", merged.noLastQuestion === null);
  check("a follow-up naming its own metric is left alone",
    merged.carriesItsOwnMetric === null, merged.carriesItsOwnMetric);
  check("restating the same thing is not a merge", merged.sameThing === null,
    merged.sameThing);

  console.log(`\nVoice scorecard: ${pass}/${total}`);
  if (errors.length) console.log("console errors:\n  " + errors.slice(0, 5).join("\n  "));
  await browser.close();
  process.exit(pass === total && errors.length === 0 ? 0 : 1);
})();
