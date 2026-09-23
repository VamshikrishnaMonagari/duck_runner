/**
 * Visible on-screen controls for named input regions.
 *
 * This exists because invisible regions are undiscoverable. A game can have
 * perfectly correct input handling and still be unplayable, because the player has
 * no idea where to put a thumb -- which is exactly the report that produced this
 * file: "there is no particular drag handle, just moving with my fingers directly
 * on screen."
 *
 * Drawn as DOM, not into the GL canvas: it costs no draw calls, needs no shader,
 * survives a lost context, and stays crisp at any device pixel ratio.
 *
 * Knows nothing about what the controls DO. A stick is a stick whether it steers a
 * car, walks a character or pans a camera.
 */
export function attachControls(input, { stick, buttons = [], shelf = [], shelfBottom = 8, opacity = 0.5 } = {}) {
  const pendingWarnings = [];
  // Flushed on a timeout rather than from update(): attachControls runs BEFORE
  // attachDiagnostics, so __GAME__ does not exist yet and there is nothing to report an
  // authoring bug to. A timeout fires after start() returns, by which point it is attached.
  const flushWarnings = () => {
    const g = globalThis.__GAME__;
    if (g && typeof g.reportError === 'function') {
      while (pendingWarnings.length) g.reportError(pendingWarnings.shift());
    } else if (pendingWarnings.length) {
      while (pendingWarnings.length) console.error(pendingWarnings.shift());
    }
  };
  const made = [];

  const layer = document.createElement('div');
  layer.style.cssText = 'position:fixed;inset:0;z-index:5;pointer-events:none';
  document.body.appendChild(layer);

  let knob = null, base = null;
  if (stick) {
    const r = stick.radius || 62;
    base = document.createElement('div');
    base.style.cssText = `position:absolute;left:${stick.x}px;bottom:${stick.y}px;`
      + `width:${r * 2}px;height:${r * 2}px;margin:0 0 -${r}px -${r}px;border-radius:50%;`
      + `border:2px solid rgba(255,255,255,${opacity});background:rgba(255,255,255,0.08);`
      + 'box-shadow:0 2px 12px rgba(0,0,0,0.35)';
    knob = document.createElement('div');
    knob.style.cssText = `position:absolute;left:50%;top:50%;width:${r * 0.78}px;height:${r * 0.78}px;`
      + `margin:-${r * 0.39}px 0 0 -${r * 0.39}px;border-radius:50%;`
      + `background:rgba(255,255,255,${opacity + 0.25});box-shadow:0 2px 8px rgba(0,0,0,0.4);`
      + 'transition:transform 0.05s linear';
    base.appendChild(knob);
    // Tag the stick the way buttons are tagged, so a checker can tell a DRAWN control from a
    // bare hit area. It could not: `dataset.region` was set only in the buttons loop below, so
    // a joystick this module had drawn was still reported as "a hit area, not a drawn labelled
    // button" and exempted from the check that a visible control must do something. That
    // exemption exists for look/drag regions which draw nothing; a stick we drew is not one.
    if (stick.region) base.dataset.region = stick.region;
    layer.appendChild(base);
    made.push(base);
  }

  // Anchor from EITHER edge, and lay out automatically when neither is given.
  //
  // This used to interpolate `right:${b.right}px` unconditionally. A generated racing game
  // wanted two steer buttons on the LEFT, passed `right: null` for both, and got
  // `right:nullpx` -- invalid CSS, silently dropped, so both buttons fell back to left:0 and
  // rendered ON TOP OF EACH OTHER. bindRegionToElement then pointed both regions at the same
  // rect, so one arrow was completely unreachable and the other steered the wrong way. The
  // build was relying on this module for exactly this ("Button regions - will be bound to DOM
  // elements by attachControls"), so the footgun was ours, not the game's.
  let autoSlot = 0;
  for (const b of buttons) {
    const size = b.size || 74;
    const bottom = Number.isFinite(b.bottom) ? b.bottom : 20;
    let anchor;
    if (Number.isFinite(b.left)) anchor = `left:${b.left}px;`;
    else if (Number.isFinite(b.right)) anchor = `right:${b.right}px;`;
    else {
      // Neither edge given -- fill from the RIGHT edge, not the left. Sticks conventionally
      // sit bottom-left (`left:${stick.x}px;bottom:${stick.y}px` above), so auto-placing from
      // the left would drop action buttons on top of the joystick in any avatar game whose
      // stick sits near the corner. The right edge is where action buttons belong anyway.
      anchor = `right:${16 + autoSlot * (size + 14)}px;`;
      autoSlot += 1;
      if (b.right !== undefined || b.left !== undefined) {
        // Reported, not silent: a non-numeric anchor is a bug in the calling scene, and the
        // no-runtime-errors check is the only thing that reliably gets an agent's attention.
        // Pushed onto the diagnostics error list when it exists, so it surfaces in check.py.
        const msg = `attachControls: button '${b.region}' was given a non-numeric left/right `
          + `(${JSON.stringify(b.left !== undefined ? b.left : b.right)}); auto-placed in a row `
          + 'instead. Pass a number, or omit both and let them lay out automatically.';
        // BUFFERED, not reported immediately: attachControls usually runs BEFORE
        // attachDiagnostics, so __GAME__ does not exist yet and a direct report is lost --
        // which is exactly what happened on the first attempt at this. Flushed from update(),
        // by which time diagnostics is attached.
        pendingWarnings.push(msg);
      }
    }
    const el = document.createElement('div');
    el.style.cssText = `position:absolute;${anchor}bottom:${bottom}px;`
      + `width:${size}px;height:${size}px;border-radius:50%;`
      + `border:2px solid rgba(255,255,255,${opacity});`
      + `background:${b.colour || 'rgba(255,255,255,0.10)'};`
      + 'display:flex;align-items:center;justify-content:center;'
      + `color:rgba(255,255,255,${opacity + 0.4});font:700 13px/1 ui-monospace,monospace;`
      + 'letter-spacing:1px;box-shadow:0 2px 10px rgba(0,0,0,0.35)';
    el.textContent = b.label || '';
    // Tag the element with its region so a checker can tell a DRAWN, LABELLED button from a
    // bare hit area. The distinction matters: a labelled button that changes nothing is broken
    // -- a generated explorer shipped a JUMP button that did nothing and passed 26/26 -- while
    // a look region legitimately has no effect on anything the game reports, only on the
    // picture, so failing it for "doing nothing" is a false alarm.
    if (b.region) el.dataset.region = b.region;
    layer.appendChild(el);
    made.push(el);
    b._el = el;
  }

  /** Point every drawn control at its own hit area. Called at attach and on resize,
   *  so rotating the phone cannot leave the buttons hit-testing their old positions. */
  /** A ROW of choices that always fits the phone: a tower shop, a weapon picker, a build menu.
   *
   *  Buttons above are positioned individually, which is right for two or three of them and
   *  wrong for five. A generated tower defence hand-rolled its shop as
   *  `left:50%; transform:translateX(-50%); display:flex; gap:8px` with no width limit, so five
   *  90px items plus gaps were wider than the screen and it overflowed BOTH edges symmetrically
   *  -- the first and last towers were half off the phone and unbuyable. Nothing caught it: the
   *  strip was hand-written DOM with no region tag, so the "no labelled control is cut off"
   *  check never looked at it.
   *
   *  Items here share the width instead of demanding it: `flex:1 1 0` with `min-width:0` shrinks
   *  them to fit, so N can grow without anything leaving the screen. Each is a real input
   *  region bound to its own element, so it is hit-tested where it is drawn and outranks any
   *  broad invisible region.
   */
  const shelfEls = [];
  if (shelf.length) {
    const row = document.createElement('div');
    row.style.cssText = `position:absolute;left:0;right:0;bottom:${shelfBottom}px;`
      + 'display:flex;gap:6px;padding:0 8px;box-sizing:border-box;'
      + 'align-items:stretch;pointer-events:none';
    for (const it of shelf) {
      const cell = document.createElement('div');
      // pointer-events:none, like every other control this module draws. Pointer listeners
      // live on the CANVAS, so a cell that captures the touch is a cell nothing can press:
      // the tap never reaches the canvas and there is no click handler to catch it. Shipped
      // as `pointer-events:auto` in 20260830_122735 -- injected taps worked and real clicks
      // did nothing, so every check passed. A generated tower defence built on the placement
      // skeleton inherited it, and its entire UI was unpressable on a real device.
      cell.style.cssText = 'flex:1 1 0;min-width:0;pointer-events:none;'
        + 'display:flex;flex-direction:column;align-items:center;justify-content:center;'
        + `padding:8px 4px;border-radius:12px;border:2px solid rgba(255,255,255,${opacity});`
        + `background:${it.colour || 'rgba(255,255,255,0.10)'};`
        + `color:rgba(255,255,255,${opacity + 0.45});`
        + 'font:700 12px/1.25 ui-monospace,monospace;text-align:center;'
        + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
        + 'box-shadow:0 2px 10px rgba(0,0,0,0.35)';
      const top = document.createElement('div');
      top.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%';
      top.textContent = it.label || '';
      cell.appendChild(top);
      if (it.sub !== undefined && it.sub !== null) {
        const sub = document.createElement('div');
        sub.style.cssText = `opacity:0.8;font-weight:400;font-size:11px;margin-top:2px;`
          + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%';
        sub.textContent = String(it.sub);
        cell.appendChild(sub);
      }
      if (it.region) cell.dataset.region = it.region;
      row.appendChild(cell);
      made.push(cell);
      shelfEls.push({ region: it.region, el: cell, pad: it.pad });
    }
    layer.appendChild(row);
    made.push(row);
  }

  function syncRegions() {
    for (const b of buttons) {
      if (b._el) input.bindRegionToElement(b.region, b._el, { managed: true, pad: b.pad ?? 10 });
    }
    for (const it of shelfEls) {
      if (it.region) input.bindRegionToElement(it.region, it.el, { managed: true, pad: it.pad ?? 6 });
    }
    if (stick && stick.bindToBase && base) {
      input.bindRegionToElement(stick.region, base, { managed: true, pad: stick.pad ?? 0 });
    } else if (stick && stick.region && input.prioritise) {
      // A drawn stick that keeps its own (deliberately larger) hit area still outranks any
      // invisible region: being DRAWN earns the priority, not being bound to the base.
      input.prioritise(stick.region);
    }
  }
  syncRegions();

  /** Call once per frame: reflects the real input state, so what you see is what the
   *  game is actually reading -- a stick drawn from a separate source of truth is a
   *  new way for the display and the behaviour to disagree. */
  function update() {
    if (pendingWarnings.length) flushWarnings();
    if (stick && knob) {
      const v = input.sample(stick.region, { radius: stick.radius || 62, deadzone: stick.deadzone || 0 });
      const r = (stick.radius || 62) * 0.55;
      // y is UP-positive in input; CSS translate is DOWN-positive.
      knob.style.transform = `translate(${(v.x * r).toFixed(1)}px, ${(-v.y * r).toFixed(1)}px)`;
    }
    for (const b of buttons) {
      if (!b._el) continue;
      const held = input.region(b.region) && input.region(b.region).held;
      b._el.style.filter = held ? 'brightness(1.9)' : 'none';
      b._el.style.transform = held ? 'scale(0.94)' : 'none';
    }
  }

  /** Drive update() ourselves, every frame, for as long as these controls exist.
   *
   *  It used to be the scene's job to call it once per frame, and a generated first-person maze
   *  simply did not: it called `shell.update()` and missed the sibling. The joystick was drawn
   *  and FROZEN -- the knob never followed the finger -- and because a frozen knob gives no
   *  feedback, the player could not tell that strafing was pushing them into a wall either. Two
   *  device-visible defects from one missing line, and no check touched it across five runs.
   *
   *  A required per-frame call that nothing enforces is a defect generator. This costs one CSS
   *  transform write per frame, orders of magnitude cheaper than the GL render an onDemand loop
   *  is there to skip, so it does not undo that mode's purpose. `update` stays exported and is
   *  idempotent: a scene that also calls it does no harm.
   */
  let raf = 0;
  const tick = () => { update(); raf = requestAnimationFrame(tick); };
  raf = requestAnimationFrame(tick);

  function dispose() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    layer.remove();
  }

  setTimeout(flushWarnings, 0);

  // Drive update() off the input's per-frame tail, which the loop guarantees. Before this it
  // was the scene's job, and no scene in the suite ever called it -- so the knob never followed
  // the thumb and a held button never lit up in ANY game built from this template. Calling it
  // yourself as well is harmless: it only writes style properties.
  if (input && typeof input.onEndFrame === 'function') input.onEndFrame(update);

  return { update, syncRegions, dispose, layer };
}
