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

  /* The controls exist and degrade honestly. */
  const ui = await page.evaluate(() => ({
    mic: !!document.getElementById("mic"),
    handsfree: !!document.getElementById("handsfree"),
    bar: !!document.getElementById("vbar"),
    barHidden: document.getElementById("vbar").hidden,
    canListen: Voice.supported().listen,
    canSpeak: Voice.supported().speak,
  }));
  check("the microphone and hands-free controls are present",
    ui.mic && ui.handsfree && ui.bar, JSON.stringify(ui));
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

  console.log(`\nVoice scorecard: ${pass}/${total}`);
  if (errors.length) console.log("console errors:\n  " + errors.slice(0, 5).join("\n  "));
  await browser.close();
  process.exit(pass === total && errors.length === 0 ? 0 : 1);
})();
