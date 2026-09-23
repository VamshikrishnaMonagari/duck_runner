/**
 * The game SHELL: the score readout, the start / win / game-over screens, and the restart.
 *
 * Every genre needs these and every generated game wrote them from scratch, which is where
 * three separate shipped defects came from:
 *
 *  1. The score was drawn in React Native and fed by postMessage, so it lived in a different
 *     variable from the one the game incremented. On a device coins were collected and the
 *     counter stayed at 0/15, while every automated check passed -- the checker loads the
 *     WebView alone, so it verified the inner value truthfully and could not see the display.
 *     Here the HUD and the value reported to diagnostics are the SAME field. They cannot diverge.
 *
 *  2. A full-screen start overlay had no `pointer-events: none`, so it swallowed every touch.
 *     The game sat on "SWIPE TO RUN" forever. Overlays here are inert by default and only the
 *     action button is interactive -- and that button is registered as an INPUT REGION, so the
 *     harness can press it and a dead start screen fails the checks instead of shipping.
 *
 *  3. A win condition compared against a hard-coded constant while placement had quietly
 *     produced fewer pickups, so the game could never be completed. `total` here is a function,
 *     evaluated live, so it reports what exists rather than what was intended.
 *
 * All of it is DOM inside the game bundle. Nothing here belongs on the React Native side: the
 * checker loads the bundle alone, so anything drawn natively is unverifiable by construction.
 */

const HUD_CSS = 'position:fixed;left:0;right:0;top:0;z-index:6;pointer-events:none;'
  + 'display:flex;gap:14px;justify-content:space-between;align-items:center;'
  + 'padding:calc(8px + env(safe-area-inset-top)) 16px 8px 16px;'
  + 'font:700 17px/1 system-ui,-apple-system,sans-serif;color:#fff;'
  + 'text-shadow:0 2px 6px rgba(0,0,0,0.55)';

const OVERLAY_CSS = 'position:fixed;inset:0;z-index:8;'
  // INERT by default. This single declaration is the fix for a shipped game that never started:
  // a full-screen overlay with default pointer-events captures every touch, and the canvas
  // underneath never sees one.
  + 'pointer-events:none;'
  + 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;'
  + 'background:rgba(6,10,18,0.62);backdrop-filter:blur(2px);'
  + 'font:600 16px/1.35 system-ui,-apple-system,sans-serif;color:#fff;text-align:center;padding:24px';

const BTN_CSS = 'pointer-events:auto;margin-top:6px;padding:14px 34px;border:0;border-radius:14px;'
  + 'background:#4ade80;color:#062b12;font:800 17px/1 system-ui,sans-serif;letter-spacing:0.4px;'
  + 'box-shadow:0 6px 18px rgba(0,0,0,0.35)';

// Names the diagnostics contract owns. A HUD field sharing one of these silently overwrites it in
// report(), and the failure lands somewhere else entirely: a racing build named a field `pos`, its
// rank string replaced the actor's [x,y,z], and the harness reported a game that publishes no
// position -- costing a build round to find. The rule was already written in report() below; it was
// simply not enforced, so it was still possible to get wrong.
const RESERVED = ['pos', 'facing', 'view', 'progress', 'screen', 'yaw', 'groundY', 'phase', 'scene'];

export function createShell(input, { fields = {}, screens = {}, onAction = null, actionRegion = 'shellAction' } = {}) {
  const values = {};
  const els = {};
  let screen = null;
  let lastTap = null;

  for (const name of Object.keys(fields)) {
    if (RESERVED.includes(name)) {
      throw new Error(
        `createShell: a HUD field cannot be called '${name}' -- attachDiagnostics uses that name for `
        + 'the game state it reads, and shell.report() would overwrite it. Rename the field '
        + `(e.g. '${name === 'pos' ? 'place' : name + 'Hud'}') and set it with shell.set().`);
    }
  }

  const hud = document.createElement('div');
  hud.style.cssText = HUD_CSS;
  document.body.appendChild(hud);

  for (const [name, cfg] of Object.entries(fields)) {
    values[name] = cfg.start ?? 0;
    const el = document.createElement('div');
    el.dataset.hud = name;
    hud.appendChild(el);
    els[name] = el;
  }

  const overlay = document.createElement('div');
  overlay.style.cssText = OVERLAY_CSS;
  overlay.style.display = 'none';
  const title = document.createElement('div');
  title.style.cssText = 'font:800 26px/1.2 system-ui,sans-serif';
  const hint = document.createElement('div');
  hint.style.cssText = 'opacity:0.82;max-width:22em';
  const button = document.createElement('button');
  button.style.cssText = BTN_CSS;
  overlay.append(title, hint, button);
  document.body.appendChild(overlay);

  /** The action button is a REGION, not just a DOM node.
   *
   *  A generated runner drew a start overlay the harness could not press, so nothing it did
   *  reached the game and the only declared region looked dead. Registering the button means
   *  the harness presses the same pixels a thumb does, and a start screen that cannot be
   *  dismissed fails `at least one declared region does something` instead of shipping. */
  input.addRegion(actionRegion, { x: 0.5, y: 0.5, w: 0.001, h: 0.001 });
  const syncActionRegion = () => {
    if (screen && screens[screen] && screens[screen].action !== false) {
      // Tag it the way controls.js tags its buttons: this is a DRAWN control, so a checker
      // can find where it actually sits and click it with a real pointer event instead of
      // injecting into the region by name and bypassing everything a finger has to obey.
      button.dataset.region = actionRegion;
      // ...and mark it as the SHELL's action, so the dead-control check can leave it alone.
      // It only does anything while a screen is up, and by the time that check runs the
      // screen has been dismissed. It is verified far more strongly elsewhere, by a real
      // pointer event: 'the start screen can be tapped by a finger'.
      button.dataset.shellAction = '1';
      input.bindRegionToElement(actionRegion, button, { managed: true, pad: 12 });
    } else {
      // Collapsed rather than removed: `regions()` stays stable, so the checker's report does
      // not change shape depending on which screen the game happens to be on.
      const r = input.region(actionRegion);
      if (r) r.bounds = { x: 0.5, y: 0.5, w: 0.001, h: 0.001 };
    }
  };

  function render() {
    for (const [name, cfg] of Object.entries(fields)) {
      // `total` is a FUNCTION, evaluated now. A hard-coded total is how a game came to promise
      // 20 coins when placement had produced 19, making it impossible to finish.
      const total = typeof cfg.total === 'function' ? cfg.total() : cfg.total;
      const label = cfg.label ? cfg.label + ' ' : '';
      // A field's value may be free TEXT, not only a number over a total. Without this a race
      // position ("P4"), a countdown ("1:07") or a wave label had nowhere to live here, so every
      // build on record drew a second HUD of its own -- and one used this one AS WELL, leaving
      // "LAP 0/3" and "P4" printed over each other at the top of a shipped screen.
      els[name].textContent = typeof values[name] === 'string'
        ? `${label}${values[name]}`
        : total === undefined || total === null
          ? `${label}${values[name]}`
          : `${label}${values[name]} / ${total}`;
    }
  }

  function set(name, value) {
    if (!(name in values)) return;
    values[name] = value;
    render();
  }

  /** `show('win', { hint: `${score} coins in ${time}` })` -- the second argument overrides this
   *  screen's text for this showing only.
   *
   *  Screens took their text at construction, so nothing depending on how the run WENT could appear
   *  on the screen that ends it. Every build on record worked around that by appending its own DOM
   *  to shell.overlay: a menu button, a final score, a best-time line. One argument removes the
   *  reason to reach past the shell at all. */
  function show(name, over) {
    const s = over ? { ...screens[name], ...over } : screens[name];
    if (!s) return;
    screen = name;
    title.textContent = s.title || '';
    hint.textContent = s.hint || '';
    button.textContent = s.action === false ? '' : (s.action || 'PLAY');
    button.style.display = s.action === false ? 'none' : '';
    // Re-establish the overlay's OWN css before revealing it. `overlay` is handed to scenes so
    // they can restyle a screen, and a shipped runner used that to write
    // `shell.overlay.style.cssText = '...display:none...'`, which wiped BOTH the inertness that
    // stops a full-screen overlay swallowing every touch AND the display state show()/hide()
    // depend on. Reapplying here means a clobbered overlay is repaired the next time a screen
    // is shown, instead of staying broken for the rest of the run.
    overlay.style.cssText = OVERLAY_CSS;
    overlay.style.display = 'flex';
    syncActionRegion();
  }

  function hide() {
    screen = null;
    overlay.style.display = 'none';
    syncActionRegion();
  }

  const fire = () => { const from = screen; hide(); if (onAction) onAction(from); };
  button.addEventListener('click', fire);

  /** Called from the game loop. Presses of the action button arrive as a region tap, which is
   *  what makes the button drivable by the harness as well as by a finger. */
  let repaired = false;
  function update() {
    if (!screen) return;
    // A SCREEN THAT IS SET BUT NOT VISIBLE IS A FROZEN GAME. The scene's step() begins
    // `if (shell.screen) return;`, so an overlay hidden from outside while `screen` is still
    // set stops the game forever with nothing on screen to explain it. That shipped: a runner
    // set display:none on the overlay AFTER show('start'), and the game sat at phase 'start'
    // rendering a whole world nobody could start. It passed every check, because the harness
    // taps the action region BY NAME and never needed the overlay to be visible.
    //
    // The shell owns this element, so there is no legitimate reason for it to be hidden here.
    // Repair it rather than warn: a warning in a WebView goes nowhere a player can see.
    const cs = overlay.ownerDocument.defaultView.getComputedStyle(overlay);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) {
      overlay.style.cssText = OVERLAY_CSS;
      overlay.style.display = 'flex';
      if (!repaired) {
        repaired = true;
        try {
          console.warn('createShell: the screen overlay was hidden from outside while a screen '
            + `('${screen}') was still showing, which freezes the game behind an invisible start `
            + 'screen. It has been restored. Use shell.hide() to dismiss a screen; do not set '
            + 'display or overwrite cssText on shell.overlay.');
        } catch (e) {}
      }
      syncActionRegion();
    }
    // ONE-SHOT LATCH on the tap object itself. input.endFrame() nulls `tap` and hands out a
    // fresh object for the next one, so identity is an exact "have I already acted on this
    // tap". Without it, update() running twice in a frame fires onAction twice -- which is now
    // possible two ways: the engine calls update() on the per-frame tail, and scenes written
    // before that still call it from step().
    const r = input.region(actionRegion);
    if (r && r.tap && r.tap !== lastTap) { lastTap = r.tap; fire(); }
  }

  /** Merge into getState() so the HUD and the reported progress are the same numbers.
   *  The current `phase` is reported too: a checker that finds a game stuck behind an overlay
   *  can say so instead of reporting that its controls do nothing. */
  function report() {
    // `phase`, NOT `screen`. The diagnostics contract already uses `screen` for the projected
    // pixel positions of tappable objects, and reporting a string there silently overwrote a
    // scene's published coin positions -- the harness then said "this game published no
    // objective positions" and the progress check failed on a game that had published them.
    // A shell field must never collide with a contract field.
    const out = { phase: screen || 'playing' };
    for (const [name, cfg] of Object.entries(fields)) {
      out[name] = values[name];
      const total = typeof cfg.total === 'function' ? cfg.total() : cfg.total;
      if (total !== undefined && total !== null) out[name + 'Total'] = total;
    }
    return out;
  }

  /** Drive update() ourselves, exactly as attachControls does for its knob.
   *
   *  update() is what turns a tap on the action region into `fire()`, and it was the scene's job
   *  to call it once per frame. A required per-frame call that nothing enforces is a defect
   *  generator: a generated first-person maze called `shell.update()` and forgot the sibling
   *  `controls.update()`, and a racing build hand-rolled its own overlay rather than use this at
   *  all. Both shipped a start screen a player could not get past. Nothing should be able to
   *  break by forgetting a call. `update` stays exported and is idempotent. */
  let raf = 0;
  const tick = () => { update(); raf = requestAnimationFrame(tick); };
  raf = requestAnimationFrame(tick);

  function dispose() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    hud.remove(); overlay.remove();
  }

  render();
  // The engine drives update() too. This is the call that froze a shipped runner behind an
  // invisible start screen, and circuit.js -- the racing exemplar -- omitted it for months while
  // a generated racer noticed and copied the omission. It reads the action region and runs the
  // overlay's self-repair, and neither should depend on a scene remembering a per-frame contract.
  // A SCENE MAY ONLY HAVE ONE HUD. `fields` draws a row of chips across the top; a scene wanting
  // more than chips (speed + lap + timer + a progress bar) builds its own bar and pins it to the
  // same edge -- and then BOTH draw. A shipped racing game did exactly that: our chip read
  // "LAP 0/3", its own bar read "0 km/h", both anchored top-left, and the corner came out as
  // unreadable overstruck glyphs. Nothing caught it: every check reads getState(), and the lap
  // number was correct in both places.
  //
  // Scanned from the per-frame tail, NOT once at boot. That racing HUD was built display:none and
  // only shown when the race started, so a single check at startup sees nothing and passes.
  let hudScans = 0, hudSettled = false;
  function checkOneHud() {
    if (hudSettled || !Object.keys(fields).length) return;
    if (++hudScans % 30 !== 1) return;              // ~twice a second, not every frame
    if (hudScans > 1800) { hudSettled = true; return; }
    try {
      const doc = hud.ownerDocument, win = doc.defaultView;
      const mine = hud.getBoundingClientRect();
      if (!(mine.width > 0 && mine.height > 0)) return;
      for (const el of doc.body.children) {
        if (el === hud || el === overlay || hud.contains(el) || el.contains(hud)) continue;
        const cs = win.getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
        if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
        if (!(el.textContent || '').trim()) continue;        // a backdrop, not a readout
        const b = el.getBoundingClientRect();
        if (b.width <= 0 || b.height <= 0) continue;
        // A full-screen element is a countdown or a result card, not a competing HUD.
        if (b.height >= win.innerHeight * 0.8) continue;
        if (Math.min(mine.bottom, b.bottom) - Math.max(mine.top, b.top) <= 2) continue;
        if (Math.min(mine.right, b.right) - Math.max(mine.left, b.left) <= 2) continue;
        hudSettled = true;
        hud.style.display = 'none';                  // the scene's own HUD is the designed one
        try {
          console.warn('createShell: this scene draws its own HUD over the one `fields` makes, so '
            + 'both were rendering in the same band and the text overstruck. Ours has been hidden '
            + 'and the scene\'s kept. Use ONE: either declare `fields` and let the shell draw '
            + 'them, or drop `fields` and keep your own bar -- either way still merge '
            + 'shell.report() into getState() so the checker can read the phase.');
        } catch (e) {}
        return;
      }
    } catch (e) { hudSettled = true; }
  }

  if (input && typeof input.onEndFrame === 'function') {
    input.onEndFrame(() => { update(); checkOneHud(); });
  }

  return { set, get: (n) => values[n], show, hide, update, report, dispose,
           get screen() { return screen; }, hud, overlay, button };
}
