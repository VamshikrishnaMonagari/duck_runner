/**
 * Multi-region, multi-pointer touch input. Regions are named rectangles in
 * normalised screen space; each tracks its own pointers with press/held/release
 * edges. This is the primitive: a joystick, a look-area and a pinch-zoom are all
 * adapters over it.
 *
 * Convention, stated once so nobody inverts it twice: `y` is UP-POSITIVE.
 * Screen Y grows downward, so it is negated exactly HERE and nowhere else.
 */
export function createInput(el, { onActivity } = {}) {
  const wake = () => { try { onActivity && onActivity(); } catch (_) {} };
  const regions = new Map();
  // Regions belonging to a control something actually DREW. They are hit-tested first, whatever
  // order they were declared in.
  //
  // onDown() below takes the FIRST region whose area contains the touch and breaks. That made
  // declaration order silently decide which control a finger reaches, and a generated island
  // explorer lost three of its four D-pad buttons to it: it declared one broad invisible region
  // for tank drive BEFORE the buttons, so every touch inside that area went to the invisible one
  // and only the button poking out past its edge worked. A racing build declared an even larger
  // overlapping region and was fine purely because it declared it LAST. Nothing warned either
  // way, and no check could see it -- the QA seam injects by region NAME and bypasses hit
  // testing entirely. A drawn control outranking an undrawn one removes the ordering question.
  const drawn = new Set();
  function prioritise(name) {
    if (!regions.has(name)) return false;
    drawn.add(name);
    const all = [...regions];
    regions.clear();
    for (const [k, v] of all) if (drawn.has(k)) regions.set(k, v);   // drawn first, in bind order
    for (const [k, v] of all) if (!drawn.has(k)) regions.set(k, v);
    return true;
  }
  const active = new Map();  // pointerId -> region name

  function addRegion(name, bounds = { x: 0, y: 0, w: 1, h: 1 }) {
    const reg = {
      name, bounds,
      node: null, pad: 0,           // set by bindRegionToElement: the element this region IS
      pointers: new Map(),          // pointerId -> {startX,startY,x,y,dx,dy}
      pressed: false, released: false, held: false,
      vec: { x: 0, y: 0 },          // normalised drag from origin, y UP-positive
      _tap: null, _swipe: null, _tapSeen: false, _swipeSeen: false,
    };
    // ONE-SHOT gestures. `tap` and `swipe` are discrete events, and getting their lifetime
    // right took three attempts, each with a measured failure mode:
    //   cleared in endFrame()  -> a finger lifting between step() and render() had its gesture
    //                             cleared before any step could read it. 1 real swipe in 4 was
    //                             silently dropped -- on a device, "sometimes it doesn't register".
    //   kept one extra frame   -> a gesture arriving BEFORE step() was then read by two
    //                             consecutive steps: one flick, two lane changes.
    // So: reading CONSUMES. Whenever in the frame the finger lifts, exactly one read sees it,
    // and endFrame clears only what has been read. Reading twice in one step yields null, which
    // is the correct semantics for an event rather than a state.
    Object.defineProperty(reg, 'tap', {
      enumerable: true,
      get() { if (reg._tap) reg._tapSeen = true; return reg._tap; },
      set(v) { reg._tap = v; reg._tapSeen = false; },
    });
    Object.defineProperty(reg, 'swipe', {
      enumerable: true,
      get() { if (reg._swipe) reg._swipeSeen = true; return reg._swipe; },
      set(v) { reg._swipe = v; reg._swipeSeen = false; },
    });
    regions.set(name, reg);
    return reg;
  }

  const rect = () => el.getBoundingClientRect();
  /** A region bound to an element IS that element: invisible means untouchable, and moved
   *  means moved. Both used to be wrong, because bindRegionToElement() snapshotted the rect
   *  once and nothing ever revisited it.
   *
   *  A tower defence shipped a turret shop that binds its cards inside show() and only sets
   *  display:none in hide() -- never unbinding, 0 unbind calls in the whole build. So every
   *  card kept the rect it had while visible AND its `drawn` status, forever. The checker
   *  found them "fully on screen" and "pressable"; the player saw nothing. Same shape as an
   *  island game's undrawn joystick and a runner whose start overlay was hidden by
   *  overwriting cssText: the harness path and the finger path diverge, and the harness wins.
   *
   *  Reading the element live fixes staleness and visibility together. A zero-size rect covers
   *  display:none and detachment; visibility:hidden is checked separately because it keeps its
   *  box. Opacity is deliberately NOT checked -- controls legitimately fade mid-animation, and
   *  failing those would swap one false negative for another. */
  function visibleBounds(reg) {
    if (!reg.node) return reg.bounds;
    if (!reg.node.isConnected) return null;
    const b = reg.node.getBoundingClientRect();
    if (b.width <= 0 || b.height <= 0) return null;
    const cs = (reg.node.ownerDocument.defaultView || window).getComputedStyle(reg.node);
    if (cs.visibility === 'hidden' || cs.display === 'none') return null;
    const r = rect(), pad = reg.pad || 0;
    return {
      x: (b.left - r.left - pad) / r.width,
      y: (b.top - r.top - pad) / r.height,
      w: (b.width + pad * 2) / r.width,
      h: (b.height + pad * 2) / r.height,
    };
  }

  function hit(name, cx, cy) {
    const reg = regions.get(name);
    const b = visibleBounds(reg);
    if (!b) return false;
    reg.bounds = b;                 // keep the snapshot current for injection and reporting
    const r = rect();
    const nx = (cx - r.left) / r.width, ny = (cy - r.top) / r.height;
    return nx >= b.x && nx <= b.x + b.w && ny >= b.y && ny <= b.y + b.h;
  }

  /** Classify a release delta into a directional flick, in sample()'s UP-positive y.
   *  `dir` is the dominant axis so a game can switch on it without doing trigonometry, and
   *  x/y are normalised so a game that wants the raw direction still has it. */
  function swipeFrom(dx, dyUp, from = null, at = null) {
    const d = Math.hypot(dx, dyUp) || 1;
    const dir = Math.abs(dx) >= Math.abs(dyUp) ? (dx > 0 ? 'right' : 'left') : (dyUp > 0 ? 'up' : 'down');
    // `from` and `at` are the press and release points in CSS px. Direction alone is enough
    // for a lane change, but DRAG-AND-DROP needs to know where the finger let go -- dragging a
    // turret onto a cell, or a piece onto a square. `tap` only fires when the finger barely
    // moved, so before this a drag release produced no position at all and those genres had
    // nothing in the engine to read. Same shape of gap as the missing swipe.
    return { x: dx / d, y: dyUp / d, dir, dist: d, from, at };
  }

  function onDown(e) {
    // Take the SMALLEST matching region, not the first one in iteration order.
    //
    // Regions are ordered drawn-first in BIND order, and this loop used to stop at the first hit.
    // So a large control bound early swallowed a small one bound later: circuit binds `stick` over
    // the bottom-left 60% of the screen, and createShell then binds its action button INSIDE that
    // rectangle -- leaving the start button unreachable through the region path. It works today
    // only because createShell ALSO attaches a DOM click listener, which is why nothing caught it:
    // the harness drives that button by injection and never hit-tests it, so anything relying on
    // the region path alone was broken and invisible.
    //
    // A smaller region is the more specific target, which is what a player aiming at it means.
    // Drawn regions still outrank undrawn ones; size only decides between equals.
    let best = null, bestKey = Infinity;
    for (const [name, reg] of regions) {
      if (!hit(name, e.clientX, e.clientY)) continue;
      const b = reg.bounds || { w: 1, h: 1 };
      const key = (drawn.has(name) ? 0 : 1) + Math.max(0, Math.min(1, (b.w || 1) * (b.h || 1)));
      if (key < bestKey) { bestKey = key; best = name; }
    }
    for (const [name, reg] of regions) {
      if (name !== best) continue;
      reg.pointers.set(e.pointerId, { startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, dx: 0, dy: 0 });
      reg.pressed = true; reg.held = true;
      active.set(e.pointerId, name);
      el.setPointerCapture && el.setPointerCapture(e.pointerId);
      wake();
      break;
    }
  }
  function onMove(e) {
    const name = active.get(e.pointerId); if (!name) return;
    const reg = regions.get(name); const p = reg.pointers.get(e.pointerId); if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    p.dx = p.x - p.startX; p.dy = p.y - p.startY;
    wake();
  }
  function endPointer(e) {
    const name = active.get(e.pointerId); if (!name) return;
    const reg = regions.get(name); const p = reg.pointers.get(e.pointerId);
    // A release is either a TAP (barely moved) or a SWIPE (a directional flick). Both are
    // discrete gestures, and until now only the tap existed -- so a lane runner, whose whole
    // control scheme is "flick left/right/up", had nothing in the engine to read. It wrote raw
    // canvas listeners because it had to, then added a SECOND reader of input.sample purely to
    // satisfy check.py, and a real finger fired both: one swipe, two lane changes. The engine
    // covering the genre's actual control is what removes the reason to go around it.
    if (p && Math.hypot(p.dx, p.dy) < 8) {
      reg.tap = { x: p.x, y: p.y };
    } else if (p) {
      reg.swipe = swipeFrom(p.dx, -p.dy, { x: p.startX, y: p.startY }, { x: p.x, y: p.y });
    }
    reg.pointers.delete(e.pointerId);
    active.delete(e.pointerId);
    if (reg.pointers.size === 0) {
      // Release EVERYTHING: a stuck vector is why a vehicle keeps driving with
      // no finger on the screen.
      reg.held = false; reg.released = true; reg.vec.x = 0; reg.vec.y = 0;
    }
    wake();
  }

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', endPointer);
  el.addEventListener('pointercancel', endPointer);
  el.addEventListener('pointerleave', endPointer);

  function sample(name, { radius = 60, deadzone = 0.15 } = {}) {
    const reg = regions.get(name); if (!reg) return { x: 0, y: 0 };
    const p = reg.pointers.values().next().value;
    if (!p) { reg.vec.x = 0; reg.vec.y = 0; return reg.vec; }
    let dx = p.dx, dy = p.dy;
    const d = Math.hypot(dx, dy);
    if (d > radius) { dx = (dx / d) * radius; dy = (dy / d) * radius; }
    let nx = dx / radius, ny = -dy / radius;         // <-- the single Y inversion
    const m = Math.hypot(nx, ny);
    if (m < deadzone) { nx = 0; ny = 0; }
    else { const s = (m - deadzone) / (1 - deadzone) / m; nx *= s; ny *= s; }
    reg.vec.x = nx; reg.vec.y = ny;
    return reg.vec;
  }

  function pinch(name) {
    const reg = regions.get(name); if (!reg || reg.pointers.size < 2) return null;
    const [a, b] = [...reg.pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y) };
  }

  /** Discrete gestures must survive ONE FULL FRAME, not "until the end of this frame".
   *
   *  endFrame() runs in render(), after step(). A finger lifting between those two calls set
   *  `tap`/`swipe` and had it cleared before any step could read it -- the gesture was silently
   *  dropped. Measured with real pointer events: 1 of 4 identical swipes vanished, which on a
   *  device reads as "sometimes the swipe just doesn't register". Ageing them by one frame
   *  makes a gesture readable by exactly one step, whenever in the frame it arrived. */
  // Anything subscribed here runs once per frame, because the LOOP calls endFrame() now.
  // That is what makes attachControls' knob and button feedback automatic: before this, no
  // scene in the suite called controls.update(), so in every game built from this template the
  // joystick knob never followed the thumb and a held button never lit up. Subscribers run
  // BEFORE the clearing below, so they still see this frame's pressed/tap/swipe.
  const _tailSubs = [];
  function onEndFrame(fn) {
    if (typeof fn !== 'function') {
      throw new Error('input.onEndFrame(fn) takes a function; got ' + typeof fn);
    }
    if (!_tailSubs.includes(fn)) _tailSubs.push(fn);
    return () => { const i = _tailSubs.indexOf(fn); if (i >= 0) _tailSubs.splice(i, 1); };
  }

  function endFrame() {
    for (let i = 0; i < _tailSubs.length; i++) {
      try { _tailSubs[i](); } catch (e) { /* a broken overlay must never stop the game */ }
    }
    for (const reg of regions.values()) {
      reg.pressed = false; reg.released = false;
      if (reg._tap && reg._tapSeen) reg.tap = null;
      if (reg._swipe && reg._swipeSeen) reg.swipe = null;
    }
  }
  function region(name) { return regions.get(name); }
  function dispose() {
    el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', endPointer); el.removeEventListener('pointercancel', endPointer);
    el.removeEventListener('pointerleave', endPointer);
  }

  // Test/QA seam: inject synthetic pointer state without a real finger.
  // Returns false for a region the scene never registered, instead of quietly
  // creating one: a mistyped region name used to look exactly like a broken scene,
  // because the injected input went to a region nothing samples.
  function inject(name, { x = 0, y = 0, down = true, at = null, atPx = null } = {}) {
    const reg = regions.get(name);
    if (!reg) return false;
    // A tap aimed at an exact pixel, for a checker that knows where the game's objects are
    // because the game projected them. Refused when the pixel is outside the region, so a
    // target that does not actually lie in the declared hit area is a visible failure
    // rather than an input that silently works from nowhere.
    if (atPx && !hit(name, atPx.x, atPx.y)) return false;
    if (!down) {
      // Lifting without having dragged IS a tap -- exactly what endPointer() does for a
      // real finger. Without this the QA seam could not drive a tap-based game at all:
      // injection only ever set a drag vector, so a board game reading `tap` looked
      // like a game whose controls do nothing, and every check that needed to play it
      // was skipped. The seam has to behave like the thing it stands in for.
      const p = reg.pointers.get(-1);
      if (p && Math.hypot(p.dx, p.dy) < 8) {
        // Where in the region. Defaults to the centre, but a checker driving a game that
        // picks 3D objects has to be able to aim: a full-screen board whose pieces are
        // anywhere but the middle responds to a centre tap by doing nothing, which is
        // indistinguishable from a region the game never reads.
        const px = atPx || p.atPx;
        if (px) {
          reg.tap = { x: px.x, y: px.y };
        } else {
          const a = at || p.at || { u: 0.5, v: 0.5 };
          const r = rect(), b = reg.bounds;
          reg.tap = { x: r.left + (b.x + b.w * a.u) * r.width, y: r.top + (b.y + b.h * a.v) * r.height };
        }
      } else if (p) {
        // Dragged, then lifted: the injected equivalent of a flick. Mirrors endPointer()
        // exactly, so a checker producing a swipe drives the SAME field a real finger sets.
        // That is the point -- when the seam and the finger land on one code path, a game has
        // no reason to write a second reader just for the checker, which is how one swipe
        // ended up moving two lanes.
        reg.swipe = swipeFrom(p.dx, -p.dy, p.atPx || null, p.atPx || null);
      }
      reg.pointers.clear(); reg.held = false; reg.released = true; reg.vec.x = 0; reg.vec.y = 0;
      return true;
    }
    reg.pointers.set(-1, { startX: 0, startY: 0, x: x * 60, y: -y * 60, dx: x * 60, dy: -y * 60, at, atPx });
    reg.held = true;
    return true;
  }

  /** Point a region's hit area at the element that DRAWS it.
   *
   *  Exists because hand-writing a normalised rectangle to match a button drawn in CSS
   *  pixels is two sources of truth, and they drifted: on a real phone the boost and
   *  brake buttons had to be tapped well above where they appeared. Deriving the area
   *  from the element makes disagreement impossible. `pad` grows the area slightly,
   *  because a fingertip is bigger and less precise than a mouse cursor.
   */
  /** `managed` means the ENGINE drew this control and guarantees it is on screen whenever it is
   *  live -- a shell screen's button, anything attachControls drew. Those hide legitimately
   *  (a start screen is dismissed; a pause menu closes) and reporting them as unreachable was
   *  a false positive on two template scenes. A binding a SCENE made by hand is the suspect
   *  population: that is where the hidden turret shop and the hidden start overlay came from. */
  function bindRegionToElement(name, node, { pad = 10, managed = false } = {}) {
    const r = rect(), b = node.getBoundingClientRect();
    const bounds = {
      x: (b.left - r.left - pad) / r.width,
      y: (b.top - r.top - pad) / r.height,
      w: (b.width + pad * 2) / r.width,
      h: (b.height + pad * 2) / r.height,
    };
    let reg = regions.get(name);
    if (reg) reg.bounds = bounds;          // keep live pointer state across a resize
    else { addRegion(name, bounds); reg = regions.get(name); }
    // Remember the element, so hit() can ask it where it is and whether it is visible instead
    // of trusting this snapshot for the rest of the run.
    reg.node = node; reg.pad = pad; reg.managed = !!managed;
    prioritise(name);                      // it is drawn, so it outranks any invisible region
    return bounds;
  }

  const names = () => [...regions.keys()];

  /** Which regions are bound to an element, and can a FINGER reach that element right now?
   *
   *  inject() writes straight into the region and deliberately does not hit-test, because the
   *  QA seam has to work on a game whose controls are mid-animation. So visibility gating in
   *  hit() stops a person from touching a hidden control and does nothing to stop the harness
   *  from driving it -- which is the divergence that let a tower defence pass "every drawn
   *  control can be pressed" with a shop the player never saw. Reporting it is what turns that
   *  from invisible into a failed check. */
  function boundVisibility() {
    const out = {};
    for (const [name, reg] of regions) {
      if (!reg.node) continue;                 // a bare hit area has nothing to be visible
      if (reg.managed) continue;               // the engine drew it and vouches for it
      out[name] = !!visibleBounds(reg);
    }
    return out;
  }

  return { addRegion, bindRegionToElement, prioritise, region, names, sample, pinch, endFrame, onEndFrame,
           dispose, inject, boundVisibility };
}
