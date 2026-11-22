/* Speech that runs on the visitor's own machine.
 *
 * The browser's built-in recogniser is free but sends your audio to Google,
 * does not exist in Firefox, and speaks in the flat voice everyone recognises
 * as a computer. This module is the alternative: Whisper for the ears, Kokoro
 * for the voice, both downloaded once and run inside the tab. Nothing is sent
 * anywhere after the download, and there is no key and no per-minute charge.
 *
 * What it costs is a download of roughly 120 to 160 MB and a machine fast
 * enough to run it, which is why most of this file is about deciding whether
 * to use it at all rather than about using it.
 *
 * Measured here, in a container with no GPU: Whisper transcribes a five
 * second utterance in about 2.5 seconds, which is usable. Kokoro takes about
 * sixteen seconds to speak five seconds of audio - three times slower than
 * real time, which is not. The two halves are therefore offered separately:
 * the ears can run on a processor, the voice needs a real graphics card, and
 * a machine that has one but not the other gets Whisper's ears with the
 * browser's own voice. That is still an upgrade, because it is more accurate,
 * it keeps the audio on the machine, and it works in Firefox.
 *
 * Nothing downloads until somebody asks for it. A research organisation
 * opening this page on a conference laptop should not spend a hundred and
 * sixty megabytes of their connection to find out what the page is.
 */
(function (global) {
  "use strict";

  const LIB = {
    transformers: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5",
    kokoro: "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm",
  };

  /* Sizes are the real download, measured from the files themselves, because
     the figure goes in front of the person deciding whether to wait for it. */
  const MODELS = {
    earsSmall: { id: "onnx-community/whisper-tiny.en", dtype: "q8", mb: 39 },
    earsLarge: { id: "onnx-community/whisper-base", dtype: "q8", mb: 73 },
    // q8, not fp32. The first version advertised 83 MB and then asked for
    // fp32, which is 310 MB: four times what the button promised, on a
    // connection somebody had agreed to spend 83 MB of.
    voice: { id: "onnx-community/Kokoro-82M-v1.0-ONNX", dtype: "q8", mb: 88 },
  };

  const VOICE_NAME = "af_heart";
  const SAMPLE_RATE = 16000;        // what Whisper expects

  /* ── is this machine up to it ─────────────────────────── */

  /* A software adapter answers requestAdapter and then runs the model on the
     processor anyway, slower than not asking. SwiftShader is the common one,
     and it reports itself, so it can be told apart from a real card. */
  function softwareAdapter(info) {
    const s = ((info && (info.architecture || "")) + " " +
               (info && (info.description || "")) + " " +
               (info && (info.vendor || ""))).toLowerCase();
    return /swiftshader|lavapipe|llvmpipe|software|microsoft basic/.test(s);
  }

  async function inspect() {
    const out = {
      gpu: false, gpuSoftware: false, gpuName: "",
      cores: global.navigator.hardwareConcurrency || 0,
      memory: global.navigator.deviceMemory || null,
      saveData: false, slowNetwork: false, cached: false,
      secure: global.isSecureContext !== false,
    };
    const c = global.navigator.connection;
    if (c) {
      out.saveData = !!c.saveData;
      out.slowNetwork = /^(slow-)?2g$/.test(c.effectiveType || "");
    }
    try {
      if (global.navigator.gpu) {
        const adapter = await global.navigator.gpu.requestAdapter();
        if (adapter) {
          const info = adapter.info || {};
          out.gpuSoftware = softwareAdapter(info);
          out.gpu = !out.gpuSoftware;
          out.gpuName = info.architecture || info.vendor || "";
        }
      }
    } catch (e) { /* no WebGPU: the answer is simply no */ }
    out.cached = await alreadyDownloaded();
    return out;
  }

  /* The browser keeps the model files in the Cache API. If they are already
     there the download warning is a lie, so look before showing it. */
  async function alreadyDownloaded() {
    try {
      if (!global.caches) return false;
      const names = await global.caches.keys();
      for (const name of names) {
        if (!/transformers|onnx/i.test(name)) continue;
        const cache = await global.caches.open(name);
        const keys = await cache.keys();
        if (keys.some((r) => /whisper|kokoro/i.test(r.url))) return true;
      }
    } catch (e) { /* treat as not cached */ }
    return false;
  }

  /* What this machine should actually be offered. The two halves are decided
     separately, because they do not cost the same to run. */
  function plan(cap) {
    const p = { ears: null, voice: null, mb: 0, why: "", cached: !!cap.cached };

    if (!cap.secure) {
      p.why = "This needs a secure connection to use the microphone.";
      return p;
    }
    if (cap.saveData) {
      p.why = "Data saver is on, so nothing has been downloaded.";
      return p;
    }
    if (cap.slowNetwork) {
      p.why = "The connection is too slow for a download this size.";
      return p;
    }
    // Four cores is about where Whisper stops keeping up with a conversation.
    if (cap.cores && cap.cores < 4) {
      p.why = "This device has too few processor cores to run it well.";
      return p;
    }
    if (cap.memory !== null && cap.memory < 4) {
      p.why = "This device has too little memory to hold the models.";
      return p;
    }

    p.ears = cap.gpu ? "earsLarge" : "earsSmall";
    p.mb += MODELS[p.ears].mb;

    /* The voice is the expensive half. Measured without a graphics card it
       takes three seconds to speak one, which is slower than reading the
       answer yourself, so it is only offered where there is a real card. */
    if (cap.gpu) {
      p.voice = "voice";
      p.mb += MODELS.voice.mb;
      p.why = "Both the ears and the voice will run on this machine.";
    } else {
      p.why = cap.gpuSoftware
        ? "No real graphics card here, so the better voice would be slower "
          + "than reading the answer. The listening half still runs locally."
        : "This browser has no graphics acceleration, so the better voice "
          + "would be too slow. The listening half still runs locally.";
    }
    return p;
  }

  /* ── loading ──────────────────────────────────────────── */

  let mods = null, asr = null, tts = null, loadedPlan = null, voiceRejected = "";

  const VOICE_MAX_FACTOR = 1.0;   // slower than speech itself is no use
  const ASR_TIMEOUT_MS = 25000;
  const VOICE_PROBE_MS = 12000;

  async function timed(fn) {
    const t = Date.now();
    const value = await fn();
    return { value, ms: Date.now() - t };
  }

  function withTimeout(promise, ms, what) {
    let t;
    return Promise.race([
      promise.finally(() => clearTimeout(t)),
      new Promise((_, rej) => { t = setTimeout(() => rej(new Error(what)), ms); }),
    ]);
  }

  async function libs() {
    if (mods) return mods;
    const [T, K] = await Promise.all([
      import(/* webpackIgnore: true */ LIB.transformers),
      import(/* webpackIgnore: true */ LIB.kokoro),
    ]);
    mods = { T, K };
    return mods;
  }

  /* onProgress is called with a number from 0 to 1 and a short label. The
     caller shows it; a download this size without a bar reads as a hang. */
  async function load(p, onProgress) {
    const say = (frac, label) => { if (onProgress) onProgress(Math.max(0, Math.min(1, frac)), label); };
    say(0, "fetching the speech engine");
    const { T, K } = await libs();

    const files = {};
    const track = (half) => (ev) => {
      if (!ev || ev.status !== "progress" || !ev.file) return;
      files[half + ":" + ev.file] = (ev.progress || 0) / 100;
      const vals = Object.values(files);
      const mean = vals.reduce((a, b) => a + b, 0) / Math.max(vals.length, 1);
      say(mean, half === "ears" ? "downloading the listener" : "downloading the voice");
    };

    if (p.ears && !asr) {
      const m = MODELS[p.ears];
      // Always on the processor. It was put on the graphics card wherever one
      // existed, which is faster when it works, but a quantised model on the
      // WebGPU backend is barely supported and hangs without erroring: the
      // page sat on "working out what you said" for ever. On the processor it
      // takes about two and a half seconds and it always comes back, and this
      // is the path that can actually be tested.
      asr = await T.pipeline("automatic-speech-recognition", m.id, {
        dtype: m.dtype, device: "wasm", progress_callback: track("ears"),
      });
    }
    if (p.voice && !tts) {
      try {
        tts = await K.KokoroTTS.from_pretrained(MODELS.voice.id, {
          dtype: MODELS.voice.dtype, device: "webgpu",
          progress_callback: track("voice"),
        });
        // Asking the adapter what it is cannot tell you how fast it is, and
        // the only machine this was written on has no real card to measure.
        // So measure the machine in front of us: speak one short line and
        // time it. Slower than real time means every answer arrives after it
        // would have been quicker to read, and the browser's own voice - flat
        // but instant - is the better of the two.
        say(0.97, "checking the voice is fast enough");
        // With its own timeout, because the check for a voice that is too
        // slow must not itself be able to hang. On a software adapter this
        // generate never returns.
        const probe = await timed(() => withTimeout(
          tts.generate("Ready.", { voice: VOICE_NAME }),
          VOICE_PROBE_MS, "the voice was too slow to answer at all"));
        const factor = probe.ms / 1000 / (probe.value.audio.length / probe.value.sampling_rate);
        if (factor > VOICE_MAX_FACTOR) {
          tts = null;
          voiceRejected = `it ran at ${factor.toFixed(1)} times slower than speech`;
        }
      } catch (e) {
        tts = null;
        voiceRejected = /too slow/.test(String(e && e.message || e))
          ? "it was too slow to answer at all"
          : "it would not start on this graphics card";
      }
    }
    loadedPlan = p;
    say(1, "ready");
    return { ears: !!asr, voice: !!tts, voiceRejected };
  }

  function ready() { return { ears: !!asr, voice: !!tts, voiceRejected }; }

  /* ── the microphone, and knowing when somebody is talking ─ */

  /* Whisper does not stream: it is handed a finished utterance. Something has
     to decide where an utterance ends, and the same thing tells us somebody
     has started talking over the answer, which is what makes interrupting
     work. Loudness is enough for that, as long as the threshold is measured
     in the room rather than guessed: a quiet office and a conference hall are
     twenty decibels apart, and a fixed number is wrong in both. */
  const WORKLET = `
    class Tap extends AudioWorkletProcessor {
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch && ch.length) this.port.postMessage(ch.slice(0));
        return true;
      }
    }
    registerProcessor('tap', Tap);
  `;

  let audioCtx = null, stream = null, node = null, src = null;
  let onSpeech = null, onLevel = null;
  let floor = 0.004, calibrating = 0, frames = 0;
  let speaking = false, buffer = [], quiet = 0, lead = [];
  let micOpen = false;

  const SPEECH_OVER = 1.9;     // loudness this many times the room = talking
  const HANG_MS = 700;         // quiet for this long = the utterance ended
  const MIN_MS = 350;          // shorter than this is a cough, not a question
  const MAX_MS = 15000;        // stop runaway recordings
  const LEAD_MS = 250;         // keep this much from before the speech started

  function rms(a) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * a[i];
    return Math.sqrt(s / a.length);
  }

  async function openMic(opts) {
    if (micOpen) return true;
    opts = opts || {};
    onSpeech = opts.onSpeech || null;
    onLevel = opts.onLevel || null;

    // The browser's own echo cancellation is what stops the microphone
    // hearing the answer through the speakers. Doing it here, in the audio
    // path, is better than guessing from the words afterwards.
    stream = await global.navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    audioCtx = new (global.AudioContext || global.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    if (audioCtx.state === "suspended") await audioCtx.resume();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await audioCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    src = audioCtx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(audioCtx, "tap");
    node.port.onmessage = (e) => frame(e.data);
    src.connect(node);
    // Not connected to the destination: nothing is played back.
    floor = 0.004; calibrating = 0; frames = 0;
    speaking = false; buffer = []; lead = []; quiet = 0;
    micOpen = true;
    return true;
  }

  function closeMic() {
    try { if (node) node.port.onmessage = null; } catch (e) {}
    try { if (src) src.disconnect(); } catch (e) {}
    try { if (node) node.disconnect(); } catch (e) {}
    try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { if (audioCtx) audioCtx.close(); } catch (e) {}
    audioCtx = stream = node = src = null;
    micOpen = false; speaking = false; buffer = []; lead = [];
  }

  const msOf = (chunks) => chunks.reduce((n, c) => n + c.length, 0) / SAMPLE_RATE * 1000;

  function frame(chunk) {
    const level = rms(chunk);
    frames += 1;
    if (onLevel) onLevel(level, floor);

    // The first half second is the room, not a person.
    if (calibrating < 60) {
      calibrating += 1;
      floor = calibrating === 1 ? level : floor * 0.9 + level * 0.1;
      return;
    }
    // Keep following the room while nobody is talking, so a fan starting up
    // does not read as speech for the rest of the session.
    if (!speaking) floor = floor * 0.995 + level * 0.005;
    const loud = level > Math.max(floor * SPEECH_OVER, 0.0035);

    if (!speaking) {
      lead.push(chunk);
      while (msOf(lead) > LEAD_MS) lead.shift();
      if (loud) {
        speaking = true;
        buffer = lead.slice();
        lead = [];
        quiet = 0;
        if (onSpeech) onSpeech({ type: "start" });
      }
      return;
    }

    buffer.push(chunk);
    quiet = loud ? 0 : quiet + (chunk.length / SAMPLE_RATE * 1000);
    if (quiet >= HANG_MS || msOf(buffer) >= MAX_MS) {
      const ms = msOf(buffer) - quiet;
      const audio = join(buffer);
      speaking = false; buffer = []; quiet = 0;
      if (ms >= MIN_MS && onSpeech) onSpeech({ type: "utterance", audio, ms });
      else if (onSpeech) onSpeech({ type: "discarded", ms });
    }
  }

  function join(chunks) {
    let n = 0;
    for (const c of chunks) n += c.length;
    const out = new Float32Array(n);
    let i = 0;
    for (const c of chunks) { out.set(c, i); i += c.length; }
    return out;
  }

  /* ── the same microphone, answered by the service ─────── */

  /* A third option, and on most machines the best one: the microphone, the
     loudness test and the endpointing are all exactly as they are for the
     on-device engine, but the finished utterance is posted to this app's own
     server, which holds the credential and asks a hosted recogniser.
     Nothing is downloaded, it runs on any machine, and the larger model is
     more accurate - it writes "graphene" where the small local one writes
     "graphing". The server never hands the page a key, which is the whole
     reason the request goes through it.

     What it gives up: the audio leaves the machine. That is a real trade and
     it is stated in the interface rather than buried here. */
  function toWav(audio, rate) {
    const n = audio.length, buf = new ArrayBuffer(44 + n * 2);
    const dv = new DataView(buf);
    const str = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
    str(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); str(8, "WAVEfmt ");
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, "data"); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, audio[i]));
      dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  async function service() {
    try {
      const r = await fetch("api/voice/status", { cache: "no-store" });
      if (!r.ok) return { listen: false, speak: false };
      return await r.json();
    } catch (e) { return { listen: false, speak: false }; }
  }

  async function cloudTranscribe(audio) {
    const form = new FormData();
    form.append("file", toWav(audio, SAMPLE_RATE), "speech.wav");
    const r = await withTimeout(
      fetch("api/voice/transcribe", { method: "POST", body: form }),
      ASR_TIMEOUT_MS, "the service did not answer in time");
    if (!r.ok) throw new Error(`the service refused (${r.status})`);
    const out = await r.json();
    return ((out && out.text) || "").trim();
  }

  async function cloudSpeak(text, hooks) {
    hooks = hooks || {};
    cancelled = false;
    if (hooks.onStart) hooks.onStart();
    try {
      const r = await fetch("api/voice/speak", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: String(text).slice(0, 4000) }),
      });
      if (!r.ok) throw new Error(String(r.status));
      const blob = await r.blob();
      if (cancelled) return false;
      const url = URL.createObjectURL(blob);
      const el = new Audio(url);
      playing = { el };
      await new Promise((resolve) => {
        el.onended = resolve; el.onerror = resolve;
        el.play().catch(resolve);
      });
      URL.revokeObjectURL(url);
      return !cancelled;
    } catch (e) {
      return false;
    } finally {
      playing = null;
      if (hooks.onEnd) hooks.onEnd(cancelled);
    }
  }

  /* ── the two jobs ─────────────────────────────────────── */

  /* A hang here used to be invisible: the strip said it was working something
     out and then said it for ever. Nothing should be able to wait silently. */
  async function transcribe(audio) {
    if (!asr) throw new Error("the listener is not loaded");
    const out = await withTimeout(asr(audio), ASR_TIMEOUT_MS,
      "the listener did not answer in time");
    return ((out && out.text) || "").trim();
  }

  /* Playback is its own small problem: a long answer generated in one piece
     cannot start until all of it exists, so it is generated a sentence at a
     time and the first one starts while the rest is still being made. */
  let playing = null, cancelled = false;

  function sentences(text) {
    return String(text || "")
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function speak(text, hooks) {
    hooks = hooks || {};
    if (!tts) return false;
    cancelled = false;
    const parts = sentences(text);
    const ctx = new (global.AudioContext || global.webkitAudioContext)();
    playing = { ctx, node: null };
    if (hooks.onStart) hooks.onStart();
    try {
      for (const part of parts) {
        if (cancelled) break;
        const made = await tts.generate(part, { voice: VOICE_NAME });
        if (cancelled) break;
        await play(ctx, made);
      }
    } finally {
      try { await ctx.close(); } catch (e) {}
      playing = null;
      if (hooks.onEnd) hooks.onEnd(cancelled);
    }
    return !cancelled;
  }

  function play(ctx, made) {
    return new Promise((resolve) => {
      const buf = ctx.createBuffer(1, made.audio.length, made.sampling_rate);
      buf.copyToChannel(made.audio, 0);
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.connect(ctx.destination);
      s.onended = resolve;
      if (playing) playing.node = s;
      s.start();
    });
  }

  function stop() {
    cancelled = true;
    try { if (playing && playing.node) playing.node.stop(); } catch (e) {}
    try { if (playing && playing.el) { playing.el.pause(); playing.el.currentTime = 0; } } catch (e) {}
  }

  function isSpeaking() { return !!playing; }

  global.LocalSpeech = {
    inspect, plan, load, ready, sizes: MODELS,
    openMic, closeMic, isMicOpen: () => micOpen,
    transcribe, speak, stop, isSpeaking,
    service, cloudTranscribe, cloudSpeak, toWav,
    // pure, and therefore the parts worth testing
    softwareAdapter, sentences,
    _rms: rms,
  };
})(window);
