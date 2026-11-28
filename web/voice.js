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

  /* Splitting on words is shared by the follow-up test below. */
  function words(text) {
    return String(text == null ? "" : text).toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()
      .split(" ").filter(Boolean);
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

  /* ── one conversation ─────────────────────────────────────────────────
     There used to be three sets of ears to choose between - the browser's,
     a hosted service, and a 39MB model downloaded into the page - and the
     echo was handled by comparing what came back against what we were in
     the middle of saying. That comparison is why it heard itself: a
     recogniser that mishears half a sentence produces words that match
     nothing, so the echo got through and the app answered its own question.

     There is now one path and one rule. While the answer is being spoken
     the recogniser is not running at all, so an echo is not something that
     has to be detected - it cannot be produced. Interrupting still works,
     because the microphone is watched for loudness rather than for words:
     the browser's echo canceller takes out most of what the speakers are
     doing, the rest is measured while we speak and treated as the floor,
     and anything well above that floor for a quarter of a second is a
     person. If that watcher cannot be set up, interrupting is lost and
     nothing else is - which is the right way round. */

  /* Looked up when they are used rather than when this file loads. A module
     that grabs the recogniser at load time cannot be driven by a test, and a
     conversation that cannot be driven by a test is one whose echo behaviour
     nobody can check without a microphone and a room. */
  const recCtor = () => global.SpeechRecognition || global.webkitSpeechRecognition;
  const getSynth = () => global.speechSynthesis;

  function supported() {
    // Hosted ears record and send, which every current browser can do - so
    // where a key is configured, Firefox can hold a conversation too.
    const viaHosted = !!(hosted && hosted.listen && canRecord()
      && global.navigator && navigator.mediaDevices);
    const listen = !!recCtor() || viaHosted;
    return {
      listen: listen,
      speak: !!getSynth() || !!(hosted && hosted.speak),
      via: viaHosted ? "hosted" : listen ? "browser" : "none",
      why: listen ? ""
        : "This browser cannot listen. Chrome, Edge and Safari can; "
          + "Firefox cannot unless the hosted speech service is switched on. "
          + "You can still type.",
    };
  }

  /* state is one of: off, listening, thinking, speaking */
  let state = "off";
  let want = false;              // the toggle: does the person want a conversation
  let rec = null;
  let onState = null, onPartial = null, onHeard = null;
  let utter = null, audioOut = null;
  let hosted = null;             // {listen, speak}, or null for neither
  let askedServer = false;       // null above means "neither", not "not asked"

  let restarts = 0, restartTimer = 0;

  const MAX_RAPID = 6;           // a recogniser that will not stay up
  const FATAL = new Set(["not-allowed", "service-not-allowed", "audio-capture"]);

  function announce(s, detail) {
    if (onState) { try { onState(s, detail); } catch (e) { /* the page's problem */ } }
  }

  /* Between hearing a sentence and speaking an answer the ears are shut, on
     purpose. If the answer never arrives - a failed request, a thrown error
     anywhere in the page - that shut state is permanent, and the
     conversation is deaf until somebody presses the button twice and works
     out why. So waiting has a time limit, after which it goes back to
     listening. Nothing else in the page can be relied on to do this,
     because the whole point is that something in the page went wrong. */
  const THINKING_LIMIT_MS = 12000;
  let thinkingTimer = 0;

  function setState(s, detail) {
    clearTimeout(thinkingTimer);
    if (s === "thinking") {
      thinkingTimer = setTimeout(() => {
        if (state !== "thinking" || !want) return;
        announce("error", "no-answer-came");
        if (beginListening()) setState("listening");
      }, THINKING_LIMIT_MS);
    }
    if (state === s && !detail) return;
    state = s;
    announce(s, detail);
  }

  /* ── listening ──────────────────────────────────────────────────────── */

  /* Two sets of ears, and the better one is used when it is there.

     The browser's recogniser is free and streams, and it writes "graphing"
     for graphene and "are gee oh" for rGO. The hosted one is told the
     vocabulary in advance and gets those right, at about four pence an hour
     of talking. Nobody is asked to choose: if the server has a key the
     hosted ears are used, and if anything about them fails the browser's
     own take over mid-conversation rather than the conversation ending. */
  function beginListening() {
    if (!want) return false;
    if (hosted && hosted.listen && canRecord()) return beginHostedListening();
    return beginBrowserListening();
  }

  function endListening() {
    if (recorder || utterTimer) endHostedListening();
    endBrowserListening();
  }

  /* ---- the hosted ears: record, notice the end of a sentence, send ----
     There is no streaming here, so something has to decide when a sentence
     has finished. That is the same loudness meter the interruption watcher
     uses: the room is measured first, speech is anything well above it, and
     the recording goes off once the speech has stopped for most of a
     second. Nothing is sent unless somebody actually spoke, so sitting
     there in silence costs nothing. */

  const CAL_MS = 500;          // long enough to measure the room
  const START_MARGIN = 2.6;    // this far above the room is a voice
  const START_MIN = 0.015;     // and never trigger in a silent room
  const START_SUSTAIN = 140;   // held this long, so a cough is not a sentence
  const END_SILENCE_MS = 900;  // quiet this long means the sentence is over
  const MAX_UTTER_MS = 15000;  // a hard stop, so nothing records for ever

  let recorder = null, chunks = [], utterTimer = 0;
  let roomFloor = 0, roomUntil = 0, speechFrom = 0, quietFrom = 0;

  const canRecord = () => typeof global.MediaRecorder === "function";

  function recorderType() {
    for (const t of ["audio/webm;codecs=opus", "audio/webm",
                     "audio/ogg;codecs=opus", "audio/mp4"]) {
      try { if (global.MediaRecorder.isTypeSupported(t)) return t; } catch (e) {}
    }
    return "";
  }

  /* Anything that goes wrong with the hosted ears costs the hosted ears and
     nothing else: the browser's own take over and the conversation carries
     on, which is the only acceptable way for a paid service to fail. */
  function fallBackToBrowserEars(why) {
    hosted = { listen: false, speak: !!(hosted && hosted.speak) };
    if (why) announce("error", why);
    if (want && beginBrowserListening()) setState("listening");
  }

  function beginHostedListening() {
    if (recorder) return true;
    openMic().then((ok) => {
      if (!want || recorder) return;
      if (!ok) { fallBackToBrowserEars(); return; }
      let r;
      try {
        const type = recorderType();
        r = type ? new global.MediaRecorder(micStream, { mimeType: type })
                 : new global.MediaRecorder(micStream);
      } catch (e) { fallBackToBrowserEars(); return; }

      chunks = [];
      r.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
      r.onstop = () => {
        const parts = chunks; chunks = [];
        const spoke = speechFrom > 0;
        recorder = null;
        if (!want) return;
        if (!spoke || !parts.length) { if (beginListening()) setState("listening"); return; }
        setState("thinking");
        send(new Blob(parts, { type: parts[0].type || "audio/webm" }));
      };
      recorder = r;
      roomFloor = 0; roomUntil = Date.now() + CAL_MS;
      speechFrom = 0; quietFrom = 0;
      try { r.start(); } catch (e) { recorder = null; fallBackToBrowserEars(); return; }
      listenForTheEnd();
    });
    return true;
  }

  function listenForTheEnd() {
    clearInterval(utterTimer);
    utterTimer = setInterval(() => {
      if (!recorder || state === "speaking" || state === "thinking") return;
      const now = Date.now();
      const rms = level();
      if (now < roomUntil) { if (rms > roomFloor) roomFloor = rms; return; }
      if (rms > Math.max(roomFloor * START_MARGIN, START_MIN)) {
        quietFrom = 0;
        if (!speechFrom) speechFrom = now;
        else if (now - speechFrom > MAX_UTTER_MS) finishUtterance();
        return;
      }
      if (!speechFrom) return;                     // nobody has spoken yet
      if (now - speechFrom < START_SUSTAIN) { speechFrom = 0; return; }   // a noise
      if (!quietFrom) { quietFrom = now; return; }
      if (now - quietFrom >= END_SILENCE_MS) finishUtterance();
    }, TICK_MS);
  }

  function finishUtterance() {
    clearInterval(utterTimer); utterTimer = 0;
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch (e) { recorder = null; }
    }
  }

  function endHostedListening() {
    clearInterval(utterTimer); utterTimer = 0;
    speechFrom = 0; quietFrom = 0;
    const r = recorder; recorder = null;
    if (!r) return;
    r.onstop = null; r.ondataavailable = null;
    try { if (r.state !== "inactive") r.stop(); } catch (e) {}
  }

  function send(blob) {
    const form = new FormData();
    form.append("file", blob, "speech.webm");
    fetch("/api/voice/transcribe", { method: "POST", body: form })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("transcribe " + r.status))))
      .then((j) => {
        const text = ((j && j.text) || "").trim();
        if (!want) return;
        if (!text) { if (beginListening()) setState("listening"); return; }
        restarts = 0;
        if (onHeard) onHeard(text);
      })
      .catch(() => fallBackToBrowserEars("hosted-ears-unavailable"));
  }

  /* ---- the browser's own ears --------------------------------------- */

  function beginBrowserListening() {
    const Rec = recCtor();
    if (!want || !Rec) return false;
    if (rec) return true;                       // already up
    let r;
    try { r = new Rec(); } catch (e) { announce("error", "could-not-start"); return false; }
    r.continuous = true;
    r.interimResults = true;
    r.lang = (global.navigator && navigator.language) || "en-GB";
    r.maxAlternatives = 1;

    r.onresult = (ev) => {
      let finalText = "", interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      if (interim && state === "listening") {
        setState("hearing");
        if (onPartial) onPartial(interim.trim());
      }
      const text = finalText.trim();
      if (!text) return;
      restarts = 0;
      // The ears close before anything is said back, and they stay closed
      // until the speaking has finished. This is the whole echo fix.
      endListening();
      setState("thinking");
      if (onHeard) onHeard(text);
    };

    r.onerror = (ev) => {
      const why = (ev && ev.error) || "unknown";
      if (FATAL.has(why)) {
        want = false;
        endListening();
        setState("off", why);
        announce("error", why);
        return;
      }
      if (why !== "no-speech" && why !== "aborted") announce("error", why);
    };

    r.onend = () => {
      rec = null;
      // The browser ends recognition on its own after about a minute of
      // quiet, and on any network hiccup. If a conversation is still wanted
      // and we are not mid-answer, put it back up.
      if (!want || state === "thinking" || state === "speaking") return;
      restarts += 1;
      if (restarts > MAX_RAPID) {
        want = false;
        setState("off");
        announce("error", "could-not-restart");
        return;
      }
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        if (want && !rec && state !== "speaking" && state !== "thinking") {
          if (beginListening()) setState("listening");
        }
      }, Math.min(1200, 120 * restarts));
    };

    try { r.start(); } catch (e) {
      // Chrome throws if start() lands while the previous one is still
      // winding down. onend will come along and retry.
      return false;
    }
    rec = r;
    return true;
  }

  function endBrowserListening() {
    clearTimeout(restartTimer);
    const r = rec;
    rec = null;
    if (!r) return;
    r.onresult = r.onerror = r.onend = null;
    try { r.abort(); } catch (e) { try { r.stop(); } catch (e2) { /* gone */ } }
  }

  /* ── the watcher that lets a person interrupt ───────────────────────── */

  const CALIBRATE_MS = 700;   // our own leakage, measured while we speak
  const MARGIN = 2.4;         // how far above that floor counts as a person
  const ABS_MIN = 0.014;      // and never trigger on a quiet room
  const SUSTAIN_MS = 260;     // held this long, so a door closing is not speech
  const TICK_MS = 50;

  let micStream = null, actx = null, analyser = null, buf = null;
  let watchTimer = 0, floor = 0, floorUntil = 0, loudSince = 0;
  let bargeIn = false;        // only true once it has actually been set up

  function openMic() {
    if (micStream) return Promise.resolve(true);
    const md = global.navigator && navigator.mediaDevices;
    if (!md || !md.getUserMedia) return Promise.resolve(false);
    return md.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    }).then((s) => {
      micStream = s;
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return false;
      actx = new AC();
      analyser = actx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.5;
      actx.createMediaStreamSource(s).connect(analyser);
      buf = new Uint8Array(analyser.fftSize);
      bargeIn = true;
      return true;
    }).catch(() => false);
  }

  function level() {
    if (!analyser || !buf) return 0;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length);
  }

  function startWatching() {
    if (!bargeIn) return;
    if (actx && actx.state === "suspended") actx.resume().catch(() => {});
    floor = 0;
    floorUntil = Date.now() + CALIBRATE_MS;
    loudSince = 0;
    clearInterval(watchTimer);
    watchTimer = setInterval(() => {
      if (state !== "speaking") return;
      const now = Date.now();
      const rms = level();
      if (now < floorUntil) { if (rms > floor) floor = rms; return; }
      const over = rms > Math.max(floor * MARGIN, ABS_MIN);
      if (!over) { loudSince = 0; return; }
      if (!loudSince) { loudSince = now; return; }
      if (now - loudSince >= SUSTAIN_MS) {
        loudSince = 0;
        // Somebody is talking over the answer. Stop talking and listen.
        shutUp();
        if (want && beginListening()) setState("listening", "interrupted");
      }
    }, TICK_MS);
  }

  function stopWatching() {
    clearInterval(watchTimer);
    watchTimer = 0;
    loudSince = 0;
  }

  function closeMic() {
    stopWatching();
    bargeIn = false;
    if (micStream) {
      for (const t of micStream.getTracks()) { try { t.stop(); } catch (e) {} }
      micStream = null;
    }
    if (actx) { try { actx.close(); } catch (e) {} actx = null; }
    analyser = null; buf = null;
  }

  /* ── speaking ───────────────────────────────────────────────────────── */

  function finishedSpeaking(done) {
    stopWatching();
    utter = null; audioOut = null;
    if (want) {
      if (beginListening()) setState("listening");
      else setState("listening");
    } else {
      setState("off");
    }
    if (done) { try { done(); } catch (e) {} }
  }

  function speakWithSynth(said, done) {
    const synth = getSynth();
    if (!synth) { finishedSpeaking(done); return; }
    try { synth.cancel(); } catch (e) {}
    const u = new SpeechSynthesisUtterance(said);
    u.rate = 1.02;
    u.lang = (global.navigator && navigator.language) || "en-GB";
    u.onstart = () => { setState("speaking"); startWatching(); };
    u.onend = () => { if (utter === u) finishedSpeaking(done); };
    u.onerror = () => { if (utter === u) finishedSpeaking(done); };
    utter = u;
    // Some builds drop an utterance queued in the same tick as a cancel.
    setTimeout(() => { try { synth.speak(u); } catch (e) { finishedSpeaking(done); } }, 0);
  }

  function speakHosted(said, done) {
    const a = new Audio();
    audioOut = a;
    a.preload = "auto";
    a.onplaying = () => { setState("speaking"); startWatching(); };
    a.onended = () => { if (audioOut === a) finishedSpeaking(done); };
    a.onerror = () => {
      if (audioOut !== a) return;
      // The server could not read it; the browser still can.
      audioOut = null;
      speakWithSynth(said, done);
    };
    fetch("/api/voice/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: said }),
    }).then((r) => {
      if (!r.ok) throw new Error("speak " + r.status);
      return r.blob();
    }).then((b) => {
      if (audioOut !== a) return;
      a.src = URL.createObjectURL(b);
      return a.play();
    }).catch(() => {
      if (audioOut !== a) return;
      audioOut = null;
      speakWithSynth(said, done);
    });
  }

  function speak(text, done) {
    const said = sayable(text);
    if (!said) { finishedSpeaking(done); return false; }
    endListening();                  // belt and braces: never speak with ears open
    setState("speaking");
    const useHosted = !!(hosted && hosted.speak);
    // The microphone is opened before the first word so interrupting works
    // from the first answer, not the second.
    openMic().then(() => {
      if (useHosted) speakHosted(said, done);
      else speakWithSynth(said, done);
    });
    return true;
  }

  function shutUp() {
    stopWatching();
    const synth = getSynth();
    if (synth) { try { synth.cancel(); } catch (e) {} }
    if (audioOut) {
      const a = audioOut; audioOut = null;
      try { a.pause(); a.src = ""; } catch (e) {}
    }
    utter = null;
  }

  /* ── the toggle ─────────────────────────────────────────────────────── */

  function listen(opts) {
    opts = opts || {};
    onPartial = opts.onPartial || null;
    onHeard = opts.onHeard || null;
    onState = opts.onState || null;
    want = true;
    restarts = 0;
    // Ask for the microphone up front, so the permission prompt happens on
    // the tap that asked for it rather than halfway through an answer.
    openMic();
    setState("listening");

    // Which ears to use depends on an answer from the server. If it has not
    // arrived yet, wait for it rather than starting on the worse ones and
    // switching a second later.
    const ready = askedServer ? Promise.resolve(true) : useHostedVoiceIfAvailable();
    ready.then(() => {
      if (!want) return;
      if (!supported().listen) { want = false; setState("off"); announce("error", "unsupported"); return; }
      beginListening();
    });
    return true;
  }

  function stopListening() {
    want = false;
    clearTimeout(thinkingTimer);
    endListening();
    shutUp();
    closeMic();
    setState("off");
  }

  /* Asked once, at start-up: can the server read an answer aloud? If it
     cannot, or there is no server, the browser's own voice is used and
     nobody is offered a choice they do not have. */
  function useHostedVoiceIfAvailable() {
    if (!global.fetch) { askedServer = true; return Promise.resolve(false); }
    return fetch("/api/voice/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        hosted = j && (j.listen || j.speak)
          ? { listen: !!j.listen, speak: !!j.speak } : null;
        askedServer = true;
        return !!hosted;
      })
      .catch(() => { askedServer = true; return false; });
  }

  global.Voice = {
    supported, listen, stopListening, speak, shutUp,
    useHostedVoiceIfAvailable,
    isListening: () => state === "listening" || state === "hearing",
    isSpeaking: () => state === "speaking",
    wantsToListen: () => want,
    canInterrupt: () => bargeIn,
    state: () => state,
    onState: (fn) => { onState = fn; },
    // pure, and therefore the parts worth testing
    sayable, fixTerms, parseCommand, isStopPhrase, followUp, snap,
  };
})(window);
