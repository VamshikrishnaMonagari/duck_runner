/**
 * Fixed-step simulation with clamped catch-up, plus an on-demand mode for
 * scenes with no simulation (viewers/configurators) so they do not burn battery.
 * Also owns the tween scheduler, because tweens must advance on simTime.
 */
export function createLoop({ mode = 'continuous', hz = 60, maxCatchUp = 5, step, render }) {
  const dt = 1 / hz;
  let acc = 0, last = 0, running = false, rafId = null;
  let simTime = 0, frame = 0, needsRender = true;
  const tweens = [];

  // The per-frame TAIL, owned by the loop instead of by every scene. Two calls used to live at
  // the end of every render() -- diag.onFrame() and input.endFrame() -- and a scene that forgot
  // either got no error and no failing check. Forgetting onFrame() silently switched off the
  // penetration accumulator, so "the actor cannot pass through solid objects" passed everything.
  // Forgetting endFrame() left one-shot gestures set forever, so ONE tap placed a piece on every
  // frame for the rest of the session. Both are now impossible to forget: attachDiagnostics
  // subscribes itself here, and clears the gestures it already holds the input for.
  const frameSubs = [];
  function afterFrame() {
    for (let i = 0; i < frameSubs.length; i++) {
      try { frameSubs[i](); } catch (e) { /* a broken probe must never stop the game */ }
    }
  }

  function schedule(target, props, ms, ease = (t) => t) {
    const from = {}; for (const k of Object.keys(props)) from[k] = target[k];
    const tw = { target, from, to: props, ms, ease, t: 0, done: false, cancel() { tw.done = true; } };
    tweens.push(tw); needsRender = true;
    return tw;
  }
  function advanceTweens(sec) {
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i];
      if (tw.done) { tweens.splice(i, 1); continue; }
      tw.t = Math.min(1, tw.t + (sec * 1000) / tw.ms);
      const e = tw.ease(tw.t);
      for (const k of Object.keys(tw.to)) tw.target[k] = tw.from[k] + (tw.to[k] - tw.from[k]) * e;
      if (tw.t >= 1) { tw.done = true; needsRender = true; }
      else needsRender = true;
    }
  }

  function tick(now) {
    if (!running) return;
    rafId = requestAnimationFrame(tick);
    const t = now / 1000;
    let elapsed = last ? t - last : dt;
    last = t;
    if (elapsed > 1) elapsed = dt;           // clamp after a stall; never teleport
    if (mode === 'continuous') {
      acc += elapsed;
      let n = 0;
      while (acc >= dt && n < maxCatchUp) { step && step(dt); advanceTweens(dt); acc -= dt; simTime += dt; n++; frame++; }
      if (n === maxCatchUp) acc = 0;
      render(Math.min(1, acc / dt));
      afterFrame();
    } else {
      advanceTweens(elapsed);
      if (needsRender || tweens.length) { simTime += elapsed; frame++; render(1); needsRender = false; afterFrame(); }
    }
  }

  return {
    start() { if (!running) { running = true; last = 0; rafId = requestAnimationFrame(tick); } },
    stop() { running = false; if (rafId) cancelAnimationFrame(rafId); rafId = null; },
    pause() { running = false; if (rafId) cancelAnimationFrame(rafId); rafId = null; },
    resume() { if (!running) { running = true; last = 0; rafId = requestAnimationFrame(tick); } },
    invalidate() { needsRender = true; },
    /** Run fn after every rendered frame. Returns an unsubscribe. Registering the same
     *  function twice is a no-op, so a scene that also calls it by hand cannot double-count. */
    onFrame(fn) {
      if (typeof fn !== 'function') {
        throw new Error('loop.onFrame(fn) takes a function; got ' + typeof fn);
      }
      if (!frameSubs.includes(fn)) frameSubs.push(fn);
      return () => { const i = frameSubs.indexOf(fn); if (i >= 0) frameSubs.splice(i, 1); };
    },
    schedule,
    get simTime() { return simTime; },
    get frame() { return frame; },
    get running() { return running; },
  };
}
