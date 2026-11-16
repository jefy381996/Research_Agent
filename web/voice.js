/* Talking to the library.
 *
 * All of this runs in the browser and costs nothing: the Web Speech API does
 * the listening and the speaking, so there is no key, no quota and no per
 * minute charge. That matters more than it sounds, because the engine it is
 * wired to - Instant - also needs no model. Speak, get an answer in under a
 * second, hear it, and be listened to again, for as long as you like, free.
 *
 * What a paid realtime model sells is a conversation rather than a sequence
 * of dictations. Three things make that difference, and all three are built
 * here out of what the browser already gives away.
 *
 * It keeps listening. The browser ends recognition after about a minute of
 * quiet, and on every network hiccup; it is restarted for as long as you want
 * to be listening, with a backoff so a refused microphone cannot spin.
 *
 * You can interrupt it. The recogniser runs while the answer is being spoken,
 * so the moment you talk the speech is cut off and your words are taken.
 *
 * It does not interrupt itself. That is the hard half. The microphone hears
 * the speakers, so on a laptop the answer used to cut itself off after a few
 * words and then ask itself its own sentence. We know exactly what we are
 * saying, so if most of what came back is words we are in the middle of
 * speaking it is an echo and is dropped - while anything else is a person,
 * who gets to interrupt. "Stop" always gets through.
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

  /* ── telling our own voice from yours ─────────────────── */

  /* The recogniser hears the speakers, not just you. On a laptop without
     headphones the synthesised answer goes straight back into the microphone,
     and the first version treated that as an interruption: the answer cut
     itself off after a few words, and its own sentence came back as the next
     question. A realtime model is sold partly on solving this.

     It is solvable here for nothing, because we know exactly what we are
     saying. If most of what came back is words we are in the middle of
     speaking, it is an echo. If it is not, it is a person, and they get to
     interrupt. */

  function words(text) {
    return String(text == null ? "" : text).toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()
      .split(" ").filter(Boolean);
  }

  const ECHO_SHARE = 0.6;     // this much of what we heard being ours = echo
  const ECHO_TAIL_MS = 800;   // the speakers keep arriving after we stop

  function isEcho(heard, spoken) {
    const h = words(heard).filter((w) => w.length > 2);
    if (!h.length) return false;
    const mine = new Set(words(spoken));
    if (!mine.size) return false;
    const shared = h.filter((w) => mine.has(w)).length;
    return shared / h.length >= ECHO_SHARE;
  }

  /* "Stop" has to work even while we are saying the word "stop". */
  const STOP_PHRASE = /^(?:stop|quiet|be quiet|shut up|enough|cancel|wait|hold on|hang on)\b/i;

  function isStopPhrase(text) {
    return STOP_PHRASE.test(String(text == null ? "" : text).trim());
  }

  /* ── follow-ups ───────────────────────────────────────── */

  /* "And for rGO?" is a question about the previous question. Spoken, it is
     the normal way to ask; typed, nobody bothers. Detected here and merged by
     the caller, which is the side that knows the library's vocabulary. */
  const FOLLOW = /^(?:and|also|ok(?:ay)?|so)?\s*(?:what|how)\s+about\s+(.+)$/i;
  const FOLLOW_BARE = /^(?:and|also)\s+(?:for\s+|with\s+)?(.+)$/i;
  const FOLLOW_FOR = /^(?:what\s+)?(?:for|of)\s+(.+)$/i;

  function followUp(text) {
    const s = String(text == null ? "" : text).trim().replace(/[.?!]+$/, "");
    if (!s) return null;
    for (const re of [FOLLOW, FOLLOW_BARE, FOLLOW_FOR]) {
      const m = s.match(re);
      // A follow-up is short. "And how about we rewrite the whole library"
      // is not one, and should be treated as the question it looks like.
      if (m && m[1] && words(m[1]).length <= 6) return m[1].trim();
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
  let spokenNow = "", echoUntil = 0;

  /* The recogniser does not stay on. Chrome ends it after about a minute of
     quiet, and on any network hiccup, and the first version simply let that
     happen: hands-free died while the bar still read "Listening...". It is
     restarted here for as long as the caller wants to be listening, with a
     backoff so a microphone that cannot start does not spin. */
  let wantListening = false, rapid = 0, restartTimer = null, startedAt = 0;
  const FATAL = new Set(["not-allowed", "service-not-allowed", "audio-capture"]);
  const MAX_RAPID = 6;

  function announce(state, detail) {
    if (onState) onState(state, detail);
  }

  function build(opts) {
    const r = new Rec();
    r.lang = opts.lang || "en-GB";
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onstart = () => {
      listening = true;
      startedAt = Date.now();
      announce("listening");
    };

    r.onerror = (e) => {
      const why = e && e.error ? String(e.error) : "unknown";
      listening = false;
      if (FATAL.has(why)) {
        wantListening = false;
        announce("error", why);
        return;
      }
      // no-speech and network are ordinary. onend follows and restarts.
      if (why !== "no-speech") announce("error", why);
    };

    r.onend = () => {
      listening = false;
      if (!wantListening) { announce("idle"); return; }
      // A session that ran for a while is a normal timeout; one that ended
      // immediately is a failure, and repeated failures need backing off.
      if (Date.now() - startedAt > 5000) rapid = 0; else rapid += 1;
      if (rapid > MAX_RAPID) {
        wantListening = false;
        announce("error", "could-not-restart");
        return;
      }
      const wait = rapid ? Math.min(250 * Math.pow(2, rapid - 1), 8000) : 120;
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        if (!wantListening) return;
        try { r.start(); }
        catch (err) {
          // Already running, or refused. Either way onend will come again.
          if (!/InvalidStateError/.test(String(err))) announce("error", String(err.message || err));
        }
      }, wait);
    };

    r.onresult = (event) => {
      let interim = "", final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const chunk = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += chunk; else interim += chunk;
      }
      const now = (final || interim).trim();

      if (now && (speaking || Date.now() < echoUntil)) {
        if (isStopPhrase(now)) {
          shutUp();                       // and fall through, so it is obeyed
        } else if (isEcho(now, spokenNow) || words(now).length < 2) {
          return;                         // our own voice, or too little to judge
        } else {
          shutUp();                       // a person, interrupting
        }
      }

      if (interim && onPartial) onPartial(fixTerms(interim));
      if (final.trim() && onHeard) onHeard(fixTerms(final));
    };
    return r;
  }

  function listen(opts) {
    opts = opts || {};
    if (!Rec) { announce("unsupported"); return false; }
    onPartial = opts.onPartial || null;
    onHeard = opts.onHeard || null;
    onState = opts.onState || onState;

    // Already listening and only the callbacks changed: keep the session.
    // Tearing a recogniser down and building a new one for every turn adds
    // latency to each answer and is what made the conversation feel stepped.
    if (rec && listening) { wantListening = true; return true; }

    stopListening();
    wantListening = true;
    rapid = 0;
    rec = build(opts);
    try { rec.start(); return true; }
    catch (e) {
      announce("error", String(e.message || e));
      return false;
    }
  }

  function stopListening() {
    wantListening = false;
    clearTimeout(restartTimer);
    restartTimer = null;
    rapid = 0;
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
    const said = sayable(text);
    if (!said) { if (done) done(); return false; }
    shutUp();
    const utter = new SpeechSynthesisUtterance(said);
    const voice = pickVoice();
    if (voice) { utter.voice = voice; utter.lang = voice.lang; }
    utter.rate = 1.02;
    utter.pitch = 1;
    // What we are saying, so the recogniser can recognise it coming back.
    spokenNow = said;
    const settle = () => {
      speaking = false;
      echoUntil = Date.now() + ECHO_TAIL_MS;
      announce("spoke");
      if (done) done();
    };
    utter.onstart = () => { speaking = true; announce("speaking"); };
    utter.onend = settle;
    utter.onerror = settle;
    try { synth.speak(utter); return true; }
    catch (e) { speaking = false; if (done) done(); return false; }
  }

  function shutUp() {
    if (!synth) return;
    try { synth.cancel(); } catch (e) {}
    speaking = false;
    echoUntil = Date.now() + ECHO_TAIL_MS;
  }

  global.Voice = {
    supported, listen, stopListening, speak, shutUp,
    isListening: () => listening,
    isSpeaking: () => speaking,
    wantsToListen: () => wantListening,
    onState: (fn) => { onState = fn; },
    // pure, and therefore the parts worth testing
    sayable, fixTerms, parseCommand, isEcho, isStopPhrase, followUp,
  };
})(window);
