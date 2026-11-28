/* The sound of the agent still working.
 *
 * An instant answer takes about half a second, so silence is fine. The agent
 * takes seconds: it calls tools, reads what comes back, and checks its own
 * citations. In a voice conversation that is a long, flat silence in which
 * the only reasonable thought is that the thing has died.
 *
 * So the wait has a sound, and the sound carries information: a soft tap
 * every few seconds while it works, and a brighter one each time a step
 * finishes. Somebody listening can hear progress without looking, which is
 * the whole point of being able to ask out loud.
 *
 * What it sounds like is a struck sheet, and that is not decoration. A
 * suspended sheet of graphene is a real resonator - a drum a single atom
 * thick - so the tap is built the way a drum actually sounds: a circular
 * membrane's modes are not whole-number multiples of its fundamental, and
 * it is that inharmonic set, with the higher modes dying away first, that
 * stops a struck sheet sounding like a bell or a beep.
 *
 * It is quiet, it is short, and it is only ever heard by somebody who has
 * already pressed the microphone, so nothing makes a noise at a person who
 * did not ask for audio.
 */
(function (global) {
  "use strict";

  /* Vibration modes of a circular membrane, as ratios of the fundamental.
     A bell or a beep would use whole numbers; a drum does not, and that is
     the entire difference between this and a notification sound. */
  const MODES = [1, 1.593, 2.136, 2.296, 2.917];
  const MODE_GAIN = [1, 0.52, 0.33, 0.22, 0.13];
  const MODE_DECAY = [1, 0.74, 0.58, 0.47, 0.36];   // high modes go first

  const IDLE_HZ = 168;        // the waiting tap: low, easy to ignore
  const STEP_HZ = 252;        // a step finished: the same sheet, struck harder
  const LEVEL = 0.055;        // quiet enough to talk over
  const DECAY = 1.15;         // seconds for the fundamental to fall away

  const FIRST_WAIT_MS = 2200; // nothing at all before this: short waits are fine
  const EVERY_MS = 2600;      // and then about every two and a half seconds

  let ctx = null, out = null, timer = 0, running = false;

  function audio() {
    if (ctx) return ctx;
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { return null; }
    out = ctx.createGain();
    out.gain.value = LEVEL;
    out.connect(ctx.destination);
    return ctx;
  }

  function tap(hz, strength) {
    const c = audio();
    if (!c || !out) return;
    if (c.state === "suspended") { try { c.resume(); } catch (e) {} }
    const t0 = c.currentTime + 0.01;

    for (let i = 0; i < MODES.length; i++) {
      const osc = c.createOscillator();
      const g = c.createGain();
      // A real membrane is not a pure tone; a triangle has the gentle
      // upper partials a struck sheet does, without the buzz of a saw.
      osc.type = i === 0 ? "sine" : "triangle";
      osc.frequency.value = hz * MODES[i];

      const peak = MODE_GAIN[i] * strength;
      const life = DECAY * MODE_DECAY[i];
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + life);

      osc.connect(g); g.connect(out);
      osc.start(t0);
      osc.stop(t0 + life + 0.05);
    }
  }

  /* Each tap is slightly lower than the last, the way a sheet losing energy
     would be, so a long wait does not turn into a metronome. */
  let sinceStart = 0;

  function waitingTap() {
    sinceStart += 1;
    const sag = Math.max(0.86, 1 - sinceStart * 0.02);
    tap(IDLE_HZ * sag, 0.5);
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(function again() {
      if (!running) return;
      waitingTap();
      timer = setTimeout(again, EVERY_MS);
    }, sinceStart ? EVERY_MS : FIRST_WAIT_MS);
  }

  function start() {
    if (running) return;
    running = true;
    sinceStart = 0;
    schedule();
  }

  /* A step finished. Louder and higher than the waiting tap, because it
     means something rather than merely filling the silence. */
  function step() {
    if (!running) return;
    tap(STEP_HZ, 0.75);
    // The clock restarts, so a step is never followed immediately by a
    // waiting tap saying nothing has happened.
    clearTimeout(timer);
    timer = setTimeout(function again() {
      if (!running) return;
      waitingTap();
      timer = setTimeout(again, EVERY_MS);
    }, EVERY_MS);
  }

  function stop() {
    running = false;
    clearTimeout(timer);
    timer = 0;
  }

  global.Waiting = {
    start, step, stop,
    isRunning: () => running,
    // so a test can hear it without a sound card
    _tapsFor: () => MODES.length,
  };
})(window);
