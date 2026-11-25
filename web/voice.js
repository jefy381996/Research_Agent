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
    // "graphing" is a real word, so it is never snapped on its own; but
    // "reduced graphing oxide" is what Whisper wrote for "reduced graphene
    // oxide" in the round-trip test, and in that company it is not graphing.
    [/\bgraphing(?=\s+oxide\b)/gi, "graphene"],
    [/\b(reduced|single[- ]layer|few[- ]layer|multilayer)\s+graphing\b/gi, "$1 graphene"],
    [/\bgraphing(?=\s+(?:anode|cathode|film|sheet|composite|membrane|aerogel))/gi, "graphene"],
    [/\bohms per square\b/gi, "sheet resistance"],
    [/\bwatts per met(?:re|er) kelvin\b/gi, "thermal conductivity"],
    [/\bsquare met(?:re|er)s per gram\b/gi, "surface area"],
    [/\bsilicon? anode\b/gi, "silicon anode"],
  ];

  /* The list above is every mishearing somebody thought of. There is always
     one nobody thought of: the round-trip test, where Kokoro speaks a
     sentence and Whisper writes it down, produced "reduced graphing oxide".
     "graphing" was not on the list, and neither were gapheene, garphene or
     graffine when they were tried.

     So the list is a floor, not the method. Any word close enough to a term
     this library actually uses is snapped to it. Close enough means within
     two edits and sharing a first letter, which keeps "graphene" from
     swallowing unrelated words while catching the ways it gets mangled. This
     is only safe because the subject is fixed: in an application about
     graphene, a word two edits from "graphene" is graphene. */
  /* Kept deliberately short. The first attempt listed every term the library
     uses and turned "graphic design" into "graphite design" and "anodes" into
     "anode", because ordinary English words and plurals sit within two edits
     of short terms. Only words that are distinctive enough that nothing else
     comes near them, and that a recogniser is actually observed to mangle,
     belong here. Anode, cathode, lithium and the rest are left out on
     purpose: they are ordinary enough that recognisers get them right, and
     close enough to other words to be dangerous. */
  const SNAP = [
    "graphene", "graphane", "supercapacitor", "coulombic",
    "exfoliation", "transmittance", "permeance", "nanosheet", "nanotube",
  ];
  /* Real words that sit near a term and must survive untouched. */
  const NEVER = new Set(["graphic", "graphics", "graphical", "graphing",
    "grapheme", "grammar", "granite", "grape", "grapes"]);
  const SNAP_MIN = 5;      // shorter words are too easy to reach by accident
  const SNAP_MAX_EDITS = 2;

  function editsWithin(a, b, cap) {
    if (Math.abs(a.length - b.length) > cap) return false;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      let best = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
        if (row[j] < best) best = row[j];
      }
      if (best > cap) return false;         // no path back under the cap
      prev = row;
    }
    return prev[b.length] <= cap;
  }

  function snap(word) {
    const low = word.toLowerCase();
    if (low.length < SNAP_MIN) return word;
    // A plural or an -ing of a term is the term, correctly inflected, and
    // rewriting it to the stem mangles the sentence: "silicon anodes reach"
    // became "silicon anode reach" before this was here.
    const stem = low.replace(/(?:es|s)$/, "");
    for (const term of SNAP) {
      if (low === term || stem === term) return word;
    }
    for (const term of SNAP) {
      if (low[0] !== term[0]) continue;
      if (editsWithin(low, term, SNAP_MAX_EDITS)) {
        // Only when no real word explains it better.
        return NEVER.has(low) ? word : term;
      }
    }
    return word;
  }

  /* A recogniser trained on ordinary English, pointed at a materials lab. */
  function fixTerms(transcript) {
    let s = String(transcript == null ? "" : transcript).trim();
    HEARD.forEach(([re, word]) => { s = s.replace(re, word); });
    // Then the general case, on whatever the named rules did not catch.
    s = s.replace(/[A-Za-z][A-Za-z'-]*/g, (w) => {
      // Leave anything the named rules already turned into a library term.
      if (/^(rGO|GO|CVD|BET|SEI|LIB|CE)$/.test(w)) return w;
      return snap(w);
    });
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

  const ECHO_SHARE = 0.6;     // this much of it being a run of ours = echo
  const ECHO_TAIL_MS = 800;   // the speakers keep arriving after we stop

  /* Counting shared words is not enough, and getting this wrong is worse than
     having no filter at all. An answer about rGO is being read out, the person
     says "what about rGO", and almost every word they said is a word in the
     sentence - so the follow-up is thrown away as an echo, silently, which is
     exactly the moment a follow-up is most natural.

     What separates them is order, not vocabulary. An echo is a run of what we
     are saying, in sequence. A question reuses the same words in an order we
     are not saying them in. So the test is the longest consecutive run of what
     came back that appears consecutively in what we are speaking. */
  function longestRun(heard, spoken) {
    let best = 0;
    for (let i = 0; i < spoken.length; i++) {
      for (let j = 0; j < heard.length; j++) {
        let k = 0;
        while (i + k < spoken.length && j + k < heard.length
               && spoken[i + k] === heard[j + k]) k += 1;
        if (k > best) best = k;
      }
    }
    return best;
  }

  /* Three words are not many, and in a long answer two of them will line up
     by chance: "and for rGO" collides with "...the median for rGO is...", and
     a ratio alone throws the follow-up away. A short utterance therefore has
     to match in full to count as ours, while a longer one only has to be
     mostly a run - by then chance has stopped being a plausible explanation. */
  const ECHO_MIN_WORDS = 4;

  function isEcho(heard, spoken) {
    const h = words(heard);
    const s = words(spoken);
    // One word is not enough to tell whose it is; the caller drops those
    // while speaking anyway.
    if (h.length < 2 || !s.length) return false;
    const run = longestRun(h, s);
    if (run / h.length < ECHO_SHARE) return false;
    return h.length >= ECHO_MIN_WORDS || run === h.length;
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
    if (local.ears) return localListen(opts);
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
    if (global.LocalSpeech && global.LocalSpeech.isMicOpen()) global.LocalSpeech.closeMic();
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
    if (local.voice && global.LocalSpeech && global.LocalSpeech.ready().voice)
      return localSpeak(text, done);
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
    if (global.LocalSpeech && global.LocalSpeech.isSpeaking()) {
      global.LocalSpeech.stop();
      speaking = false;
      echoUntil = Date.now() + ECHO_TAIL_MS;
    }
    if (!synth) return;
    try { synth.cancel(); } catch (e) {}
    speaking = false;
    echoUntil = Date.now() + ECHO_TAIL_MS;
  }

  /* ── the local engine, when it is loaded ──────────────── */

  /* Whisper and Kokoro are a different shape from the browser's recogniser:
     one hands over a finished utterance rather than a stream of words, and
     the other returns audio rather than speaking by itself. The difference is
     absorbed here, so the rest of the app goes on calling listen and speak
     without knowing which engine answered. Everything either engine produces
     still goes through fixTerms, because a recogniser trained on ordinary
     English mishears a materials lab whoever wrote it - the round-trip test
     has Whisper turning "graphene" into "graphing". */
  let local = { ears: false, voice: false, via: "device" }, localFails = 0;

  function useLocal(which) {
    local = {
      ears: !!(which && which.ears),
      voice: !!(which && which.voice),
      via: (which && which.via) || "device",
    };
    return local;
  }

  function usingLocal() {
    return { ears: local.ears, voice: local.voice, via: local.via };
  }

  function localListen(opts) {
    const LS = global.LocalSpeech;
    if (!LS) return false;
    onPartial = opts.onPartial || null;
    onHeard = opts.onHeard || null;
    onState = opts.onState || onState;
    wantListening = true;
    LS.openMic({
      onSpeech: (ev) => {
        if (ev.type === "start") {
          // Somebody started talking. The browser's echo cancellation means
          // this is them and not us, so the answer stops.
          if (LS.isSpeaking()) LS.stop();
          if (speaking) shutUp();
          announce("hearing");
          return;
        }
        if (ev.type !== "utterance") return;
        announce("thinking");
        const hear = local.via === "service" ? LS.cloudTranscribe : LS.transcribe;
        hear(ev.audio).then((text) => {
          localFails = 0;
          const clean = fixTerms(String(text || "").trim());
          // Whisper fills silence with its own punctuation and stock phrases.
          if (!clean || /^[\s.,!?-]*$/.test(clean) || /^\(.*\)$/.test(clean)) {
            announce("listening");
            return;
          }
          if (onHeard) onHeard(clean);
        }).catch((e) => {
          // Twice in a row is not bad luck. Rather than leave somebody
          // talking to a listener that cannot answer, hand the microphone
          // back to the browser's own engine and say so.
          localFails += 1;
          if (localFails >= 2) {
            localFails = 0;
            const opts2 = { onPartial, onHeard, onState };
            LS.closeMic();
            local = { ears: false, voice: false };
            announce("error", "local-gave-up");
            listen(opts2);
          } else {
            announce("error", String(e && e.message || e));
            announce("listening");
          }
        });
      },
    }).then(() => announce("listening"))
      .catch((e) => {
        wantListening = false;
        const why = /denied|not allowed|NotAllowed/i.test(String(e)) ? "not-allowed" : String(e && e.message || e);
        announce("error", why);
      });
    return true;
  }

  function localSpeak(text, done) {
    const LS = global.LocalSpeech;
    const said = sayable(text);
    if (!LS || !said) { if (done) done(); return false; }
    spokenNow = said;
    const read = local.via === "service" ? LS.cloudSpeak : LS.speak;
    read(said, {
      onStart: () => { speaking = true; announce("speaking"); },
      onEnd: () => {
        speaking = false;
        echoUntil = Date.now() + ECHO_TAIL_MS;
        announce("spoke");
        if (done) done();
      },
    });
    return true;
  }

  global.Voice = {
    supported, listen, stopListening, speak, shutUp,
    useLocal, usingLocal,
    isListening: () => listening,
    isSpeaking: () => speaking,
    wantsToListen: () => wantListening,
    onState: (fn) => { onState = fn; },
    // pure, and therefore the parts worth testing
    sayable, fixTerms, parseCommand, isEcho, isStopPhrase, followUp, snap,
  };
})(window);
