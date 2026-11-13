/* Talking to the library.
 *
 * All of this runs in the browser and costs nothing: the Web Speech API does
 * the listening and the speaking, so there is no key, no quota and no per
 * minute charge. That matters more than it sounds, because the engine it is
 * wired to - Instant - also needs no model. Speak, get an answer in under a
 * second, hear it, and be listened to again, for as long as you like, free.
 *
 * What a paid realtime model would add is interruption mid-sentence. That is
 * approximated here rather than bought: the recogniser keeps running while
 * the answer is being spoken, and the moment you start talking the speech is
 * cut off and your words are taken instead.
 *
 * Two honest limits, surfaced in the interface rather than buried here.
 * Listening does not exist in Firefox at all, and in Chrome the audio is sent
 * to Google's recogniser - it is free, but it is not local, which is worth
 * saying out loud in an app whose other promise is that your own data never
 * leaves the browser. Speaking is local everywhere.
 *
 * The three functions underneath are pure, because they are where the bugs
 * are: a recogniser hears "are gee oh" and the library calls it rGO, and a
 * screen reads "1,842 mAh/g" where a person says "one thousand eight hundred
 * and forty two milliamp hours per gram".
 */
(function (global) {
  "use strict";

  /* ── what the screen writes vs what a person says ─────── */

  /* Units, longest first so "mAh/g" is not eaten by "/g". */
  const UNITS = [
    [/\bmA\s?h\s*\/\s*g\b/gi, "milliamp hours per gram"],
    [/\bmA\s?h\b/gi, "milliamp hours"],
    [/\bW\s*\/\s*mK\b/g, "watts per metre kelvin"],
    [/\bW\s*\/\s*m\s*·?\s*K\b/g, "watts per metre kelvin"],
    [/\bS\s*\/\s*m\b/g, "siemens per metre"],
    [/\bS\s*\/\s*cm\b/g, "siemens per centimetre"],
    [/\bohm\s*\/\s*sq\b/gi, "ohms per square"],
    [/Ω\s*\/\s*sq\b/g, "ohms per square"],
    [/\bcm2\s*\/\s*Vs\b/gi, "square centimetres per volt second"],
    [/\bm2\s*\/\s*g\b/gi, "square metres per gram"],
    [/\bmA\s*\/\s*g\b/gi, "milliamps per gram"],
    [/\bA\s*\/\s*g\b/g, "amps per gram"],
    [/\bF\s*\/\s*g\b/g, "farads per gram"],
    [/\bL\s*\/\s*m2\s*\/\s*h\s*\/\s*bar\b/gi, "litres per square metre per hour per bar"],
    [/\bTPa\b/g, "terapascals"],
    [/\bGPa\b/g, "gigapascals"],
    [/\bMPa\b/g, "megapascals"],
    [/\bdB\b/g, "decibels"],
    [/\bW\s*\/\s*g\b/g, "watts per gram"],
    [/\bWh\s*\/\s*kg\b/gi, "watt hours per kilogram"],
    [/°C\b/g, " degrees celsius"],
  ];

  /* Shorthand a chemist writes and nobody pronounces. */
  const TERMS = [
    [/\brGO\b/g, "reduced graphene oxide"],
    [/\bGO\b/g, "graphene oxide"],
    [/\bCVD\b/g, "chemical vapour deposition"],
    [/\bBET\b/g, "B E T"],
    [/\bLi\s*-\s*S\b/gi, "lithium sulfur"],
    [/\bLIB\b/g, "lithium ion battery"],
    [/\bSEI\b/g, "solid electrolyte interphase"],
    [/\bN\s*-\s*doped\b/gi, "nitrogen doped"],
    [/\bCE\b/g, "coulombic efficiency"],
  ];

  /* Turn written notation into something worth hearing. */
  function sayable(text) {
    let s = String(text == null ? "" : text);
    s = s.replace(/\[[EP]W?\d+\]/g, " ");          // citation markers
    s = s.replace(/```[\s\S]*?```/g, " ");          // code fences
    s = s.replace(/[*_`#>|]/g, " ");                // markdown furniture
    s = s.replace(/&[a-z]+;/gi, " ");               // stray entities
    s = s.replace(/–|—/g, " to ");        // en and em dashes
    TERMS.forEach(([re, word]) => { s = s.replace(re, word); });
    UNITS.forEach(([re, word]) => { s = s.replace(re, " " + word); });
    s = s.replace(/(\d)\s*%/g, "$1 percent");
    // "$1", not "": the first version replaced the digit along with the comma,
    // so 1,842 was spoken as 842. A thousand, silently gone, out loud.
    s = s.replace(/(\d),(?=\d{3}\b)/g, "$1");       // 2,794 -> 2794, read right
    return s.replace(/\s+/g, " ").trim();
  }

  /* ── what a recogniser hears vs what the library calls it ─ */

  const HEARD = [
    [/\b(?:are|r)\s*(?:gee|g)\s*(?:oh|o)\b/gi, "rGO"],
    [/\bargo\b/gi, "rGO"],
    [/\breduced graphene oxide\b/gi, "rGO"],
    [/\bmilli\s*amp?s?\s*(?:hours?|our)?\s*per\s*gram\b/gi, "mAh/g"],
    [/\bmilliamp\s*hours?\b/gi, "mAh"],
    [/\blithium\s*sulphur\b/gi, "lithium-sulfur"],
    [/\blithium\s*sulfur\b/gi, "lithium-sulfur"],
    [/\blithium\s*ion\b/gi, "lithium-ion"],
    [/\bsodium\s*ion\b/gi, "sodium-ion"],
    [/\bsee\s*rate\b/gi, "C-rate"],
    [/\bc\s*rate\b/gi, "C-rate"],
    [/\b(?:see|c)\s*(?:vee|v)\s*(?:dee|d)\b/gi, "CVD"],
    [/\byoungs\b/gi, "Young's"],
    [/\bgraphine\b|\bgraphean\b|\bgrafeen\b/gi, "graphene"],
    [/\bohms per square\b/gi, "sheet resistance"],
    [/\bwatts per met(?:re|er) kelvin\b/gi, "thermal conductivity"],
    [/\bsquare met(?:re|er)s per gram\b/gi, "surface area"],
    [/\bsilicon? anode\b/gi, "silicon anode"],
  ];

  /* A recogniser trained on ordinary English, pointed at a materials lab. */
  function fixTerms(transcript) {
    let s = String(transcript == null ? "" : transcript).trim();
    HEARD.forEach(([re, word]) => { s = s.replace(re, word); });
    return s.replace(/\s+/g, " ").trim();
  }

  /* ── spoken control ───────────────────────────────────── */

  const VIEWS = [
    [/\b(?:measurements?|battery data|battery figures)\b/i, "evidence"],
    [/\b(?:properties|material properties)\b/i, "properties"],
    [/\b(?:knowledge|definitions?|reference)\b/i, "explore"],
    [/\b(?:calculators?|calculations?)\b/i, "calculator"],
    [/\b(?:papers|sources|literature)\b/i, "sources"],
    [/\b(?:my data|my results|my own data)\b/i, "mydata"],
    [/\b(?:notebook|notes|saved)\b/i, "notebook"],
    [/\b(?:ask|home|start)\b/i, "ask"],
  ];

  /* A command is an instruction to the page, not a question for the library.
     Returning null means "this is a question", which is the common case. */
  function parseCommand(text) {
    const s = String(text == null ? "" : text).trim().toLowerCase()
      .replace(/[.?!]+$/, "");
    if (!s) return null;

    if (/^(?:stop|quiet|be quiet|shut up|enough|cancel)$/.test(s))
      return { kind: "silence" };
    if (/^(?:stop listening|exit voice|turn off voice|voice off|goodbye|bye)$/.test(s))
      return { kind: "exit" };
    if (/^(?:repeat|say (?:that )?again|again|what did you say)$/.test(s))
      return { kind: "repeat" };
    if (/\b(?:dark|night) mode\b/.test(s)) return { kind: "theme", arg: "dark" };
    if (/\b(?:light|day) mode\b/.test(s)) return { kind: "theme", arg: "light" };

    // "show me the measurements", "go to properties", "open my data"
    const nav = s.match(/^(?:show|open|go to|take me to|switch to|view)\s+(?:me\s+)?(?:the\s+)?(.+)$/);
    if (nav) {
      for (const [re, view] of VIEWS) {
        if (re.test(nav[1])) return { kind: "view", arg: view };
      }
    }
    return null;
  }

  /* ── the browser's own ears and voice ─────────────────── */

  const Rec = global.SpeechRecognition || global.webkitSpeechRecognition;
  const synth = global.speechSynthesis;

  function supported() {
    return {
      listen: !!Rec,
      speak: !!synth,
      // Firefox has the synthesiser but not the recogniser.
      why: !Rec ? "This browser cannot listen. Chrome, Edge and Safari can."
                : null,
    };
  }

  let rec = null, listening = false, speaking = false;
  let onPartial = null, onHeard = null, onState = null;

  function announce(state, detail) {
    if (onState) onState(state, detail);
  }

  function listen(opts) {
    if (!Rec) { announce("unsupported"); return false; }
    onPartial = opts.onPartial || null;
    onHeard = opts.onHeard || null;
    onState = opts.onState || onState;

    stopListening();
    rec = new Rec();
    rec.lang = opts.lang || "en-GB";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => { listening = true; announce("listening"); };
    rec.onerror = (e) => {
      listening = false;
      announce("error", e && e.error ? String(e.error) : "unknown");
    };
    rec.onend = () => { listening = false; announce("idle"); };

    rec.onresult = (event) => {
      let interim = "", final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const chunk = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += chunk; else interim += chunk;
      }
      // Any speech at all cuts off whatever is being said. This is the
      // barge-in a realtime model gives you, done with the parts to hand.
      if ((interim || final) && speaking) shutUp();
      if (interim && onPartial) onPartial(fixTerms(interim));
      if (final.trim() && onHeard) onHeard(fixTerms(final));
    };

    try { rec.start(); return true; }
    catch (e) { announce("error", String(e.message || e)); return false; }
  }

  function stopListening() {
    if (rec) {
      try { rec.onend = null; rec.stop(); } catch (e) {}
      try { rec.abort(); } catch (e) {}
    }
    rec = null; listening = false;
  }

  function pickVoice() {
    if (!synth) return null;
    const voices = synth.getVoices() || [];
    if (!voices.length) return null;
    const want = ["Google UK English Female", "Daniel", "Samantha",
                  "Google US English", "Microsoft Sonia"];
    for (const name of want) {
      const hit = voices.find((v) => v.name === name);
      if (hit) return hit;
    }
    return voices.find((v) => /^en[-_]GB/i.test(v.lang))
        || voices.find((v) => /^en/i.test(v.lang))
        || voices[0];
  }

  function speak(text, done) {
    if (!synth) { if (done) done(); return false; }
    const words = sayable(text);
    if (!words) { if (done) done(); return false; }
    shutUp();
    const utter = new SpeechSynthesisUtterance(words);
    const voice = pickVoice();
    if (voice) { utter.voice = voice; utter.lang = voice.lang; }
    utter.rate = 1.02;
    utter.pitch = 1;
    utter.onstart = () => { speaking = true; announce("speaking"); };
    utter.onend = () => { speaking = false; announce("spoke"); if (done) done(); };
    utter.onerror = () => { speaking = false; announce("spoke"); if (done) done(); };
    try { synth.speak(utter); return true; }
    catch (e) { speaking = false; if (done) done(); return false; }
  }

  function shutUp() {
    if (!synth) return;
    try { synth.cancel(); } catch (e) {}
    speaking = false;
  }

  global.Voice = {
    supported, listen, stopListening, speak, shutUp,
    isListening: () => listening,
    isSpeaking: () => speaking,
    onState: (fn) => { onState = fn; },
    // pure, and therefore the parts worth testing
    sayable, fixTerms, parseCommand,
  };
})(window);
