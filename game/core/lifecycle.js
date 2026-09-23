/**
 * Background/foreground, resize and context loss. Pausing on hide is what stops
 * a multi-second delta arriving on resume and exploding the simulation.
 */
export function attachLifecycle({ canvas, loop, host, onResize: afterResize, onContextLost, onContextRestored } = {}) {
  const onVis = () => (document.hidden ? loop.pause() : loop.resume());
  document.addEventListener('visibilitychange', onVis);

  const onResize = () => {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    host.resize(w, h);
    // A scene owning render targets of its own (a composer, a shadow map) has to
    // resize them too, or a rotation leaves it rendering at the old resolution.
    try { afterResize && afterResize(w, h); } catch (e) { host.report(e); }
    loop.invalidate && loop.invalidate();
  };
  addEventListener('resize', onResize);
  addEventListener('orientationchange', onResize);

  const lost = (e) => { e.preventDefault(); loop.pause(); onContextLost && onContextLost(); };
  const restored = () => { onContextRestored && onContextRestored(); loop.resume(); };
  canvas.addEventListener('webglcontextlost', lost);
  canvas.addEventListener('webglcontextrestored', restored);

  return { dispose() {
    document.removeEventListener('visibilitychange', onVis);
    removeEventListener('resize', onResize); removeEventListener('orientationchange', onResize);
    canvas.removeEventListener('webglcontextlost', lost); canvas.removeEventListener('webglcontextrestored', restored);
  } };
}
