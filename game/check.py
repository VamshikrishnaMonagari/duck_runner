#!/usr/bin/env python3
"""Run the game and check it. The loop that makes a 3D game verifiable without a device.

Why this exists: a 3D game is written blind. Every defect that reached a real user in
this project was found by running the built game or by LOOKING at one frame -- never by
reading the code. Two inverted controls (throttle driving backwards at the camera,
drag-right steering left) passed seventeen assertions that measured how FAR things
moved and never which WAY.

So this does two things that reading cannot:

  1. Drives the game and asserts the invariants that broke before -- controls respond,
     controls RELEASE, movement follows the facing direction, the actor is on the
     ground and not inside it, nothing throws.
  2. Saves a PNG of a real frame, and prints what to judge in it. Some failures are
     only visible: no shadows makes every object look like it is floating, and a
     camera on the wrong side makes a car appear to drive at you. No assertion sees
     those. Your eyes do.

Usage:
    python3 check.py --scene main                 # bundle, drive, assert, screenshot
    python3 check.py --scene main --no-bundle     # reuse the last bundle
    python3 check.py --scene main --seconds 12    # drive for longer

Exit code is 0 only if every check passed. The screenshot is written either way --
a failing run is exactly when you most need to see the frame.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).parent
APP_BUNDLE_MISSING: list[str] = []
CHROME_CANDIDATES = [
    '/usr/bin/google-chrome', '/usr/local/bin/chromium',
    '/usr/local/bin/chromium-browser', '/usr/bin/chromium',
]
LANDSCAPE = {'width': 860, 'height': 412}
PORTRAIT = {'width': 412, 'height': 860}


def viewport_for(root: Path) -> tuple[dict, str]:
    """The orientation the app will ACTUALLY run in, read from app.json.

    This checker used to test landscape unconditionally, while every generated Expo app
    ships `orientation: "portrait"` unless the game changes it. So a benchmark build put a
    wide tower-defence board on a portrait phone with most of the screen empty, and the
    checker had measured a shape the player never sees. Framing is the one thing that
    cannot be judged in the wrong aspect ratio.
    """
    cfg = root.parent / 'app.json'
    try:
        val = json.loads(cfg.read_text()).get('expo', {}).get('orientation')
    except Exception:
        return LANDSCAPE, 'landscape (no app.json; template default)'
    if val == 'portrait':
        return PORTRAIT, 'portrait (from app.json)'
    if val == 'landscape':
        return LANDSCAPE, 'landscape (from app.json)'
    # "default" means the device decides, so both are reachable; judge the harder one.
    return PORTRAIT, f'portrait (app.json says {val!r}, which allows either)'


VIEWPORT, VIEWPORT_WHY = viewport_for(ROOT)


# ---------------------------------------------------------------------------- driver
# Runs INSIDE the page. Kept here rather than in a JS file so the checker is one
# portable file, and so the assertions live next to the reasons for them.
# Is the game sitting behind a start screen? Same test the driver uses, expressed for Python.
START_GATE_JS = r"""() => {
  const G = window.__GAME__; if (!G || !G.getState) return null;
  const st = G.getState() || {};
  const flag = ['gameStarted', 'started', 'running', 'active', 'playing'].find((k) => st[k] === false);
  if (flag) return flag;
  return (typeof st.phase === 'string' && /idle|menu|ready|waiting|start/i.test(st.phase))
    ? `phase='${st.phase}'` : null;
}"""

# Where a finger would actually land: the centre of the drawn action control, in page pixels.
# Prefers the shell's action button, then any drawn labelled control. Returns null when nothing
# is drawn at all -- which is itself the finding, and the check below says so.
ACTION_SPOT_JS = r"""() => {
  const pick = document.querySelector('[data-region="shellAction"]')
    || [...document.querySelectorAll('[data-region]')].find((e) => e.offsetParent !== null)
    || null;
  if (!pick) return null;
  const r = pick.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2,
           w: r.width, h: r.height, region: pick.dataset.region || '' };
}"""

DRIVER = r"""
async () => {
  const out = { checks: [], skipped: [], state: null, frame: null, fps: null, info: null };
  const ck = (name, ok, detail) => out.checks.push({ name, ok: !!ok, detail: String(detail ?? '') });
  // A check that quietly does not run reads as a check that passed. An earlier version
  // skipped four invariants on a game that reported no groundY and printed "11/11
  // passed", which is a false reassurance -- worse than a visible gap, because nobody
  // goes looking. Every skip is now named with its reason.
  const sk = (name, why) => out.skipped.push({ name, why });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const G = window.__GAME__;

  if (!G) { ck('the game exposes __GAME__ diagnostics', false,
               'attachDiagnostics was never called, so nothing can be checked'); return out; }

  ck('the game booted', !!window.__READY__, window.__READY__ ? '' : 'start() never finished');
  ck('no errors on startup', G.errors.length === 0, JSON.stringify(G.errors.slice(0, 2)));

  // ---- controls. The generic checker cannot guess what a game called its controls,
  // so the game reports them via attachDiagnostics.
  const regions = (G.regions && G.regions()) || [];
  ck('the game declares its control regions', regions.length > 0,
     regions.length ? regions.join(', ') : 'no regions -- the player has nothing to touch');

  // WHICH region is the primary control? Six checks below used regions[0] -- "whatever the game
  // lists first" -- which was only ever a guess, and it broke the moment drawn controls began
  // being hit-tested first: a shell's PLAY button is drawn, so it moved to the front, and the
  // drive checks then spent ten seconds pressing a button that starts the game and reported the
  // player stuck for 9.5 of them. The probe below MEASURES which region moves the actor, and
  // `primary` is set from that. It falls back to the first-listed region only where nothing was
  // measured -- a placement game with no avatar, or an on-rails scene that skips the probe
  // entirely. That fallback is why this must be DECLARED and not merely assigned: without it the
  // assignment created an accidental global, every avatar scene passed by luck, and the on-rails
  // runner -- which never reaches the assignment -- died with "primary is not defined".
  let primary = regions[0];

  // ...and WHICH region is FORWARD? A separate question, and conflating the two deleted a
  // feature from a shipped game. `primary` is whatever moved the actor MOST, which is the right
  // answer for "does any control work" and the wrong one for "does forward go forward": a car's
  // brake reverses, reversing travelled 3.85 m while the throttle was still winding up, so the
  // brake was crowned as forward and judged at alignment -1.00. The build's fix was to REMOVE
  // REVERSE GEAR, and it passed. The check was right that something was backwards and wrong
  // about what.
  //
  // So forward is taken from what the game DECLARES, not from what travelled furthest. A
  // throttle name wins; then a stick, whose +y is forward by sample()'s own convention; and only
  // if the game named nothing recognisable does it fall back to the measured mover -- with
  // brake-ish names excluded, because that specific mistake has now cost one game its reverse.
  //
  // Selecting forward by NAME and not by travel is also what keeps the alignment check honest:
  // pick the most-forward-moving region and the check can never fail, and it would have stopped
  // catching the real defect it was built for -- a racing build driving backwards along its own
  // spline at alignment -0.68.
  // Priority is OURS, not the game's declaration order. The first version searched the region
  // list for anything matching, so a first-person scene declaring look before move had its LOOK
  // region chosen as forward -- driving it rotated the camera, moved nothing, and the camera
  // check then read a degenerate projection and failed a scene that had passed for weeks.
  // A camera region is never forward, whatever else it is called.
  const NEVER_FWD = /^(look|aim|camera|cam|orbit|drag|touch|swipe|pan|zoom|shoot|fire|jump|nitro|n2o|boost|pause|menu|shellaction)$/i;
  const BRK_NAME = /^(brake|brk|reverse|rev|back|backward|down|slow|stop|handbrake)$/i;
  const FWD_ORDER = [
    /^(gas|accel|acceler\w*|throttle)$/i,      // an explicit throttle beats everything
    /^(forward|fwd|drive|go|run|up)$/i,
    /^(stick|joystick)$/i,                     // +y is forward by sample()'s convention
    /^(move|pad|track)$/i,
  ];
  let forward = primary;
  let forwardWhy = 'first-listed region (nothing measured, nothing named)';
  const pickForward = (mover) => {
    for (const re of FWD_ORDER) {
      const r = regions.find((x) => re.test(x) && !NEVER_FWD.test(x));
      if (r) { forward = r; forwardWhy = `it is named '${r}'`; return; }
    }
    if (mover && !BRK_NAME.test(mover) && !NEVER_FWD.test(mover)) {
      forward = mover; forwardWhy = `nothing was named for it, and '${mover}' moved the actor furthest`; return;
    }
    const alt = regions.find((x) => x !== mover && !BRK_NAME.test(x) && !NEVER_FWD.test(x));
    if (alt) {
      forward = alt;
      forwardWhy = mover ? `'${mover}' moved it furthest but reads as a brake or a camera control, so '${alt}' was used`
                         : `nothing moved the actor, so '${alt}' was used`;
      return;
    }
    forward = mover || primary;
    forwardWhy = mover ? `only '${mover}' moved the actor, and it reads as a brake or a camera control`
                       : forwardWhy;
  };

  // ---- GET THE GAME PLAYING before anything is measured about it.
  //
  // core/shell.js draws the start screen and registers its action button as an input region,
  // precisely so a harness can press it. This checker DID touch that region -- but only as a
  // movement probe, `applyInput(r, {x: 0, y: 1})`, and input.js turns a lift into a `tap` only
  // when the pointer has NOT dragged (|drag| < 8 px; that probe's drag is 60). So the
  // `if (r.tap) fire()` inside shell.update() never ran, the game sat on its start screen, and
  // every assertion below measured a paused game.
  //
  // Measured on the two generated builds that used our own shell: an island explorer failed 3
  // checks (no control moves the player, progress 0 -> 0, and a WRONG diagnosis that the bundle
  // was waiting for React Native) and a maze failed 5 -- including "the frame is not a blank
  // fill" and "the scene is bright enough to see", because nothing had rendered yet. The maze
  // then spent 15 edits and four check cycles fixing a game that was never broken. The only two
  // builds that passed first time were the two that did not use the shell at all.
  //
  // This runs BEFORE the frame capture below for that reason: photographing a start screen and
  // then reporting the renderer as blank is the same defect wearing a different name.
  const startGate = () => {
    const st = G.getState() || {};
    const flag = ['gameStarted', 'started', 'running', 'active', 'playing']
      .find((k) => st[k] === false);
    if (flag) return flag;
    return (typeof st.phase === 'string' && /idle|menu|ready|waiting|start/i.test(st.phase))
      ? `phase='${st.phase}'` : null;
  };
  // A TAP, not a drag: press with a ZERO vector, then lift -- the same code path a finger takes
  // through endPointer(). shellAction first where it exists, then every other region, because
  // createShell's actionRegion is configurable and the name must not be assumed.
  //
  // Factored out because dismissing ONCE is not enough. reset() is called seven times below, and
  // a scene whose reset re-shows its start screen is straight back behind it -- which is exactly
  // what a generated endless runner did, deliberately: "the checker needs to press the action
  // button to start fresh". Its very first run reported BOTH `the game can be started -- tapped
  // past phase='start'` AND `progress: 0 -> 0 (idle 0.00/s vs playing 0.00/s)`, because every
  // measurement after the first reset ran on a paused game. That cost two of its four check
  // rounds and roughly 3,900 credits on a game that already worked.
  const dismissStart = async () => {
    if (!startGate()) return true;
    const order = regions.slice().sort((a, b) => (b === 'shellAction') - (a === 'shellAction'));
    for (const r of order) {
      G.applyInput(r, { x: 0, y: 0 });
      await sleep(80);
      G.releaseInput(r);
      await sleep(320);
      if (!startGate()) break;
    }
    // STILL GATED? Then the start screen is not made of regions, and injection cannot reach it.
    //
    // HALF the generated builds on record -- 30 of 60 -- create their own full-screen DOM overlay
    // instead of using createShell's screens, so this was blind on half the population. The cost
    // was not a missed check but a broken game: an endless runner sat at phase 'start' for a whole
    // run, every control therefore read as dead, and the agent -- told only that no control moved
    // the player -- concluded the harness needed continuous input and added a second reader beside
    // its swipe handler. One finger swipe then moved two lanes, into an obstacle. Both builds on
    // record that read swipe AND input.sample name the checker in their own comments.
    //
    // A synthetic .click() fires whatever the element registered, addEventListener or onclick
    // alike, so it reaches the same handler a finger would. Prefer text that reads like a start
    // control, and click only a few: an exit or menu button would navigate the game away mid-run.
    if (startGate()) {
      const STARTISH = /\b(start|play|tap|begin|go|race|enter)\b/i;
      const cand = [...document.querySelectorAll('button, div, span, a')]
        .filter((el) => el.__hasClick || el.onclick)
        .filter((el) => {
          const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
          return b.width > 24 && b.height > 14 && cs.display !== 'none' && cs.visibility !== 'hidden';
        })
        .sort((a, b) => (STARTISH.test(b.textContent || '') ? 1 : 0)
                      - (STARTISH.test(a.textContent || '') ? 1 : 0));
      for (const el of cand.slice(0, 4)) {
        try { el.click(); } catch (e) {}
        await sleep(360);
        if (!startGate()) break;
      }
    }
    return !startGate();
  };

  // What the REAL pointer event out in Python found, before any injection touched this page.
  const fingerTap = window.__START_TAP__ || null;
  if (fingerTap && fingerTap.gate) {
    ck('the start screen can be tapped by a finger', !!fingerTap.cleared,
       fingerTap.cleared
         ? `a real click at ${fingerTap.spot ? `'${fingerTap.spot.region}'` : 'the drawn control'} `
           + `cleared ${fingerTap.gate}`
         : (!fingerTap.spot
            ? `getState() reports ${fingerTap.gate} and NOTHING IS DRAWN for a player to press. `
              + 'Every control in this game is an invisible hit area, so the harness can start it '
              + 'by injecting into a region and a person cannot start it at all. Draw the start '
              + 'button -- createShell(input, {screens, onAction}) does it, and its button is a '
              + 'real input region so both a finger and the checker can use it.'
            : `a real click at the centre of '${fingerTap.spot.region}' did NOT clear `
              + `${fingerTap.gate} -- it still reports ${fingerTap.after}. The button is drawn but `
              + 'a touch never reaches it. Something is covering it: a full-screen overlay needs '
              + 'pointer-events:none (createShell makes its overlays inert for exactly this '
              + 'reason), and an overlay set to pointer-events:auto MUST have its own click '
              + 'handler. Injection reaches this control and a finger does not, so every other '
              + 'check below passed on a game no player can start.'));
  }

  const gateBefore = startGate();
  if (gateBefore) {
    // Inject anyway, even when the finger check just failed: the rest of the run is worthless on
    // a paused game, and one accurate failure plus real data beats one failure and no data.
    await dismissStart();
    const gateAfter = startGate();
    ck('the game can be started', !gateAfter,
       gateAfter
         ? `getState() still reports ${gateAfter} after tapping every declared region `
           + `[${regions.join(', ')}]. Nothing below this line means anything: a game held on its `
           + 'start screen reports no movement, no progress and an empty frame. Two causes, and '
           + 'both are yours: the start button must be reachable as an input region -- '
           + 'createShell(input, {...}) does that for you, and the game loop must call '
           + 'shell.update() so the tap is read -- or the game is GATED on a message from React '
           + 'Native, which nothing here will ever send. A host message may CONFIGURE difficulty '
           + 'or PERSIST a high score; it must never decide whether the game starts. '
           + 'Do NOT branch the start on createBridge().isHosted: that makes the checker and the '
           + 'player run different code, and every check below then measures a path no player takes. '
           + 'A shipped runner did exactly that and passed 18/18 on code the phone never runs.'
         : `tapped past ${gateBefore}`);
  }

  // Photograph the game at several points and judge the BEST frame. Every checked state is
  // reachable by a player, so if any one of them renders properly the renderer works -- and
  // a game that is genuinely blank is blank in all of them.
  //
  // One frame at a fixed moment is fragile in both directions. The checks below deliberately
  // shove the game into awkward corners, and a first-person scene came out of them aimed at
  // the sky: capturing at the end gave a flat blue rectangle, and moving the capture earlier
  // just caught it mid-look instead, because probing the 'look' region pitches the camera up.
  // Resetting first does not help either -- a game exposing no reset() stays where it was
  // left. The saved screenshot is for a human to judge lighting, camera and controls, so it
  // has to be a view worth looking at.
  const frames = [];
  try { if (G.captureFrame) frames.push(G.captureFrame()); } catch (e) {}

  // A FILMSTRIP, not a snapshot. Every check in this file reduces a moving, interactive thing
  // to a boolean, and then hands over ONE still frame chosen for having the most colours in it.
  // That is the wrong shape of evidence for the defects that keep surviving to the device: a
  // countdown that never clears, a knob that never moves, steering that turns the wrong way, a
  // prop the size of a house. Each is obvious in a second of watching and invisible in any one
  // frame. So capture at LABELLED moments through the drive and compose them into one image.
  // Two adjacent frames that should differ and do not are a freeze; a car leaning left under a
  // frame labelled RIGHT is mirrored. Neither is a threshold, so neither can be passed by
  // damaging the game -- the failure mode every scalar gate in this file has already had.
  // The control MEASURED to turn the player. The filmstrip needs it: without it, frame 5
  // pushed x on the throttle, which a GAS button ignores, so the tile captioned
  // "steering RIGHT" showed a car driving dead straight -- a caption certifying steering
  // it never applied, which is worse than having no tile at all.
  // Set where the progress check discovers the game published no objective positions. The
  // harness then has nowhere to steer, so the frames it captures are whatever it drove into
  // -- which makes a brightness reading a reading of that, not of the game.
  let blindDrive = false;
  // Set by the stuck check when the harness spent most of a drive jammed against geometry.
  let wedged = false;
  let steerFrame = null;
  const strip = [];
  const filmSnap = (label) => {
    // One frame per label. dismissStart() is called from reset() as well, and reset() runs
    // before every region probe, so without this the strip came back as six identical
    // "after tapping START" tiles that crowded out the frames the sequence exists for.
    try {
      if (!G.captureFrame || strip.length >= 8) return;
      if (strip.some((f) => f.label === label)) return;
      const u = G.captureFrame();
      if (u) strip.push({ label: label, url: u });
    } catch (e) {}
  };
  filmSnap('1. loaded');

  // The contract: a game reports the actor's `pos` as [x, y, z]. Everything below
  // that matters is judged on THAT, not on every number in getState() -- an earlier
  // version diffed every field and reported suspension jitter and settling crates as
  // "the control never released", while a button press "responded" because something
  // unrelated twitched. A check that cries wolf is worse than no check.
  const posOf = () => { const s = G.getState() || {}; return Array.isArray(s.pos) ? s.pos : null; };
  const dist = (a, b) => Math.hypot(b[0] - a[0], (b[1] ?? 0) - (a[1] ?? 0), (b[2] ?? 0) - (a[2] ?? 0));

  /** Screen-space points the game publishes, e.g. screen: { coin0: picker.project(...) }.
   *  Shared by the region check (which taps them) and the progress check (which walks
   *  toward them). Hoisted here because it was only wired into the first one -- the
   *  progress message TELLS a game to publish these, a generated island game did exactly
   *  that, and the check ignored them and failed it anyway. Four runs failed that way. */
  //  onScreenOnly: TAPPING needs a point inside the viewport -- inject() refuses anything
  //  else. STEERING does not: the thing you are walking toward is usually off screen, which
  //  is exactly why the first version of this found nothing. A coin-collection game published
  //  `picker.project` positions for all 20 coins and homing still never engaged, because at
  //  the moment of sampling none of them happened to be within the viewport.
  const screenTargets = (onScreenOnly) => {
    const pts = [];            // NOT named `out`: that is the driver's result object
    const W = window.innerWidth, H = window.innerHeight;
    try {
      (function walk(v, depth, key) {
        if (!v || typeof v !== 'object' || depth > 4 || pts.length > 7) return;
        // A pixel position, not a normalised direction vector: the latter is also {x, y}
        // but never more than 1 unit from the origin, so the magnitude test excludes it.
        const looksLikePixels = typeof v.x === 'number' && typeof v.y === 'number'
          && Math.abs(v.x) > 2 && Math.abs(v.y) > 2
          && Math.abs(v.x) < W * 4 && Math.abs(v.y) < H * 4;
        if (looksLikePixels) {
          // A point BEHIND the camera projects to a garbage pixel position -- and not
          // harmlessly off screen: it can land INSIDE the viewport with its sign flipped.
          // project() reports NDC z, and z > 1 means behind the eye. Measured: a coin at
          // (18, -22) behind the player reported x=1358 z=1.016, and steering at it turned
          // the harness away from every coin that was actually in front. Where a game
          // publishes {x, y} with no z, nothing can be concluded, so the point is kept.
          const behind = typeof v.z === 'number' && v.z > 1;
          const inside = !behind && v.x > 2 && v.y > 2 && v.x < W && v.y < H;
          if (inside || !onScreenOnly) pts.push({ key, x: v.x, y: v.y, inside, behind });
        }
        for (const k in v) walk(v[k], depth + 1, key ? key + '.' + k : k);
      })(G.getState() || {}, 0, '');
    } catch (e) {}
    // Lowest on screen first: in a ground-level view, nearer things sit further down, so
    // this is a cheap stand-in for "closest objective" without knowing the game's units.
    pts.sort((a, b) => b.y - a.y);
    return pts;
  };

  // What KIND of game is this? Declared, never inferred. A tower defence reports a pos of
  // [0,0,0] that nothing uses, so "does a control move the player" and three other avatar
  // checks failed a perfectly working game. Inferring "nothing moved, so it must be a
  // placement game" would be worse: it would silently reclassify a genuinely broken
  // avatar game as fine, which is the parkour failure wearing a different hat.
  // Back to a known state before anything precise. Without it, direction and grounding
  // were measured on a car wedged against a rock by an earlier check.
  const reset = async () => {
    if (G.reset) { G.reset(); await sleep(2500); }
    // A reset that re-shows the start screen must not leave the game behind it.
    if (typeof dismissStart === 'function') await dismissStart();
    filmSnap('2. after tapping START');
  };
  // DID THE GAME END WHILE WE WERE DRIVING IT?
  //
  // An endless runner dies when it hits an obstacle, and this harness pokes rather than plays,
  // so it dies. Everything measured after that moment is measured on a STOPPED game -- and this
  // checker already had the fact and threw it away: it found `gameOver`, printed "PASS the end
  // of the game is observable in the bundle via 'gameOver'", and then asserted that the controls
  // move nothing and progress cannot rise. Measured on a generated neon runner: progress rose at
  // 6.00/s while idle and 0.00/s while driven -- proof the game worked and the drive killed it.
  // It cost 16 edits over 5 check cycles, and three of those cycles went on a brightness
  // regression the agent introduced while rewriting controls that were never broken.
  // Returns WHICH field says the game ended, so a message can name it. `endField` above is
  // scoped to its own block and is not visible here; asking the state directly also survives a
  // game that reports more than one of these.
  const endedBy = () => {
    const st = G.getState() || {};
    for (const k of ['gameOver', 'dead', 'lost', 'finished']) if (st[k] === true) return k;
    if (st.alive === false) return 'alive';
    if (typeof st.phase === 'string' && /over|dead|lost|won|finish|complete|end/i.test(st.phase)) {
      return `phase='${st.phase}'`;
    }
    return null;
  };
  const ended = () => endedBy() !== null;
  if (!G.reset) sk('measurements from a known state', 'the game exposes no reset() to attachDiagnostics');

  const view = (G.getState() || {}).view;
  if (!view) sk('game shape declared',
    "getState() reports no view: 'avatar' | 'firstPerson' | 'vehicle' | 'onRails' | 'placement'");

  // Can the END of the game be seen from inside the bundle? The celebration screen may live in
  // React Native -- native transitions, safe areas and the router make it the better place, and
  // two generated games chose it. But the FACT that the game ended has to be observable here,
  // because the handoff is a JSON string across a WebView boundary that nothing type-checks:
  // one build shipped `{type, payload}` while the app read the field at the top level, and
  // caught it by reading its own code rather than by any test. If that mismatch survives, the
  // game ends and nothing happens -- the player sits on a frozen screen. Publishing one field
  // costs nothing and makes the game's half of that seam checkable.
  {
    const st0 = G.getState() || {};
    const endField = ['phase', 'alive', 'gameOver', 'won', 'lost', 'dead', 'finished']
      .find((k) => k in st0);
    if (!endField) {
      sk('the end of the game is observable in the bundle',
         'getState() publishes no terminal field (phase / alive / gameOver / won), so whether this '
         + 'game can END cannot be checked here at all -- only whether it starts. If React Native '
         + 'renders the end screen, report the terminal state too.');
    } else {
      ck('the end of the game is observable in the bundle', true, `via '${endField}'`);
    }
  }
  // 'vehicle' is judged like an avatar -- it has a position, a heading and controls -- but two
  // assertions written for a person on foot do not apply to it: a car coasts after you release
  // the throttle, and a car on a closed circuit meets a barrier if you hold the accelerator and
  // never steer, which is all this harness can do. Racing declared 'avatar' because there was
  // nowhere else to be, and paid 2.5M compute and a self-steering car for it.
  const avatarDriven = view
    ? (view === 'avatar' || view === 'firstPerson' || view === 'vehicle')
    : !!posOf();
  // WHICH SIDE the camera is on is a different question from whether the player drives the
  // actor, and tying them together left a hole. `avatarDriven` excludes onRails, so a runner --
  // which absolutely does have a camera sitting behind a player -- was never camera-checked, and
  // not even skipped: the check produced no line at all. Placement is the only shape with no
  // actor to be behind.
  // firstPerson is excluded BY DECLARATION, not by the numeric guard inside the check. The
  // camera IS the player, so "which side is it on" has no answer -- and relying on the
  // degenerate projection to skip it only worked while the actor's reported pos coincided
  // exactly with the eye. Walk for three seconds and it does not, so the check began failing a
  // scene that had passed for weeks. Placement has no actor to be behind at all.
  const hasChaseCamera = view ? (view !== 'placement' && view !== 'firstPerson') : !!posOf();
  // Progress applies to every genre EXCEPT one a generic harness cannot drive.
  const canCheckProgress = view !== 'placement';

  // Did anything the game REPORTS change? Numbers by magnitude, everything else by whether it
  // moved at all -- judging only numeric fields made a working board game look dead, because
  // selecting a piece sets `selected` from null to a name and most of what a tap does is
  // categorical like that.
  const snap = (s) => {
    const nums = {}, tags = {};
    for (const k in s) {
      const v = s[k];
      if (typeof v === 'number') nums[k] = v;
      else if (Array.isArray(v) && v.every((e) => typeof e === 'number')) v.forEach((e, i) => { nums[k + i] = e; });
      else tags[k] = JSON.stringify(v);
    }
    return { nums, tags };
  };
  const deltas = async (act) => {
    const a = snap(G.getState() || {});
    if (act) await act();
    await sleep(700);
    const b = snap(G.getState() || {});
    const d = { nums: {}, signed: {}, moved: [], mirror: [] };
    for (const k in b.nums) {
      d.nums[k] = Math.abs((b.nums[k] ?? 0) - (a.nums[k] ?? 0));
      d.signed[k] = (b.nums[k] ?? 0) - (a.nums[k] ?? 0);
      // A field that only ever holds 0 or 1 is a FLAG, and a flag that flips when a button is
      // pressed is very often the button reported straight back. See the note on `stirred`.
      const va = a.nums[k], vb = b.nums[k];
      if ((va === 0 || va === 1) && (vb === 0 || vb === 1)) d.mirror.push(k);
    }
    for (const k in b.tags) if (b.tags[k] !== a.tags[k]) d.moved.push(k);
    return d;
  };
  // Compared against IDLE on both halves. A first version tested `d.moved.length > 0` outright
  // and passed a button wired to nothing, because a scene that publishes `screen:` re-projects
  // its objectives every frame -- so a non-numeric field always differs between two samples and
  // everything looked alive. Evidence has to be change the control caused, not change the game
  // makes on its own.
  // ...and the evidence has to be an EFFECT, not the button reporting itself. Two generated racing
  // games failed `control 'brake' does something` and both fixed it the same way: a `braking` flag
  // added to getState that mirrors the button --
  //     let braking = false;  braking = brkHeld;  ...  braking: braking ? 1 : 0,
  // -- which flips 0 -> 1 the instant it is pressed, even at rest. That satisfied the rest half, so
  // the moving half below (hold the throttle, take a baseline WHILE moving, then brake against it
  // -- the only test that can actually prove a brake works) never ran. A brake wired to nothing
  // would have passed identically.
  //
  // So 0/1 flag fields are excluded from the evidence. A control that affects the game moves a real
  // quantity: position, speed, angle, score, height. The known cost is a control whose only effect
  // is a flag with no numeric consequence -- a lights toggle -- which must now show its effect some
  // other way. That is the right trade: this check exists to prove the control does something to
  // the GAME, and a flag equal to the button does not.
  const stirred = (d, idle) => d.moved.some((k) => !idle.moved.includes(k))
    || Object.keys(d.nums).some((k) => !d.mirror.includes(k)
                                      && d.nums[k] > Math.max(1e-3, (idle.nums[k] ?? 0) * 3));

  if (view && !avatarDriven) {
    // These genuinely do not apply on rails: an auto-runner never stops, never gets stuck,
    // cannot leave the track, and always faces forward.
    for (const n of ['releasing brings the player to a stop',
                     'never stuck while the control is held', 'the player cannot fall out of the world',
                     'movement follows the actor facing', 'the actor is on the surface']) {
      sk(n, `view is '${view}' -- there is no player avatar to check`);
    }

    // But "a control moves the player" DOES apply, and skipping it has now cost two device
    // bugs. The note below already recorded the first: a lane runner "skipped six checks for
    // having no avatar, and its real bug -- a player oscillating 0.3 m at the outer lanes --
    // sat in a state the harness had no way to reach". The second was reported from a phone as
    // "if we swipe right, its going left": LANE_X = [-2, 0, 2] labelled left-to-right while the
    // camera faced +Z, which makes +X screen-LEFT. An on-rails player still has a position and
    // still moves sideways, so both are checkable -- in SCREEN space, the only frame where
    // "swiped right, went right" is even expressible.
    if (posOf() && G.screenOf && regions.length) {
      let moved = 0, rightOk = null, detail = '';
      // TWO ATTEMPTS, the whole sweep each time -- what the avatar path does, and why it works.
      // A first version put a cheap "is anything awake" probe BEFORE the real loop. It swiped right
      // to test for life, left the player at lane 2, and the real right-swipe then clamped at the
      // edge and read zero while the left-swipe arrived after the runner had died: measured as
      // [track/right dx=0 ph=playing] [track/left dx=0 ph=gameover] on a game whose swipe gave
      // +128 px in isolation. A pre-probe that consumes the state the measurement needs cannot
      // work. The wait covers a game still counting down -- one runner gated input for 3.2 s, read
      // as having no working control, and its agent believed that and added a second input reader,
      // which made one finger swipe move two lanes.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) {
          await sleep(3600);
          if (ended && ended()) await reset();
          moved = 0; rightOk = null; detail = '';
        }
      for (const r of regions) {
        for (const [dir, vx] of [['right', 1], ['left', -1]]) {
          // START EACH PROBE ALIVE, and read the result before the game can end.
          //
          // This is an on-rails game: it runs into things. Swiping blind walks it into an
          // obstacle within a second, and once it is dead nothing moves -- so the check reported
          // "no declared region moved the player sideways on screen at all" about a control that
          // works perfectly. Measured on the runner that shipped broken: one injected swipe took
          // it from lane 1 to lane 2 and x 0 to 1.499, and left phase 'gameover'. The agent read
          // the failure, concluded the harness needed continuous input, and added a second reader
          // beside its swipe handler -- one finger swipe then moved two lanes.
          // NO reset() HERE. It was added to recover from an on-rails death mid-probe, and it
          // guaranteed the opposite: reset() calls dismissStart(), which taps START, which begins
          // the game's countdown again -- so every direction was then measured DURING a fresh 3.2 s
          // countdown and read zero. Only one direction has to register for this check, so a single
          // wake-up before the loop is enough and a death part-way through costs nothing.
          const p0 = posOf().slice();
          const before = G.screenOf(p0);
          G.applyInput(r, { x: vx, y: 0 });
          await sleep(150);
          G.releaseInput(r);
          // Short settle: long enough for a lane change to land, short enough that an endless
          // runner has usually not run into something.
          await sleep(700);
          const p1 = posOf().slice();
          const after = G.screenOf(p1);
          if (!before || !after) continue;
          // MEASURE THE AXIS, NOT THE ACTOR. A chase camera follows the player, so it absorbs
          // most of the movement: a full lane change on a shipped runner moved the player 1.5
          // world units and only 9 screen pixels, against an 8 px bar -- a verdict decided by
          // one pixel. Project the world displacement instead and ask which way it points on
          // screen, by projecting the same displacement from a fixed point. That is convention
          // -free (no assumption that +X is screen-right) and immune to the camera moving,
          // which is what made the actor's own screen motion useless here.
          const wdx = p1[0] - p0[0], wdz = p1[2] - p0[2];
          let dx = after.x - before.x;
          if (Math.hypot(wdx, wdz) > 0.2) {
            const a0 = G.screenOf(p0);
            const a1 = G.screenOf([p0[0] + wdx, p0[1], p0[2] + wdz]);
            if (a0 && a1) dx = a1.x - a0.x;
          }
          if (Math.abs(dx) > 8) {
            moved = Math.max(moved, Math.abs(dx));
            const ok = dir === 'right' ? dx > 0 : dx < 0;
            rightOk = rightOk === false ? false : ok;
            detail += `${r}/${dir}: screen x ${dx > 0 ? '+' : ''}${dx.toFixed(0)}px  `;
          }
        }
      }
        if (moved > 8) break;
      }
      ck('a control moves the player', moved > 8,
         moved > 8 ? detail.trim()
           : 'no declared region moved the player sideways on screen at all. '
             // WHY THIS MESSAGE IS THIS LONG. Three builds have read the bare symptom and drawn the
             // same wrong conclusion -- "the checker injects HELD input and my game only reads
             // one-shot swipe, so I must also read a held drag" -- and added a second reader beside
             // their swipe handler. A real finger then fires BOTH: input.sample() crosses its
             // deadzone during the drag, and reg.swipe fires on release. Measured on a shipped
             // runner: one swipe left took the player from lane 2 to lane 0. The trigger differed
             // each time (a custom start overlay, then a 3.2 s countdown) but the message and the
             // wrong fix were identical, so the message is what has to change.
             + 'The harness produces REAL SWIPES, not held drags: releasing an injected drag calls '
             + 'the same swipeFrom() a finger does, so reg.swipe fires for it. Do NOT add a second '
             + 'reader watching input.sample() alongside your swipe handler -- a real finger fires '
             + 'BOTH and one swipe becomes two lane changes. Three builds have done this and two '
             + 'shipped the bug. If nothing moved, the game was not PLAYABLE when this ran rather '
             + 'than deaf to input: a countdown gating input, a start screen this could not '
             + 'dismiss, or an on-rails player dying mid-probe. Report `phase` from getState() so '
             + 'the harness can wait for it.');
      if (moved > 8) {
        ck('swiping right moves the player right on screen', rightOk === true,
           detail.trim() + (rightOk ? '' : ' -- MIRRORED. The world axis your lanes sit on is not '
             + 'screen-left-to-right for this camera; use laneDelta(camera, dir) from core/motion.js, '
             + 'which derives the sign from the camera instead of assuming +X is screen-right.'));
      }
    } else {
      sk('a control moves the player', `view is '${view}' and getState() reports no pos to track`);
    }
    // What IS checkable without knowing the rules: does injecting into a declared region
    // change the game MORE than doing nothing for the same length of time?
    //
    // The old version of this only asserted that applyInput did not throw, which a game
    // passes by registering a region it never reads. A lane runner did exactly that: it
    // declared 'swipe' to the core input system while handling swipes on its own raw
    // pointermove listener, so every injected input went nowhere. It scored a pass here,
    // skipped six checks for having no avatar, and its real bug -- a player oscillating
    // 0.3 m at the outer lanes -- sat in a state the harness had no way to reach.
    //
    // "Change" means numbers AND everything else. Judging only numeric fields made a working
    // board game look dead: selecting a piece sets `selected` from null to a NAME, and most
    // of what a tap does is categorical like that. Numbers are compared by magnitude against
    // the idle baseline; everything else by whether it moved while idle left it alone.
    // snap/deltas are defined above the branch, because BOTH shapes of game need them: this
    // one to tell a live region from a decorative one, and the avatar branch to tell a dead
    // labelled button from one that simply does not move the player.
    let regionsThatResponded = 0;
    for (const r of regions) {
      let threw = false, beat = null;
      try {
        const idle = await deltas(null);
        // Taps AND a drag, because a region is driven by one or the other and the harness
        // cannot know which: a tap places a piece, a drag steers. And a spread of taps
        // rather than only the centre, because a game that picks 3D objects responds to
        // WHERE you tap -- one tap in the middle of a full-screen board hit empty space and
        // read as a dead control. The grid needs no knowledge of the game at all.
        const GRID = [[0.5, 0.5], [0.25, 0.35], [0.75, 0.35], [0.25, 0.65], [0.75, 0.65],
                      [0.5, 0.3], [0.5, 0.7], [0.35, 0.5], [0.65, 0.5]];
        // Aim FIRST at any screen-space point the game publishes. A blind grid cannot hit a
        // small 3D object: nine taps all missed a board piece sitting at (322, 137), and the
        // scene had been projecting that exact coordinate into getState the whole time --
        // `project()` exists in core/pick.js precisely so a checker can aim a tap. Where the
        // game names a target, tapping it and measuring the result is a real check: a made-up
        // coordinate outside the declared region is refused, and one that hits nothing fails.
        const aimed = screenTargets(true);   // tapping: must be inside the viewport

        const probes = [
          ...aimed.map((px, i) => [`tapped published target ${i + 1}`, async () => {
            G.applyInput(r, { x: 0, y: 0, atPx: px });
            await sleep(120);
            G.releaseInput(r, { atPx: px });
          }]),
          ...GRID.map(([u, v], i) => [`tapped ${i + 1}/9`, async () => {
            G.applyInput(r, { x: 0, y: 0, at: { u, v } });
            await sleep(120);
            G.releaseInput(r, { at: { u, v } });
          }]),
          ['dragged', () => G.applyInput(r, { x: 1, y: 1 })],
        ];
        for (const [how, act] of probes) {
          const driven = await deltas(act);
          G.releaseInput(r);
          for (const k in driven.nums) {
            if (driven.nums[k] > (idle.nums[k] ?? 0) * 3 + 1e-4) {
              beat = `${how}: ${k} moved ${driven.nums[k].toFixed(3)} vs ${(idle.nums[k] ?? 0).toFixed(3)} idle`; break;
            }
          }
          // A field that changed under input and held still while idle is a response.
          if (!beat) {
            const fresh = driven.moved.filter((k) => !idle.moved.includes(k));
            if (fresh.length) beat = `${how}: ${fresh.join(', ')} changed (steady while idle)`;
          }
          if (beat) break;
        }
      } catch (e) { threw = true; }
      // A FAIL here was wrong, and the record says so: across 8 recorded builds this
      // caught 0 real defects and false-failed 1 working game. A tower defence needs a
      // tower picked from its DOM toolbar BEFORE a board tap means anything, so the
      // harness's taps correctly did nothing -- and the check announced the game's
      // controls were dead. It cannot tell "this region is never read" from "the harness
      // could not complete this interaction", and only one of those is the game's fault.
      //
      // So it reports reduced COVERAGE instead of a verdict. The information survives --
      // a runner that declared a region it never read is still visible here -- without
      // asserting a conclusion the harness is not entitled to.
      if (threw) {
        ck(`region '${r}' accepts input without throwing`, false, 'applyInput threw');
      } else if (beat) {
        regionsThatResponded += 1;
        ck(`region '${r}' responds to input`, true, beat);
      } else {
        sk(`region '${r}' responds to input`,
           'no reported value moved more than it does when idle. Either the game never reads '
           + 'this region, or the interaction needs a step the harness cannot perform (picking '
           + 'from a DOM menu first, aiming at an object it cannot locate). Nothing that '
           + 'depends on driving this region was verified');
      }
      await sleep(300);
    }
    // ONE dead region is reduced coverage. EVERY region dead is an unplayable game, and that
    // verdict the harness IS entitled to. A generated endless runner declared a single
    // full-screen 'swipe' region, never sampled it (it wired raw canvas listeners instead),
    // and drew a full-screen start overlay with no pointer-events:none that swallowed every
    // real touch. On a device it sat on its title screen forever. This check saw the dead
    // region and called it a SKIP, so 9/10 passed and it shipped.
    // Placement games are excluded UNLESS they told us where to tap. A board game whose
    // interaction starts with a DOM menu the harness cannot operate would legitimately show
    // every region as dead, and failing that is failing a working game. Where the scene
    // published `screen:` positions it HAS told us where to tap, so silence there is real.
    const placementWithoutTargets = view === 'placement' && screenTargets(true).length === 0;
    if (regions.length && regionsThatResponded === 0 && !placementWithoutTargets && ended()) {
      // The game ENDED while the regions were being probed, so of course nothing moved. Say
      // that, and do not accuse the controls: an endless runner that this harness poked into
      // an obstacle came out of here with "all 1 declared region(s) [track] left every reported
      // value unchanged" on a game whose controls were fine.
      sk('at least one declared region does something',
         `the game ENDED while it was being driven (getState() reports ${endedBy()}), `
         + 'so every region was probed on a stopped game. Nothing about the controls was '
         + 'established either way. If this game can end in a few seconds of unskilled play, '
         + 'expose reset() to attachDiagnostics so the harness can measure from a live state.');
    } else if (regions.length && regionsThatResponded === 0 && !placementWithoutTargets) {
      ck('at least one declared region does something', false,
         `all ${regions.length} declared region(s) [${regions.join(', ')}] left every reported `
         + 'value unchanged, so nothing the player can touch has any effect. Either the scene '
         + 'never samples the regions it declared (check input.sample/input.region is actually '
         + 'called for each one), or a full-screen DOM overlay is swallowing input -- an overlay '
         + 'covering the canvas needs pointer-events:none, or a real tap handler of its own.');
    }
    if (!canCheckProgress) {
      sk('the player can make progress',
         `view is '${view}' -- advancing it needs game-specific actions (selecting, placing, starting a wave) that a generic harness cannot perform`);
    }
  }

  // pos used to be REQUIRED, which was an assumption smuggled in from the two games in
  // front of me at the time. A lane runner's meaningful state is lane and distance; a
  // board game's is which piece moved where; a tower defence has no player at all. All
  // three are legitimate 3D games and all three failed a contract they never needed.
  if (avatarDriven && !posOf()) {
    for (const n of ['a control moves the player', 'releasing brings the player to a stop',
                     'never stuck while the control is held', 'the player cannot fall out of the world']) {
      sk(n, 'getState() reports no pos -- this game has no single moving player');
    }
  } else if (avatarDriven) {
    // Which region drives movement? Ask, rather than assume the first one is a stick:
    // a brake or a boost button legitimately moves nothing on its own.
    let mover = null, best = 0;
    let quiet = [];
    let warmed = 0;

    // WAIT FOR THE GAME TO BECOME PLAYABLE BEFORE MEASURING ANY CONTROL.
    //
    // "no region moved the player at all" and "progress: 0 -> 0" are the two commonest build-1
    // failures in this project -- thirteen of twenty-four across ten builds -- and they rarely
    // mean the controls are dead. They mean the game was not playable yet. The hard case reports
    // nothing wrong: a generated racing build ran a 3-2-1 countdown that returned early from its
    // step function while `shell.report()` still published `phase: 'playing'`, so no start gate
    // existed to detect and every control read as dead. Seven build-1 failures, one cause.
    //
    // A countdown starts when the start screen is DISMISSED, which is the instant probing begins,
    // so it poisons the regions probed first and clears before the ones probed last -- the run
    // comes back with a working control named dead. Waiting for the first sign of life before
    // measuring anything puts every region on the same playable footing.
    //
    // Cheap when the game is already live (one ~1 s probe) and bounded at ~6 s when it never
    // responds -- a placement game moves no avatar at all, and a brake-first region list has a
    // legitimate reason to sit still, so failing to warm up is not a verdict, just a fall-through.
    for (let i = 0; i < 6; i++) {
      await reset();
      const a0 = posOf();
      G.applyInput(primary, { x: 0, y: 1 });
      await sleep(700);
      const d0 = dist(a0, posOf());
      G.releaseInput(primary);
      await sleep(300);
      if (d0 > 0.05) { warmed = i; break; }
      await sleep(1000);
    }

    // PROBE, and if NOTHING responded, wait and probe again before believing it.
    // Backstop for the case the warm-up cannot see: a countdown running while `primary` is a
    // control that legitimately moves nothing, so there was never a sign of life to wait for.
    //
    // "at least one control actually moves the player -- no region moved at all" and its twin
    // "progress: 0 -> 0" are the two most common build-1 failures in this project: thirteen of
    // twenty-four across ten builds. Almost none of them meant the controls were dead. They meant
    // the game was not PLAYABLE YET -- and the worst case is invisible, because the game says it
    // is fine: a generated racing build ran a 3-2-1 countdown that returned early from its step
    // function while `shell.report()` published `phase: 'playing'`, so there was no start gate to
    // detect and every control read as dead. Seven build-1 failures, one cause.
    //
    // A countdown expires. A dead control does not. So when the first pass finds literally
    // nothing, wait and take one more pass rather than reporting a working game as broken.
    const probeAll = async () => {
      let m = null, b = 0; const q = []; const seen = []; const blind = []; const deltas = [];
      for (const r of regions) {
      // Measure every region from the SAME state. Without this each probe starts wherever the
      // previous one left the actor and the readings stop being comparable: on an oval circuit
      // with barriers, holding a STEER button rotates the car into the wall and the push-out
      // slides it 5.16 m, while the throttle probed afterwards found the car aimed at that wall
      // and managed 0.30 m. The checker then named the steering button as the control that moves
      // the player and judged "forward" on it, reporting alignment 0.19 on a car whose throttle
      // was perfect. A vehicle with steer buttons is exactly the shape of game this matters for,
      // and it is the shape that ran 62 minutes without converging.
      await reset();
      const a = posOf();
      const before0 = G.getState() || {};
      G.applyInput(r, { x: 0, y: 1 });
      // Visibility is read WHILE the region is being driven. Read afterwards it would
      // condemn every control that correctly hides itself once used -- a start button most
      // of all -- and the thing worth knowing is narrower than "is it hidden now": did the
      // harness reach a conclusion through a control no finger could have touched?
      const vis = G.boundVisibility ? G.boundVisibility() : {};
      if (vis[r] === false) blind.push(r);
      await sleep(1100);
      const d = dist(a, posOf());
      G.releaseInput(r);
      await sleep(900);
        seen.push({ r, d });
        // The SIGNED change in every numeric field this region caused, so two controls doing
        // the same job can be told apart from two doing opposite jobs.
        const after = G.getState() || {};
        const fd = {};
        for (const k of Object.keys(after)) {
          if (typeof after[k] !== 'number' || typeof (before0 || {})[k] !== 'number') continue;
          const dv = after[k] - before0[k];
          if (Math.abs(dv) > 1e-6) fd[k] = dv;
        }
        deltas.push({ r, d, d2: fd });
        if (d > b) { b = d; m = r; }
        if (d < 0.05) q.push(r);
      }
      return { mover: m, best: b, quiet: q, seen, blind, deltas };
    };

    let probe = await probeAll();
    if (probe.best === 0) {
      await sleep(4500);          // a countdown, an intro pan, a spawn animation -- let it finish
      warmed = 1;
      probe = await probeAll();
    }
    for (const { r, d } of probe.seen) {
      ck(`region '${r}' is wired and does not throw`, true,
         `moved ${d.toFixed(2)} m` + (warmed ? ' (on a second pass, after waiting for the game to become playable)' : ''));
    }
    mover = probe.mover; best = probe.best; quiet = probe.quiet;

    if (mover) primary = mover;          // measured, not guessed
    pickForward(mover);                  // declared, not measured -- see FWD_NAME above
    ck('at least one control actually moves the player', best > 0.5,
       mover ? `'${mover}' moved it ${best.toFixed(2)} m` : 'no region moved the player at all');

  // CREATED IS NOT WIRED. A racing build called createSolids(), registered every building and
  // every rival car, and never called resolve() once. The player drove through all of it, and
  // the run passed 32 of 32 checks -- because nothing distinguished a collision system that
  // exists from one that runs. The modules count their own feeds, so this is a fact, not a
  // heuristic: shapes registered and zero resolves is a system that is switched off.
  if (typeof G.engineUse === 'function') {
    const use = G.engineUse() || {};
    const dead = [];
    for (const s of (use.solids || [])) {
      if (s.shapes > 0 && s.resolves === 0) dead.push(`createSolids has ${s.shapes} shape(s) registered and resolve() was never called`);
    }
    for (const c of (use.contacts || [])) {
      if (c.items > 0 && c.steps === 0) dead.push(`createContacts has ${c.items} item(s) registered and step() was never called`);
    }
    // items > 0, matching solids (shapes > 0) and contacts (items > 0). The first version said
    // items > 1, reasoning that a single body has nothing to separate against -- true in
    // isolation, and it exempted the LIKELIER mistake: registering the player because that is
    // the obvious first line, then never looping over the rivals. One body and zero separations
    // is a registry that is switched off, whatever the count.
    for (const b of (use.bodies || [])) {
      if (b.items > 0 && b.separations === 0) dead.push(`createBodies has ${b.items} registered ${b.items === 1 ? 'body' : 'bodies'} and separate() was never called -- call bodies.separate() once a frame AFTER every actor has moved${b.items === 1 ? ', and note that ONE registered body is its own bug: the player was added and the rivals were not' : ''}`);
    }
    if (dead.length) {
      ck('collision and pickups are actually running, not just created', false,
         dead.join('; ') + '. A module constructed and then starved looks like working collision '
         + 'in the source and is nothing at all at runtime. Every one of them needs feeding EVERY '
         + 'frame, after the actor has moved: solids.resolve(pos, radius, PREVIOUS) and '
         + 'contacts.step(wasAt, pos) both take where the actor WAS, because at speed the '
         + 'interesting thing happened between the two positions; bodies.separate() takes nothing '
         + 'and must run after every actor has already moved this frame.');
    }
  }

    // Every measurement below is only worth what the control it came through is worth. A tower
    // defence bound its turret cards inside show() and only set display:none in hide(), never
    // unbinding -- so the harness drove `buy_splash`, reported it as responding, and passed
    // "every drawn control can be pressed by a finger" with a shop the player never saw. The
    // region was live, the element was not, and nothing noticed. Bound regions are now gated on
    // visibility for a finger; injection deliberately is not, because the seam has to keep
    // working -- so this is the check that closes the gap.
    if (probe.blind && probe.blind.length) {
      ck('the harness did not drive a control a finger cannot see', false,
         `region(s) [${probe.blind.join(', ')}] were driven while the element they are bound to `
         + 'was NOT visible, so anything measured through them describes a control the player '
         + 'cannot reach. Either draw the control whenever it is live, or stop binding it while '
         + 'it is hidden -- bindRegionToElement() now reads the element live, so a hidden '
         + 'element is untouchable by a finger and a stale rect can no longer swallow taps '
         + 'meant for the board. If the control is meant to appear only in context, something '
         + 'PERSISTENT must tell the player it exists: attachControls(input, {shelf: [...]}) '
         + 'draws a row that is always on screen and owns its own hit areas.');
    }

    // Every control the player can see must DO something. Until now only "at least one" was
    // asserted, so a game could draw a labelled button that fires nothing and still pass: an
    // island explorer shipped a JUMP button reported here as `moved 0.00 m` and scored 26/26,
    // and only a device found it.
    //
    // Judged in two phases, because moving the player is not the only legitimate effect and
    // pressing a control at a standstill is not a fair test of it. A brake changes nothing from
    // rest; a boost changes nothing from rest; both change something while the stick is held.
    // So a control fails only if NOTHING it reports changes in either situation -- which is
    // exactly the dead-button case and not the modifier case.
    // Only DRAWN, LABELLED buttons are judged. attachControls tags each one with data-region;
    // a bare hit area is not judged, because a look region's only effect is on the picture and
    // nothing it does shows up in getState(). starter's working camera control was failed three
    // times by earlier versions of this check for exactly that reason.
    let buttonRegions = [];
    try {
      // The shell's action button is excluded: it only does anything while a screen is up,
      // and by the time this runs the screen has been dismissed, so it would always read as
      // dead. It is verified far more strongly by a REAL pointer event above --
      // 'the start screen can be tapped by a finger'.
      buttonRegions = Array.from(document.querySelectorAll('[data-region]:not([data-shell-action])'))
        .filter((e) => (e.textContent || '').trim().length > 0)   // labelled, not a bare base
        .map((e) => e.dataset.region);
    } catch (e) { buttonRegions = []; }
    for (const r of quiet) {
      if (r === mover) continue;
      if (!buttonRegions.includes(r)) {
        sk(`control '${r}' does something`,
           `'${r}' is a hit area, not a drawn labelled button -- a look or drag region can `
           + 'legitimately affect only the picture, which getState() cannot show');
        continue;
      }
      // Try every gesture a region might be driven by, not just a forward push. A LOOK region
      // reads x for yaw and ignores y entirely, so a single vertical push called starter's
      // working camera control dead. The non-avatar branch already learned this -- "taps AND a
      // drag, because a region is driven by one or the other".
      let restAlive = false;
      for (const act of [
        async () => { G.applyInput(r, { x: 0, y: 1 }); await sleep(500); },
        async () => { G.applyInput(r, { x: 1, y: 0 }); await sleep(500); },
        async () => { G.applyInput(r, { x: 0, y: 0 }); await sleep(150); G.releaseInput(r); await sleep(350); },
      ]) {
        const idle0 = await deltas(null);
        const d0 = await deltas(act);
        G.releaseInput(r);
        await sleep(300);
        if (stirred(d0, idle0)) { restAlive = true; break; }
      }
      const idle = await deltas(null);
      // The moving half needs its OWN baseline: holding the stick moves the player, so measuring
      // against a standing-still baseline made every control look alive. Compare moving-with-the
      // -control against moving-without-it.
      let movingAlive = false;
      if (mover && !restAlive) {
        G.applyInput(mover, { x: 0, y: 1 });
        await sleep(700);
        const movingIdle = await deltas(null);
        const movingWith = await deltas(async () => {
          G.applyInput(r, { x: 0, y: 1 });
          await sleep(600);
        });
        G.releaseInput(r);
        G.releaseInput(mover);
        await sleep(700);
        // DIRECTION, not magnitude. `stirred` compares |delta| against |idle delta|, and while the
        // throttle is held the speed is already changing fast -- so braking, which changes it by a
        // similar amount the OTHER way, does not clear a 3x magnitude bar. The real build's brake
        // works and this check passed it only intermittently. What distinguishes a brake is that
        // the quantity moves differently WITH the control than without it, sign included.
        movingAlive = stirred(movingWith, movingIdle)
          || Object.keys(movingWith.signed).some((k) => {
            if (movingWith.mirror.includes(k)) return false;
            const withC = movingWith.signed[k] ?? 0;
            const without = movingIdle.signed[k] ?? 0;
            return Math.abs(withC - without) > Math.max(1e-3, Math.abs(without) * 0.5);
          });
      }
      const alive = restAlive || movingAlive;
      ck(`control '${r}' does something`, alive,
         alive ? 'changes what the game reports'
               : 'pressing it changes nothing the game reports -- neither from rest nor while '
                 + `'${mover || 'the stick'}' is held. A control drawn on screen that does `
                 + 'nothing reads as a broken game. Either wire it, or stop declaring and '
                 + 'drawing it.');
    }

    // Swiping right must move the player RIGHT ON SCREEN. Checked in screen space, because
    // that is the only frame the question exists in: a lane runner travelled +Z with a chase
    // camera behind it, which makes cross(forward, up) = -X, so its `LANE_X = [-2, 0, 2] //
    // left, center, right` moved the player the wrong way on a real device while every
    // world-space assertion here passed. Reported as "if we swipe right, its going left".
    // Only asserted when a swipe actually moves the player sideways, so a game that ignores
    // swipes, or jumps on them, is not failed for it.
    if (G.screenOf && mover) {
      const before = G.screenOf(posOf());
      G.applyInput(mover, { x: 1, y: 0 });
      await sleep(150);
      G.releaseInput(mover);
      await sleep(1200);
      const after = G.screenOf(posOf());
      if (before && after && Math.abs(after.x - before.x) > 8) {
        ck('swiping right moves the player right on screen', after.x > before.x,
           `screen x ${before.x.toFixed(0)} -> ${after.x.toFixed(0)}`
           + (after.x > before.x ? '' : ' -- the lateral axis is MIRRORED. The world axis your '
             + 'lanes sit on is not screen-left-to-right for this camera; use laneDelta(camera, '
             + 'dir) from core/motion.js, which derives the sign from the camera instead of '
             + 'assuming +X is screen-right.'));
      } else {
        // NOTHING MOVED SIDEWAYS -- and for a car with a CHASE CAMERA that is expected, not a
        // defect: the camera follows the car, so turning rotates the world around it and the actor
        // never leaves the middle of the screen. Screen space is the right frame for a lane runner
        // with a fixed camera (where "swiped right, went left" actually shipped) and the wrong one
        // here. Measured on a generated racing build: gas+steerR moved the actor 0 px sideways
        // while changing yaw by -1.277.
        //
        // So ask the question this genre can answer: does anything TURN the car? A car only turns
        // while it is moving, and `mover` is the throttle -- a GAS button carries no x axis, which
        // is why probing steering alone read 0.00 m and this check skipped on every button-steered
        // vehicle, leaving their steering completely unverified.
        const yawOf = () => { const st = G.getState(); return typeof st.yaw === 'number' ? st.yaw : null; };
        if (yawOf() === null) {
          sk('swiping right moves the player right on screen',
             'a rightward swipe moved the player less than 8 px sideways and the game reports no '
             + 'yaw, so there is no lateral control to judge');
        } else {
          // Baseline first: a car on a curved track changes yaw with the throttle alone.
          await reset();
          G.applyInput(mover, { x: 0, y: 1 });
          await sleep(900);
          const yd0 = yawOf();
          await sleep(1200);
          // SIGNED, not magnitude. A car on a curved track turns steadily under the throttle
          // alone -- the racing build drifted 0.92 rad in 1.2 s -- so a "2x the drift" bar rejects
          // a steering control that plainly works. What identifies steering is the control that
          // changes the turn RATE most, in either direction, against that baseline.
          const drift = (yawOf() ?? yd0) - yd0;
          G.releaseInput(mover);
          await sleep(300);
          let best = null, bestTurn = 0, bestSigned = 0;
          for (const r2 of regions) {
            if (r2 === mover) continue;
            await reset();
            G.applyInput(mover, { x: 0, y: 1 });
            await sleep(900);
            const ya = yawOf();
            G.applyInput(r2, { x: 1, y: 0 });
            await sleep(1200);
            const yb = yawOf();
            G.releaseInput(r2); G.releaseInput(mover);
            await sleep(300);
            if (ya === null || yb === null) continue;
            const delta = Math.abs((yb - ya) - drift);
            if (delta > bestTurn) { bestTurn = delta; best = r2; bestSigned = yb - ya; }
          }
          if (best && bestTurn > 0.25) {
            steerFrame = best;
            ck(`'${best}' steers the player while it is moving`, true,
               `yaw moved ${bestSigned.toFixed(2)} rad holding '${best}' with '${mover}', versus `
               + `${drift.toFixed(2)} rad on the throttle alone -- a change of ${bestTurn.toFixed(2)}`);
            // Which side it is MEANT to turn is not readable from the input: pressing a steer
            // button carries no direction, and reading intent off the region's name is exactly the
            // genre-specific guessing that has misfired here before. With a chase camera a mirrored
            // control is also invisible to the player, since the camera turns with the car.
            sk('swiping right moves the player right on screen',
               `steering is a separate control ('${best}') under a camera that follows the actor, `
               + 'so there is no screen-space direction to compare it against');
          } else {
            sk('swiping right moves the player right on screen',
               'no control moved the player sideways on screen or turned it while the throttle was '
               + 'held, so there is no lateral control to judge');
          }
        }
      }
    }

    if (mover) {
      // Release. The most expensive bug in this project: input not cleared on
      // pointerup, so the player kept moving after lifting a finger.
      // Drive to a REAL speed first. An earlier version held the control for 1.4 s and
      // asserted on a car barely moving, so it passed while the same vehicle took over
      // 9 s to stop from full speed -- a pace no player ever uses.
      G.applyInput(mover, { x: 0, y: 1 });
      await sleep(3000);
      G.releaseInput(mover);
      let settled = -1;
      const speeds = [];
      for (let t = 0.5; t <= 8; t += 0.5) {
        const a = posOf();
        await sleep(500);
        const moved = dist(a, posOf());
        speeds.push(moved / 0.5);
        if (moved < 0.12) { settled = t; break; }
      }
      if (view === 'vehicle') {
        // A CAR COASTS, and that is correct. This check demanded a full stop within 8 s of
        // release, which a vehicle with any momentum cannot do -- and a generated racing game
        // raised its drag over and over trying, while simultaneously adding auto-steer to pass
        // the stuck check. Two assertions written for a person on foot squeezed the handling
        // model from both sides for 75 turns. What matters for a vehicle is that releasing the
        // throttle SLOWS it: speed must fall by most of its value, not reach zero on a deadline.
        const first = speeds.length ? speeds[0] : 0;
        const last = speeds.length ? speeds[speeds.length - 1] : 0;
        const shed = first > 0 ? 1 - last / first : 1;
        ck(`releasing '${mover}' slows the vehicle down`, settled >= 0 || shed > 0.6,
           settled >= 0
             ? `came to rest ${settled.toFixed(1)} s after release`
             : `speed fell from ${first.toFixed(2)} to ${last.toFixed(2)} m/s over 8 s `
               + `(${(shed * 100).toFixed(0)}% shed)`
               + (shed > 0.6 ? ' -- coasting, which is correct for a vehicle'
                             : ' -- it barely slows at all, so the throttle never let go'));
      } else {
        ck(`releasing '${mover}' brings the player to a stop`, settled >= 0,
           settled >= 0 ? `stopped ${settled.toFixed(1)} s after release`
                        : 'still moving 8 s after release -- to a player the control never let go');
      }
    }
  }


  // Lifted out of the alignment block so it runs for onRails too. It used to sit inside a gate
  // that excluded runners, which is why a genre with a camera permanently parked behind the
  // player was the one genre never camera-checked.
  if (hasChaseCamera && Array.isArray((G.getState() || {}).facing) && posOf() && regions.length) {
    await reset();
    if (forward) G.applyInput(forward, { x: 0, y: 1 });
    await sleep(2800);                 // a lerped chase camera is correct at reset and slides after
    const cs = G.getState() || {};
    if (forward) G.releaseInput(forward);
    if (Array.isArray(cs.pos) && Array.isArray(cs.facing)) {
    // ---- WHICH SIDE of the actor is the camera on? Measured here, after ~2.8 s of driving,
    // and NOT after reset: a lerped chase camera is placed correctly by the setup path and
    // only slides to the wrong side over the following half second, so a reading taken early
    // passes on the exact code that fails on a phone.
    //
    // A detailed racing brief shipped `const behind = -12` and then
    // `x - Math.sin(yaw) * behind`: the formula's minus and the constant's minus cancelled and
    // the camera framed the car head-on. The car drove straight along its own facing
    // (alignment 0.98), never spun, and passed every check that existed -- because every check
    // compared travel to FACING, and facing was correct. Nothing compared the camera to the
    // actor. Reported from a device as "the car is coming towards the camera... the camera
    // instead of staying back of the car, it is infront of the car".
    //
    // The PERPENDICULAR axis is the control, so there is no threshold to calibrate: with the
    // camera in line with the facing, stepping sideways cannot change depth -- measured
    // dR = 0.00000 on four passing builds -- while stepping forward changes it by the full
    // amount. A side-on camera inverts that and so cannot false-positive.
    if (G.screenOf && Array.isArray(cs.pos) && Array.isArray(cs.facing)) {
      const fh = Math.hypot(cs.facing[0], cs.facing[2]);
      const here = fh > 0.01 ? G.screenOf(cs.pos) : null;
      if (here && Number.isFinite(here.z) && here.z < 0) {
        sk('the camera is behind the actor, not in front of it',
           'first person -- the actor IS the camera, so there is no side to be on');
      } else if (here && Number.isFinite(here.z)) {
        const fx = cs.facing[0] / fh, fz = cs.facing[2] / fh, D = 3;
        const at = (dx, dz) => G.screenOf([cs.pos[0] + dx * D, cs.pos[1], cs.pos[2] + dz * D]);
        const ahead = at(fx, fz), side = at(fz, -fx);
        if (ahead && side && Number.isFinite(ahead.z) && Number.isFinite(side.z)) {
          const dF = ahead.z - here.z, dR = side.z - here.z;
          const inFront = dF < 0 && Math.abs(dF) > Math.abs(dR);
          ck('the camera is behind the actor, not in front of it', !inFront,
             `a point ${D} m ahead of the actor projects ${dF < 0 ? 'NEARER' : 'further'} than the actor itself `
             + `(depth ${dF.toFixed(5)}, sideways control ${dR.toFixed(5)})`
             + (inFront
                ? '. The camera is on the WRONG SIDE: the player drives into the viewpoint and cannot see where '
                  + 'they are going. Check the SIGN OF THE CAMERA DISTANCE. `pos - sin(yaw)*d` is behind only '
                  + 'while d is POSITIVE, so a constant named `behind` or `back` must still hold a positive '
                  + 'number -- naming it for the direction AND making it negative cancels both and puts the '
                  + 'camera in front. Use `followCam(camera, target, yaw, { back, height, lerp, dt })` from '
                  + 'core/motion.js: it owns the direction and throws on a negative distance.'
                : ', so the camera is behind the actor as it should be.'));
        }
      }
    }
    }
  }

  // ---- direction. Opt-in: a game that reports `facing` gets its axes checked.
  const s0 = G.getState() || {};
  // `facing` was optional, and optional meant absent: two shipped track games published none,
  // so neither the axis check nor the camera check could run on them and both went quiet rather
  // than failing. A silent hole is worse than a failed check -- it reads as a pass. Any shape
  // with an actor has a heading, so report it.
  if (hasChaseCamera && !Array.isArray(s0.facing)) {
    ck('getState() reports the actor facing', false,
       'no `facing` was published, so two checks cannot run at all: whether pushing forward moves '
       + 'the way the actor faces, and whether the camera is BEHIND the actor rather than in front '
       + 'of it. Both are defects that reach a device looking fine -- a racing build shipped with '
       + 'the camera across the bonnet and passed everything. Add `facing: [Math.sin(yaw), 0, '
       + 'Math.cos(yaw)]` to getState() (or the unit vector your actor travels along, for a runner '
       + 'that does not turn).');
  }
  if (avatarDriven && !Array.isArray(s0.facing)) sk('movement follows the actor facing', 'getState() reports no facing');
  if (hasChaseCamera && !Array.isArray(s0.facing)) sk('the camera is behind the actor, not in front of it', 'getState() reports no facing, so which side the camera sits on cannot be measured');
  if (avatarDriven && Array.isArray(s0.facing) && Array.isArray(s0.pos) && regions.length) {
    const r = forward;   // DECLARED forward, not whatever travelled furthest -- a brake reverses
    // Measure STEADY-STATE travel, not the first moment of acceleration. Sampling from
    // rest mixed in whatever the actor was doing when it stopped -- deflecting off a rock,
    // sliding down a slope -- and reported alignment 0.22 on a car that was demonstrably
    // driving straight. The first second is discarded, then the direction is measured.
    await reset();
    G.applyInput(r, { x: 0, y: 1 });
    await sleep(1000);
    const p0 = (G.getState().pos || []).slice();
    // Split so the strip carries the drive as a SEQUENCE. One frame cannot show a freeze;
    // "3." and "4." side by side can, and this is the interval a racing build spent motionless
    // behind a countdown while still reporting phase 'playing'.
    await sleep(900);
    filmSnap('3. forward, held 1s');
    await sleep(900);
    filmSnap('4. forward, held 2s');
    const s1 = G.getState();
    const d = [s1.pos[0] - p0[0], s1.pos[2] - p0[2]];
    const f = [s1.facing[0], s1.facing[2]];
    const dl = Math.hypot(d[0], d[1]), fl = Math.hypot(f[0], f[1]);
    // Judge direction only when the actor is CLEARLY under way. Half a metre of travel
    // is mostly settling -- a landing bounce, a slide on a slope -- and the resulting
    // angle is noise, which is why this check passed and failed alternately on
    // identical code. Under way, it is unambiguous.
    // 0.8 m, not 3 m. The floor exists to avoid judging noise from a landing bounce or a
    // slide, and reset() plus a discarded first second already removes that -- 3 m was simply
    // too high to be reachable in a CONFINED space. Measured: a first-person maze travelled
    // 2.55 m before meeting a wall, so this check skipped, and the build shipped with the
    // joystick's Y axis inverted -- "if i drag backward, then its going forward", the exact
    // defect this check exists to catch. An inverted axis reads as alignment near -1, which is
    // unambiguous over one metre; the threshold was never what made the verdict trustworthy.
    const MIN_TRAVEL = 0.8;
    if (dl <= MIN_TRAVEL) sk('movement follows the actor facing', `only ${dl.toFixed(2)} m of travel to judge from`);
    if (dl > MIN_TRAVEL && fl > 0.01) {
      const dot = (d[0] / dl) * (f[0] / fl) + (d[1] / dl) * (f[1] / fl);
      ck('pushing forward moves the way the actor faces', dot > 0.7,
         `alignment ${dot.toFixed(2)} driving '${forward}' -- chosen as forward because ${forwardWhy}`
         + ' (negative means it moves BACKWARDS, often straight at the camera).'
         + (dot > 0.7 ? '' : ' If that is not your throttle, name the throttle region gas/accel/'
            + 'throttle/forward and this check will drive the right one -- do NOT change what the '
            + 'brake does to make this pass.'));
    }

    // ---- DID THE ACTOR END UP INSIDE SOMETHING? Sampled across the drive, because passing
    // through a wall is a thing that happens while moving and is invisible at rest.
    //
    // The starvation check above proves collision is being FED. It cannot prove it covers what
    // a player will hit: a racing build registered five barriers, resolved fifty-two times,
    // passed thirty-three of thirty-three -- and deliberately left every rival car and every
    // scenery prop out of the registry, so on a phone you drove through all of it. Being inside
    // a building is a fact, so there is no threshold here to calibrate or to game.
    // Two ACTORS in the same place. Static geometry is the penetration check below; this is the
    // other half, and it is the half four racing builds skipped on purpose -- "AI cars won't use
    // solids collision at all". Every one of them let the player drive through the whole field.
    // Reported by the module itself, so it is a measurement rather than a guess.
    if (typeof G.engineUse === 'function') {
      const over = [];
      for (let i = 0; i < 6; i++) {
        await sleep(260);
        for (const b of ((G.engineUse() || {}).bodies || [])) {
          for (const d of (b.overlapping || [])) if (d > 0.05) over.push(d);
        }
      }
      if (over.length) {
        ck('actors do not occupy the same space', false,
           `${over.length} overlapping pair-frame(s) among registered bodies, worst `
           + `${Math.max(...over).toFixed(2)} m of interpenetration. Call bodies.separate() once `
           + 'per frame AFTER every actor has moved -- players and rivals both.');
      }
    }

    if (typeof G.penetrations === 'function') {
      const inside = G.penetrations() || [];
      const actors = inside.filter((m) => m.kind === 'actor');
      const statics = inside.filter((m) => m.kind !== 'actor');
      // An unowned ACTOR gets its own verdict, because the remedy is a different module and the
      // old message sent four racing builds to createSolids for a problem createSolids cannot
      // solve. Rival cars are not static geometry.
      if (actors.length) {
        ck('the actor cannot pass through other actors', false,
           `the player was INSIDE ${actors.length} moving actor(s) -- `
           + actors.map((m) => `${m.name} ${m.size.join('x')}`).join(', ')
           + '. These are not scenery: they travel under their own power, so createSolids cannot '
           + 'hold them -- a static box registered once is in the wrong place a frame later. Use '
           + 'createBodies() from core/collide.js: bodies.add(car, { radius, mass }) for the '
           + 'player AND every rival, then bodies.separate() once a frame after all of them have '
           + 'moved, and merge bodies.report() into getState(). Measured: four racing builds in a '
           + 'row left rival collision out deliberately -- "AI cars won\'t use solids collision '
           + 'at all, they only need to follow waypoints" -- and every one shipped a game the '
           + 'player drove straight through the field.');
      }
      ck('the actor cannot pass through solid objects', statics.length === 0,
         statics.length === 0
           ? 'never inside static geometry while the game ran'
           : `the actor was INSIDE ${statics.length} mesh(es) while driving -- `
             + statics.map((m) => `${m.name} ${m.size.join('x')}`).join(', ')
             + '. Registering some obstacles is not collision: everything the player can reach '
             + 'needs to be in the registry. createSolids().addBox(x, z, w, d) for a wall or a '
             + 'prop, addDisc(x, z, r) for a tree or a rock, and resolve(pos, radius, previous) '
             + 'every frame with the PREVIOUS position. Rival vehicles and other moving actors '
             + 'are NOT static solids -- register those as contacts.hazard(car, { radius, onHit }) '
             + 'so a collision is detected while both are moving.');
    }

    // Held right, briefly, purely to photograph it: mirrored steering shipped from here as
    // "if we swipe right, its going left", and it is only ever visible as a turn. Taken after
    // the alignment reading above, so it cannot disturb that measurement.
    if (steerFrame && steerFrame !== r) G.applyInput(steerFrame, { x: 1, y: 0 });
    G.applyInput(r, { x: 1, y: 1 });
    await sleep(800);
    filmSnap(steerFrame && steerFrame !== r ? `5. turning ('${steerFrame}')` : '5. steering RIGHT');
    if (steerFrame && steerFrame !== r) G.releaseInput(steerFrame);
    G.releaseInput(r);

    // Pulling straight BACK must not spin the player. Only forward was ever checked, and
    // forward passes perfectly on the code that causes this.
    //
    // Camera-relative movement -- moveDir = camDir*y + camRight*x, which this project's own
    // documentation prescribes -- is correct only while the camera's yaw is an independent
    // input. A shipped game combined it with a chase camera whose yaw followed the avatar's
    // heading while the heading followed the movement direction:
    //     moveDir -> heading -> camera -> camDir -> moveDir
    // an undamped loop. Pulling back flips the heading, the camera whips round, and the
    // stick's meaning inverts every frame. On a device it read as "if i drag down, it just
    // rotates" -- reported as a broken control, and no check could see it.
    //
    // Accumulated turn, not net turn, is the signal: an avatar that deliberately turns to
    // face its movement does a single ~180 deg and then holds, so it stays well under the
    // limit, while a feedback loop keeps adding. Games where the back axis is throttle or
    // altitude (a car, a drone) do not rotate at all and are unaffected.
    await reset();
    G.applyInput(r, { x: 0, y: -1 });
    let spin = 0, prevA = null;
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      const f = G.getState().facing;
      if (Array.isArray(f) && Math.hypot(f[0], f[2]) > 0.01) {
        const a = Math.atan2(f[0], f[2]);
        if (prevA !== null) {
          let dd = a - prevA;
          while (dd > Math.PI) dd -= 2 * Math.PI;
          while (dd < -Math.PI) dd += 2 * Math.PI;
          spin += Math.abs(dd);
        }
        prevA = a;
      }
    }
    G.releaseInput(r);
    const spinDeg = Math.round(spin * 180 / Math.PI);
    ck('pulling back does not spin the player', spinDeg <= 270,
       `${spinDeg} deg of turn accumulated over 2 s of holding straight back`
       + (spinDeg > 270 ? ' -- the camera\'s yaw is being computed from movement that is'
           + ' itself derived from the camera. Give the camera an independent look control,'
           + ' or switch to tank controls (x turns, y drives).'
         : ' (a deliberate turn-to-face-movement is ~180 and then holds)'));
    await sleep(400);
  }

  // ---- grounding. The ground height is MEASURED off the scene, never taken from the
  // game's word for it. An audit of 21 games found this check did real work in 3: nine
  // reported a constant, and two derived groundY from the actor's own position, which
  // makes clearance a fixed number that cannot fail no matter how deeply the actor sinks.
  // One of those passing numbers was quoted as evidence a game worked.
  //
  // So: probe the scene. Where the game ALSO reports groundY, the two are cross-checked
  // against each other -- the pattern that makes the facing check trustworthy, where a
  // self-reported value only survives if it agrees with something independently measured.
  const sg = G.getState() || {};
  const probe = (x, z) => { try { return G.probeGround ? G.probeGround(x, z) : null; } catch (e) { return null; } };

  // SAMPLE OVER TIME, and give each check the reading most favourable to the game, because a
  // single instant is not a fact about the game. This check runs straight after the direction
  // check drives the actor forward for ~3 s, so a car cresting a hill is genuinely 2 m in the
  // air at that moment. Measured on the reference vehicle, identical code: clearance came out
  // 0.83, 1.26, 2.04 and 2.37 m against a 2 m limit -- a coin flip that failed a working game.
  //
  // Hovering means NEVER touching down, so the stilts check takes the MINIMUM clearance.
  // Sinking means never being above ground, so the sunk check takes the MAXIMUM. Only a
  // persistent condition can fail either, while a bounce, a jump or a hill crest cannot.
  // RESET FIRST. Sampling alone was not enough: the reference car went off a hill crest and
  // stayed airborne for the whole 1.2 s window (8 samples, all 2.85-5.19 m), so "it never
  // touched down" was true and the verdict was still wrong. Grounding is a fact about where
  // the actor RESTS, so measure it from rest -- which is precisely what reset() is for, and
  // this check never called it.
  await reset();
  const clearances = [];
  for (let i = 0; i < 10; i++) {
    const st = G.getState() || {};
    if (Array.isArray(st.pos)) {
      const g = probe(st.pos[0], st.pos[2]);
      if (g !== null) {
        let footY = null;
        try { footY = G.actorFootY ? G.actorFootY() : null; } catch (e) { footY = null; }
        clearances.push({ clear: st.pos[1] - g, ground: g,
                          foot: footY === null ? null : footY - g });
      }
    }
    await sleep(150);
  }
  if (avatarDriven && Array.isArray(sg.pos)) {
    const measured = probe(sg.pos[0], sg.pos[2]);
    const claimed = typeof sg.groundY === 'number' ? sg.groundY : null;

    if (measured === null) {
      // Say WHICH of the three reasons it was. A skip whose stated reason is wrong is the
      // same failure as a check that cannot fail -- it tells the reader something untrue.
      const why = !G.probeGround
        ? 'this build predates probeGround() in core/diagnostics.js, so there is no '
          + 'independent ground measurement -- and a self-reported groundY is not evidence'
        : (G.hasActor && !G.hasActor())
          ? 'attachDiagnostics was given no `actor`, so the ground under the player cannot be '
            + 'measured independently -- and a self-reported groundY is not evidence'
          : 'raycasting down from the player hit nothing in the scene';
      sk('the actor is not sunk into the ground', why);
      sk('the actor is not floating on stilts', why);
      if (claimed !== null) {
        sk('reported groundY agrees with the scene', 'no independent measurement to compare against');
      }
    } else {
      const clear = sg.pos[1] - measured;
      // The instant reading above is kept for the groundY cross-check, which must compare
      // like with like. The two verdicts below use the sampled window instead.
      const clears = clearances.map((c) => c.clear);
      const clearLow = clears.length ? Math.min(...clears) : clear;
      const clearHigh = clears.length ? Math.max(...clears) : clear;
      const span = clears.length > 1 ? ` (${clears.length} samples, ${clearLow.toFixed(2)}-${clearHigh.toFixed(2)} m)` : '';
      // Sunk means SUBSTANTIALLY below, not "the origin is at the feet". Both conventions
      // are legitimate -- a vehicle whose origin sits on the ground reports exactly 0.00 --
      // and a check that fails a modelling convention is a check that gets ignored.
      ck('the actor is not sunk into the ground', clearHigh > -0.2,
         `clearance ${clearHigh.toFixed(2)} m above the measured ground (y=${measured.toFixed(2)})${span}`);
      // A first-person "actor" is the CAMERA, which sits at eye height by design -- about
      // 1.7 m. Judging it by the third-person threshold called a correct scene broken, which
      // is the same mistake as requiring `pos` of a tower defence: a limit induced from the
      // two avatar games in front of me at the time.
      // 1.0 m was arbitrary and cost a real iteration: a build measured 1.01 m and the
      // agent spent a whole rebuild moving a capsule down six centimetres. An avatar whose
      // origin sits at its centre legitimately clears the ground by half its height, so
      // ~0.9-1.0 m is NORMAL for a 1.8 m capsule, not hovering. Hovering is a visible gap
      // -- roughly a whole body height -- which is what the original report described:
      // "a body hovering a visible gap above its own wheels".
      // The SAME question, asked of the actor's geometry instead of its origin -- which is the
      // only way to ask it tightly. `clear` above must tolerate metres because an origin means
      // nothing consistent; the bottom of the bounding box should simply sit on the surface.
      // A generated island explorer whose feet visibly clipped into the terrain passed the
      // origin check by an order of magnitude in all six builds it appeared in. Judged on the
      // minimum across the window, so a jumper is measured at its landing rather than mid-air.
      const feet = clearances.map((c) => c.foot).filter((f) => f !== null);
      if (feet.length) {
        const footLow = Math.min(...feet);
        const range = `${footLow.toFixed(2)} m (samples ${feet.length}, `
          + `${Math.min(...feet).toFixed(2)}-${Math.max(...feet).toFixed(2)})`;
        ck('the actor sits ON the ground, not in it', footLow > -0.15,
           `lowest point of the actor is ${range} relative to the ground`
           + (footLow > -0.15 ? '' : ' -- part of the model is UNDER the surface. This is what a '
             + 'player sees as feet sinking into the terrain. If you place the actor with '
             + 'createGround().place(pos, eye), `eye` must be the distance from the actor\'s '
             + 'origin to its LOWEST point, not 0.'));
        // 0.5 m, not 0.35: a VEHICLE's chassis legitimately rides above the road -- the wheels
        // are what touch, and they are often not part of the actor at all. Our own driving
        // archetype measures exactly 0.35, so a 0.35 limit is a coin flip on a real scene, and
        // an arbitrary limit landing on a working game is the mistake the stilts threshold
        // already made once (1.0 m cost a build six centimetres of capsule). What this still
        // catches is the original report: "a body hovering a visible gap above its own wheels",
        // which is most of a body height, not a suspension's worth.
        ck('the actor touches down at all', footLow < 0.5,
           `lowest point of the actor is ${range} relative to the ground`
           + (footLow < 0.5 ? '' : ' -- it never reaches the surface, so it is hovering'));
      }
      const stilts = view === 'firstPerson' ? 2.2 : 2.0;
      ck('the actor is not floating on stilts', clearLow < stilts,
         `clearance ${clearLow.toFixed(2)} m (limit ${stilts} m`
         + (view === 'firstPerson' ? ', eye height for a first-person camera)' : ')')
         + span
         + (clearLow < stilts ? '' : ' -- it never touches down, so it is hovering'));
      if (claimed !== null) {
        // A game whose reported ground disagrees with the scene has a bug that every
        // other groundY-based judgement inherits.
        ck('reported groundY agrees with the scene', Math.abs(claimed - measured) < 0.5,
           `game says ${claimed.toFixed(2)}, scene measures ${measured.toFixed(2)}`);
      }
    }
  }

  try { if (G.captureFrame) frames.push(G.captureFrame()); } catch (e) {}

  // ---- progress. The one invariant that holds for every genre: a game should be
  // ADVANCEABLE. This is the check that was missing when a parkour level passed 11/11
  // with its first platform 6.1 m above a 2.88 m jump -- every control worked perfectly
  // and the game could not be played. Height, score, distance, wave, level: whatever the
  // game counts, playing should move it.
  if (canCheckProgress) {
    const st = G.getState() || {};
    const FIELDS = ['progress', 'score', 'distance', 'height', 'wave', 'level', 'depth', 'best'];
    const field = FIELDS.find((f) => typeof st[f] === 'number');
    if (!field) {
      sk('the player can make progress',
         'getState() reports no progress number (progress/score/distance/height/wave/level)');
    } else if (!regions.length) {
      sk('the player can make progress', 'no control regions to play with');
    } else {
      // FIRST: how fast does it advance with nobody playing? Without this baseline the
      // number is uninterpretable. An endless runner adds `dist += speed * dt` every
      // frame regardless of input, so "progress 143 -> 399" was reported as a pass and
      // would have read identically on a game that ignores every control. Measure the
      // idle rate, print it always, and never let it masquerade as evidence again.
      for (const r of regions) { try { G.releaseInput(r); } catch (e) {} }
      await sleep(400);
      const idle0 = G.getState()[field];
      await sleep(4000);
      const idleRate = (G.getState()[field] - idle0) / 4;

      const before = G.getState()[field];
      // Play: hold the first region and pulse every other one, which covers a jump or a
      // fire button without needing to know which is which.
      //
      // And STEER toward whatever the game says the objective is. Without this the harness
      // pushed in one arbitrary direction and wandered, so a coin-collection game reported
      // "progress 1 -> 1" and failed while working perfectly -- four times. The failure
      // message asks the game to publish its objectives' screen positions; a generated
      // island game did exactly that (`screen: { coin0: picker.project(...) }`) and this
      // check ignored them. Closing that loop is the whole fix.
      //
      // Re-read every ~350 ms, because turning moves the target across the screen. A single
      // long push cannot home on anything. Works for both control schemes without knowing
      // which: on camera-relative movement pushing toward the target's side moves toward
      // it; on tank steering it turns toward it and `y` then drives forward.
      const homing = screenTargets(false).length;   // steering: off-screen targets count
      if (!homing) blindDrive = true;
      const cx = window.innerWidth / 2;
      // Lock onto ONE target and hold it. Re-choosing every 350 ms made the harness spiral:
      // screen `y` is NOT distance -- three coins 26, 24.7 and 30 units away reported y of
      // 464, 373 and 385 -- so "lowest on screen first" flipped between coins on every read
      // and reversed the steering each time. Traced: after collecting its first coin the
      // harness went from 1.1 to 18.8 units AWAY from the nearest remaining one.
      //
      // Rank instead by how CENTRED a target is, which is the one the present heading is
      // already closest to, and re-pick only when the locked target disappears from the
      // report -- for a collectible, that vanishing is itself the evidence it was collected.
      let lock = null, held = 0, seen = null;
      const aim = () => {
        const now = G.getState()[field];
        if (now !== seen) { seen = now; held = 0; }   // progress moved: keep doing this
        // A game that keeps publishing a collected target would otherwise pin the harness on
        // it forever, so a lock that buys no progress for ~4 s is abandoned for another.
        if (++held > 16) { lock = null; held = 0; }
        const ts = screenTargets(false);
        let t = lock ? ts.find((q) => q.key === lock) : null;
        if (!t) {
          // In front and centred first; a target behind the eye is still a target, it just
          // has to be turned toward. It is ranked last, never discarded.
          t = ts.slice().sort((a, b) => (a.behind - b.behind)
                                     || (Math.abs(a.x - cx) - Math.abs(b.x - cx)))[0];
          lock = t ? t.key : null;
        }
        if (t && t.behind) {
          // The objective is behind the camera, where the projected x is meaningless -- so
          // turn a CONSTANT direction until it comes round to the front, and ease off the
          // throttle so the turn is not also a sprint further away. This is the state the
          // harness is normally in when the progress check begins, because the checks before
          // it deliberately drive to the edge of the world; a real generated coin game failed
          // for exactly this reason and the agent diagnosed it correctly as the checker
          // driving straight past its coins.
          G.applyInput(forward, { x: 1, y: 0.35 });
          return;
        }
        const sx = t ? Math.max(-1, Math.min(1, (t.x - cx) / (window.innerWidth * 0.25))) : 0;
        G.applyInput(forward, { x: sx, y: 1 });
      };
      aim();
      for (let i = 0; i < 14; i++) {
        for (const r of regions.slice(1)) {
          G.applyInput(r, { x: 0, y: 1 });
          await sleep(120);
          G.releaseInput(r);
        }
        // Same total dwell as before -- the reported rates stay comparable with older runs --
        // just split so the heading is corrected while the target moves.
        const dwell = regions.length > 1 ? 900 : 1400;
        for (let k = 0; k < 4; k++) { aim(); await sleep(dwell / 4); }
      }
      G.releaseInput(primary);
      const after = G.getState()[field];
      const playRate = (after - before) / 14.7;   // the play loop above runs ~14.7 s
      const rates = `idle ${idleRate.toFixed(2)}/s vs playing ${playRate.toFixed(2)}/s`
        + (homing ? `, steered toward ${homing} published target(s)` : '');
      // Origin: a generated parkour level whose first platform sat 6.1 m above a 2.88 m jump --
      // every control worked and the game could not be played. It can also false-fail a
      // collection game whose harness never happened to walk over a coin, which is why the
      // message below carries both readings.
      // A game that DIED while being driven has not shown it cannot advance -- it has shown the
      // harness killed it. Establish the truth from a LIVE state instead of a corpse.
      //
      // Two orderings both happen, so both are handled. The generated neon runner died during
      // the play loop, so its idle rate was already the proof: 6.00/s idle against 0.00/s
      // driven. A game that dies during the earlier region probe reaches here already dead, and
      // its idle rate is 0 too -- so reset and measure a short window from a live state.
      // An ON-RAILS game advances BY DESIGN -- the world is carried toward the player. If the
      // idle rate is clearly positive, the game demonstrably can advance, and a lower rate while
      // driven means the harness INTERFERED, not that the game is broken. Measured on a generated
      // neon runner: `idle 15.00/s vs playing 0.14/s`. Blind swiping crashes a runner, so the
      // driven window measures a corpse -- and whether it reads `0 -> 0` or `85 -> 87` is chance.
      // The same build failed this check on the user's run and passed it on mine, from identical
      // source. A check whose verdict is a coin flip costs rounds and teaches nothing.
      const diedDriving = ended() || (view === 'onRails' && idleRate > 0.5);
      let liveRate = idleRate, liveWhy = 'before the drive';
      if (after <= before && diedDriving && liveRate <= 0 && G.reset) {
        await reset();
        if (!ended()) {
          const b2 = G.getState()[field];
          await sleep(3000);
          liveRate = (((G.getState()[field] - b2) || 0)) / 3;
          liveWhy = 'from a reset, live state';
        }
      }
      if (after <= before && diedDriving && liveRate > 0) {
        ck(`the player can make progress ('${field}' rises)`, true,
           `${field} rises at ${liveRate.toFixed(2)}/s (${liveWhy}); the drive ENDED the game `
           + `(${endedBy()}), so the driven reading of ${rates} was taken on a stopped game.`);
        await reset();          // leave a LIVE game for the checks that follow
      } else if (after <= before && diedDriving) {
        sk(`the player can make progress ('${field}' rises)`,
           `the game ENDED while being driven (${endedBy()}) and ${field} does not advance on its `
           + 'own, so nothing here could be measured on a running game. Expose reset() to '
           + 'attachDiagnostics if this game can end within a few seconds of unskilled play.');
      } else
      ck(`the player can make progress ('${field}' rises)`, after > before,
         `${field}: ${before} -> ${after} (${rates})`
         // The message used to end "-- either the game cannot be advanced, OR THE HARNESS
         // COULD NOT REACH whatever advances it". That hedge was written to soften two
         // false failures on collection games, and a real build then quoted it back --
         // verbatim, "the progress check says 'if progress needs the player to REACH
         // something'" -- as its reason to dismiss this failure three times and ship a game
         // whose coin counter never moved. An escape clause in a failure message is an
         // escape clause the agent will take. Both branches below name a concrete defect
         // and a concrete fix; neither offers "the checker may be wrong" as a conclusion.
         + (after > before ? '' : homing
            ? ` -- the harness steered at ${homing} of the positions this game itself`
              + ' published and nothing rose. Either advancing is broken, or every objective'
              + ' is beyond ~15 s of travel: put one within reach of the spawn point so that'
              + ' advancing can be verified at all.'
            : ' -- and this game published no objective positions, so the harness could only'
              + ' drive. If progress needs the player to REACH something, report where those'
              + " things are (e.g. screen: { coin0: picker.project(coin.position) }) so the"
              + ' harness can go to them. Until then nothing here can confirm the game is'
              + ' playable, and an unverifiable game is not a passing one.'
              + ' Register the things themselves with createContacts() from core/contact.js --'
              + " contacts.pickup(coin, { radius, onTake }) and contacts.hazard(train, { onHit })"
              + ' -- and merge contacts.report() into getState(). It sweeps the RELATIVE motion'
              + ' of actor and item, so a coin is still collected when the world moves past the'
              + ' player at 34 m/s and the phone is running at 20 fps; a hand-written'
              + ' `if (dist < 1)` steps straight over it and the coin silently never counts.'
              + ' A shipped runner had exactly that: coins that never scored and trains you'
              + ' could drive through, at 18 of 18 checks passed.'));

      // If progress did not rise, look for the one cause that is not the game's fault and not
      // the harness's either: a bundle waiting for a message from React Native. An endless
      // runner gated everything on `msg.type === 'START'`, which only the app sends, so under
      // this checker -- and in the web preview, and in any future check -- it sat frozen and
      // dark. Three separate failures, one cause, and the agent could not diagnose any of them
      // from "progress: 0 -> 0". Naming it is the whole fix; the detection already worked.
      // ...but ONLY when the game was not already reported as stuck on its start screen.
      // Both fired together on an island explorer: 'the game can be started' said the truth
      // (the PLAY button was never pressed) and this said the opposite (the bundle is waiting
      // for React Native). It was not. Two confident and contradictory diagnoses cost more than
      // one, because the agent must guess which to act on -- and it acted on this one, deleting
      // a working start screen. `gateBefore` is set at the top of this run.
      if (!(after > before) && !gateBefore) {
        const st = G.getState() || {};
        const gate = ['gameStarted', 'started', 'running', 'active', 'playing']
          .find((k) => st[k] === false)
          || (typeof st.phase === 'string' && /idle|menu|ready|waiting|start/i.test(st.phase) ? 'phase' : null);
        if (gate) {
          // TWO different faults report the same symptom, and telling them apart matters more
          // than the wording: a game nothing has ever started, versus a game a real finger DID
          // start and reset() then un-started. The old message asserted the first unconditionally
          // and named isHosted as the cure. A shipped runner had the second, followed the cure,
          // branched its start on isHosted, and passed 18/18 on a code path the phone never runs.
          // Its own reasoning had already found the true cause -- "my resetGame() doesn't call
          // shell.show('start')" -- and it took this message's advice instead of its own.
          const tapped = window.__START_TAP__ && window.__START_TAP__.cleared;
          ck('the game runs without a host', false,
             `getState() reports ${gate}=${JSON.stringify(st[gate])} and nothing advanced. `
             + (tapped
                ? 'A real click DID start this game earlier in this same run, so it is NOT waiting '
                  + 'for React Native. reset() put it back to a non-started state and did not '
                  + 're-show the start screen, so nothing can start it again. Show it again from '
                  + "your reset -- shell.show('start') -- and the start screen stays reachable for "
                  + 'the rest of the run.'
                : 'Nothing has started this game: no drawn control and no injected region cleared '
                  + 'it. The game must start, play and end with no host present; a host message '
                  + 'may CONFIGURE (difficulty) or PERSIST (high score), never GATE.')
             + ' Do NOT branch the start on createBridge().isHosted, and do not auto-start when '
             + 'unhosted: that makes the checker and the player run different code, and every '
             + 'check after it measures a path no player takes.');
        }
      }

      // The idle-vs-playing RATES are printed above and that is all they are for. There
      // used to be an assertion here demanding playing beat idle. It was removed on
      // evidence: across 8 recorded builds it caught 0 real defects and false-failed 1
      // working game. I added it believing a drone's autopilot was driving its progress;
      // checking later showed my own injected throttle was. A check with no defect behind
      // it still costs something -- it teaches the agent that check output is arguable.
      await sleep(600);
    }
  }

  // ---- stuck. Reported from a real device: "after some time it got stuck at a
  // position, but when I moved it backward and started, it worked fine". A player who
  // has to guess a recovery manoeuvre has hit a dead game. Driving into a wall and
  // stopping is normal, so this only fails on a LONG stall while input is still held.
  if (avatarDriven && posOf() && regions.length) {
    // From a KNOWN state. Each precise measurement resets first, because otherwise every
    // one of them depends on where the previous check happened to leave the actor -- which
    // is how this check came to pass and fail alternately on identical code, and why
    // adding an idle baseline to the progress check above broke it from a distance.
    await reset();
    const mover2 = forward;
    // STEER if the game published somewhere to go. Holding the throttle straight ahead is fine
    // in an open world and hopeless on a closed course: a racing game failed this seven times
    // because the harness drove into the first barrier, and shipped auto-steering toward the
    // track centre to satisfy it. A track that publishes its next waypoint in `screen:` can be
    // driven round instead -- the same field the progress check already homes on, aimed here
    // with a plain proportional steer rather than the lock-and-abandon logic that collection
    // games need.
    const steerCx = window.innerWidth / 2;
    // VEHICLES ONLY, deliberately. An earlier version steered any scene that published targets,
    // which quietly weakened this check for avatar games: objectives are placed in REACHABLE
    // spots by construction -- starter only spawns coins where `!solids.blocked()` -- so aiming
    // at them drives the player around the scenery traps this check exists to find. The one real
    // catch it has (a first-person maze wedged in a corridor for 8 s) published no targets, so a
    // fixed arc that blunders into geometry is the better stress test on foot. A closed circuit
    // is the opposite case: there, driving straight ahead is guaranteed to end at a barrier.
    const canSteer = view === 'vehicle' && screenTargets(false).length > 0;
    const aimAhead = () => {
      const ts = screenTargets(false);
      if (!ts.length) { G.applyInput(mover2, { x: 0.15, y: 1 }); return; }
      const t = ts.slice().sort((a, b) => (a.behind - b.behind)
                                       || (Math.abs(a.x - steerCx) - Math.abs(b.x - steerCx)))[0];
      if (t.behind) { G.applyInput(mover2, { x: 1, y: 0.35 }); return; }
      const sx = Math.max(-1, Math.min(1, (t.x - steerCx) / (window.innerWidth * 0.25)));
      G.applyInput(mover2, { x: sx, y: 1 });
    };
    aimAhead();
    const samples = [];
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if (canSteer) aimAhead();          // re-aim: a turn moves the target across the screen
      samples.push(posOf().slice());
    }
    G.releaseInput(mover2);
    let run = 0, worst = 0;
    for (let i = 1; i < samples.length; i++) {
      run = dist(samples[i - 1], samples[i]) < 0.2 ? run + 0.5 : 0;
      worst = Math.max(worst, run);
    }
    // A game PAUSED behind a win or game-over overlay is not stuck, and until the shell
    // reported a phase there was no way to tell those apart: the starter collected every coin
    // during this drive, showed its win screen, correctly stopped simulating, and failed as
    // "stuck". Anything the scene reports as not-playing is excluded, and said out loud so a
    // genuinely wedged game cannot hide behind a mislabelled phase.
    const stuckPhase = (G.getState() || {}).phase;
    if (stuckPhase && stuckPhase !== 'playing') {
      sk('never stuck for long while the control is held',
         `the game reported phase '${stuckPhase}' during the drive -- it is paused behind a `
         + 'screen, not stuck, so a stall here is not evidence of anything');
    } else if (view === 'vehicle' && canSteer) {
      // It published waypoints, so the drive above was STEERED and a stall is the game's own.
      ck('never stuck for long while the control is held', worst < 4,
         `longest stall ${worst.toFixed(1)} s over a 10 s steered drive `
         + `(aimed at ${screenTargets(false).length} published waypoint(s))`
         + (worst >= 4 ? ' -- it wedges even when driven along its own route, so give the player '
           + 'an automatic recovery. createUnstick() in core/collide.js owns this: pass it the '
           + 'direction the player is asking for and it only nudges while they are commanding, so '
           + 'it cannot drive the game by itself. A hand-rolled one shipped a car that completed '
           + 'laps with nobody touching the controls, at 33 of 33 checks passed.' : ''));
    } else if (view === 'vehicle') {
      // This harness holds the accelerator and CANNOT STEER. On a closed circuit that means a
      // barrier, always -- so demanding a vehicle never stall while pushed forward is asking it
      // to drive itself. A generated racer failed this seven times and added auto-steering
      // toward the track centre to pass, which is a worse game than the one that failed.
      // Reported, never failed: a stall here is as likely to be the wall as the game.
      sk('never stuck for long while the control is held',
         `view is 'vehicle' and this game published no waypoints, so the harness could only hold `
         + `the throttle straight ahead, which on any closed course ends at a barrier `
         + `(longest stall ${worst.toFixed(1)} s over a 10 s drive). `
         + 'Publish waypoints in `screen:` and it can be driven around a lap instead.');
    } else {
          if (worst >= 4) wedged = true;
          ck('never stuck for long while the control is held', worst < 4,
             `longest stall ${worst.toFixed(1)} s over a 10 s drive`
             + (worst >= 4 ? ' -- give the player an automatic recovery. createUnstick() in '
             + 'core/collide.js owns this, and only nudges while the player is commanding '
             + 'movement, so it cannot drive the game by itself.' : ''));
    }
    await sleep(600);
  }

  // ---- bounds. Drive one way for a long time. A world with an edge and no barrier
  // lets the player fall out of it, which ends the game silently -- this scene did
  // exactly that before it had bounds. Judged on falling, not on distance: a large
  // world where you simply keep driving is fine.
  if (avatarDriven && posOf() && regions.length) {
    await reset();
    const g0 = G.getState();
    if (typeof g0.groundY === 'number') {
      G.applyInput(forward, { x: 0, y: 1 });
      let fell = 0;
      for (let i = 0; i < 24; i++) {
        await sleep(700);
        const s = G.getState();
        if (typeof s.groundY === 'number' && (s.pos[1] - s.groundY) < -3) fell++;
      }
      G.releaseInput(forward);
      ck('the player cannot fall out of the world', fell === 0,
         fell ? `${fell} samples far below the ground -- the world needs a barrier at its edge`
              : 'drove to the limit and stayed on the ground');
      await sleep(800);
    }
  }

  // ---- at rest. Reported from a device: a target sphere balanced on a flat crate rolled
  // off by itself, fell below the win line and completed the level with no input at all.
  // A sphere has one contact point, so any solver jitter pushes it sideways with nothing
  // resisting. The invariant is genre-independent: with no input, the world stops moving.
  {
    for (const r of regions) { try { G.releaseInput(r); } catch (e) {} }
    await reset();

    // Measured, not reported: the checker diffs the position it is already reading, so
    // no game can opt out of this one by omitting a field. That matters because `atRest`
    // is self-reported and not one of the games audited declared it, which made the
    // invariant below skip everywhere while reading as covered.
    //
    // The failure this catches, from a device: a lane runner whose player visibly shook
    // at the outer lanes. It stepped a fixed 0.30 m per frame toward the target lane
    // with no clamp, so it overshot, came back, and oscillated forever -- 2.4 / 2.7 /
    // 2.4 at 60 fps, and 0.6 m at 30. The centre lane divided evenly and sat still,
    // which is why it looked fine in a screenshot and only shook at the ends.
    if (posOf()) {
      // Push it OFF-CENTRE first, then let go. The runner's oscillation only existed at
      // the outer lanes -- the centre divided evenly by the step size and sat perfectly
      // still, which is why it looked fine in a screenshot. Measuring rest only from
      // wherever the previous check left the actor tests the one state most likely to be
      // symmetric, and symmetry is exactly what hides this class of bug.
      for (const r of regions) { try { G.applyInput(r, { x: 1, y: 0 }); } catch (e) {} }
      await sleep(900);
      for (const r of regions) { try { G.releaseInput(r); } catch (e) {} }
      await sleep(2500);                       // let any legitimate settling finish
      const trail = [];
      // Heading is sampled alongside position on the SAME idle window, because an actor can be
      // perfectly still and still be wrong: a shipped racer sat with nothing pressed and rotated
      // slowly clockwise for as long as you watched it. Every idle check measured metres, so it
      // passed all of them. Reported as "even if we left the joystick and handles, the car is
      // rotating itself clockwise slowly".
      const spins = [];
      const headingNow = () => {
        const q = G.getState() || {};
        if (typeof q.yaw === 'number') return q.yaw;
        if (Array.isArray(q.facing) && Math.hypot(q.facing[0], q.facing[2]) > 0.01) {
          return Math.atan2(q.facing[0], q.facing[2]);
        }
        return null;
      };
      for (let i = 0; i < 16; i++) {
        await sleep(250);
        trail.push(posOf().slice());
        const hh = headingNow();
        if (hh !== null) spins.push(hh);
      }
      // Peak-to-peak cannot tell STEADY ADVANCE from OSCILLATION, and one whole genre
      // advances by design. Measured: an onRails runner that moves the player through a
      // static world (rather than scrolling the world past a fixed player) reported 127.5 m
      // of spread on z and failed outright -- with a message blaming oscillation, which
      // would send the agent hunting a lane-stepping bug that does not exist. This project's
      // own contract ASKS onRails games to report `pos`, so it invited that failure.
      //
      // Path length versus net displacement separates them without needing to know the
      // genre: a steady advance has total travel equal to its net displacement, so the
      // difference is zero, while a shake returns to where it started and the difference is
      // the whole path. That also keeps the original catch intact -- a lane runner stepping
      // 0.30 m past its target and back accumulates path while going nowhere.
      let amp = 0, axis = '', peak = 0;
      for (let a = 0; a < 3; a++) {
        const vals = trail.map((p) => p[a] ?? 0);
        let path = 0;
        for (let i = 1; i < vals.length; i++) path += Math.abs(vals[i] - vals[i - 1]);
        const net = Math.abs(vals[vals.length - 1] - vals[0]);
        const osc = Math.max(0, (path - net) / 2);
        if (osc > amp) { amp = osc; axis = 'xyz'[a]; peak = Math.max(...vals) - Math.min(...vals); }
      }
      // A tolerance that clears an idle bob or a suspension settle, and fails a control
      // loop that cannot converge.
      // DOES THE GAME PLAY ITSELF? Oscillation is not the only way to fail at standing still,
      // and it is the flakier half. A generated racing build teleported its car 3 m toward the next
      // waypoint every second with nobody touching the controls and completed whole laps on its own
      // -- reported as "it goes forward by itself, by giving small small pushes, and completes even
      // if we dont touch the handles". That is almost pure NET displacement, so it only tripped the
      // oscillation bar when a barrier happened to bounce the car: the build scored 33/33 and a
      // re-run of identical source scored 32/33. A coin flip decided whether it shipped.
      //
      // Net travel across this same trail settles it deterministically. The trail already waits
      // 2.5 s for legitimate settling before sampling, so a vehicle rolling to a stop has stopped.
      // onRails is exempt: advancing untouched is what the genre IS.
      const tA = trail[0], tB = trail[trail.length - 1];
      const netMove = Math.hypot((tB[0] ?? 0) - (tA[0] ?? 0), (tB[2] ?? 0) - (tA[2] ?? 0));
      if (view === 'onRails') {
        sk('the game does not advance on its own',
           "view is 'onRails' -- running forward untouched is what the genre is");
      } else {
        // 4 m, not 1.5. The first bar was set from ONE side of the boundary: a build that
        // teleported itself 23.04 m was known to be pathological, and nothing legitimate had been
        // measured against it. A racing car with real momentum coasts 1.63-1.84 m past the 2.5 s
        // settle, which is not a game playing itself -- and that cost one build four check rounds,
        // including a "fix" that broke a different check. The pathological case is 13x the
        // legitimate one; a bar in between still catches it with enormous margin.
        ck('the game does not advance on its own', netMove < 4,
           `${netMove.toFixed(2)} m of travel over 4 s with nothing pressed`
           + (netMove < 4 ? '' : ' -- the game is playing itself, so every control check above '
             + 'passed against a player that moves whether or not anyone touches it. Look for '
             + 'auto-recovery or waypoint steering that runs while no input is held. '
             + 'createUnstick() in core/collide.js only nudges while the player is commanding, '
             + 'which is what prevents exactly this.'));
      }

      // Total turning across the idle window, summed on the SHORTEST arc per step so a wrap
      // past PI does not read as a full revolution. Settling on a slope is a degree or two; a
      // self-rotating car accumulates continuously and without bound.
      if (spins.length > 4) {
        let turned = 0;
        for (let i = 1; i < spins.length; i++) {
          let d = spins[i] - spins[i - 1];
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          turned += Math.abs(d);
        }
        const deg = turned * 180 / Math.PI;
        ck('the actor does not turn on its own', deg < 20,
           `${deg.toFixed(0)} deg of turning over 4 s with nothing pressed`
           + (deg < 20 ? '' : ' -- the actor is rotating by itself. Every other idle check measures '
             + 'METRES, so a car spinning on the spot passes all of them and only a person notices. '
             + 'Look for a steering term that is applied unconditionally: a yaw update outside the '
             + '`if held` branch, a stick sampled without a deadzone so its resting value is not '
             + 'exactly zero, or an auto-steer toward a waypoint that runs whether or not anyone is '
             + 'driving. steer() and tankDrive() both return the yaw UNCHANGED when nothing is '
             + 'pressed, so routing every turn through them makes this unwritable.'));
      }

      // TWO causes of a jitter, and they send you to different files. Overshoot is a stepping
      // bug in the scene. CONTACT CHATTER is another registered actor leaning on this one: a rival
      // parked against the player on the grid drives forward, separate() pushes it back, and the
      // player trembles at 0.3 m for as long as they touch. Naming the wrong one costs a rewrite,
      // which is why this asks the bodies registry before it guesses.
      let chatter = false;
      try {
        for (const b of ((typeof G.engineUse === 'function' ? G.engineUse() : {}).bodies || [])) {
          for (const d of (b.overlapping || [])) if (d > 0.02) chatter = true;
        }
      } catch (e) {}
      ck('the actor holds still when nothing is pressed', amp < 0.25,
         `${amp.toFixed(3)} m of back-and-forth on ${axis || 'x'} over 4 s with no input`
         + ` (${peak.toFixed(3)} m total range -- steady travel is not counted)`
         + (amp < 0.25 ? ''
            : chatter
              ? ' -- and registered bodies are TOUCHING while it happens, so this is contact '
                + 'chatter, not a stepping bug: another actor is driving into this one and '
                + 'separate() is pushing it back every frame. separate() is doing its job. Fix '
                + 'the actor that keeps driving in -- give it somewhere to go around, or cut its '
                + 'speed while it is in contact. Do NOT go looking for an overshoot in the '
                + 'stepping code, and do not widen the deadzone; neither is the cause.'
              : ' -- it is oscillating; a step toward a target must never exceed the distance left'));
    } else if (avatarDriven || view === 'onRails') {
      sk('the actor holds still when nothing is pressed',
         `view is '${view}' so there is an actor, but getState() reports no pos to watch it with`);
    }

    const st = G.getState() || {};
    if (typeof st.atRest === 'boolean') {
      let settledAt = -1;
      for (let t = 0.5; t <= 8; t += 0.5) {
        await sleep(500);
        if ((G.getState() || {}).atRest) { settledAt = t; break; }
      }
      if (settledAt < 0) {
        ck('the world settles when the player does nothing', false,
           'still moving 8 s after the last input -- something drifts, jitters or rolls on its own');
      } else {
        // Sample ACROSS the window, never at one instant. atRest is a velocity threshold, and a
        // body resting on a surface micro-jitters from contact resolution, so the boolean flickers
        // either side of the epsilon. One reading three seconds later caught whichever phase it
        // happened to be in and then asserted "started moving again" as fact -- the explorer failed
        // and passed on identical code, and a generated game would have been sent to fix a world
        // that was already still. Third time this project has made this mistake: the grounding
        // check read one instant (0.83/1.26/2.04/2.85 m from the same scene) and the holds-still
        // check used peak-to-peak. Same remedy both times: a window, not a point. Sustained motion
        // fails; a blip does not.
        const SAMPLES = 10;
        let moving = 0;
        for (let i = 0; i < SAMPLES; i++) {
          await sleep(300);
          if (!(G.getState() || {}).atRest) moving++;
        }
        ck('the world settles when the player does nothing', moving <= 2,
           `settled after ${settledAt.toFixed(1)} s`
           + (moving ? `, then reported not-at-rest in ${moving}/${SAMPLES} samples over the next 3 s`
                     : ''));
      }
    } else {
      sk('the world settles when the player does nothing',
         'getState() reports no atRest boolean (true when every dynamic body has stopped)');
      // Even without the contract, say how much the picture changed with nobody playing.
      // Informational: an idle animation or drifting clouds move legitimately.
      const shot = () => (G.captureFrame ? G.captureFrame() : null);
      const a = shot();
      await sleep(5000);
      const b = shot();
      if (a && b) {
        const load = (u) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = u; });
        const [ia, ib] = [await load(a), await load(b)];
        const cv = document.createElement('canvas');
        cv.width = ia.width; cv.height = ia.height;
        const cx = cv.getContext('2d');
        cx.drawImage(ia, 0, 0); const pa = cx.getImageData(0, 0, cv.width, cv.height).data;
        cx.drawImage(ib, 0, 0); const pb = cx.getImageData(0, 0, cv.width, cv.height).data;
        let diff = 0, n = 0;
        for (let i = 0; i < pa.length; i += 4 * 29) {
          n++;
          if (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) > 24) diff++;
        }
        out.idleChange = +(100 * diff / Math.max(1, n)).toFixed(1);
      }
    }
  }

  // ---- the frame. Pixel work happens here so the checker needs no image library.
  for (const r of regions) { try { G.releaseInput(r); } catch (e) {} }
  await reset();
  await sleep(700);
  const lateUrl = G.captureFrame ? G.captureFrame() : null;
  ck('still rendering after being driven', !!lateUrl,
     lateUrl ? '' : 'captureFrame() returned nothing at the end of the run');
  if (lateUrl) frames.push(lateUrl);
  if (lateUrl) strip.push({ label: '6. end of run', url: lateUrl });

  // Ask the BROWSER, not the game. Every other check here reads window.__GAME__, which the
  // scene supplies -- so a 2D canvas game that bundles correctly can answer all of them
  // truthfully about itself and collect a full pass. This one question does not go through
  // the game at all: getContext('webgl2') on the game's own canvas returns the live context
  // if there is one, and null if a 2d context was created on it instead. A scene cannot
  // fake the kind of context attached to its own canvas.
  let glOk = false;
  let glWhy = '';
  try {
    const c = document.getElementById('c');
    if (!c) {
      glWhy = 'there is no <canvas id="c"> in the document at all';
    } else {
      glOk = !!(c.getContext('webgl2') || c.getContext('webgl'));
      if (!glOk) {
        glWhy = 'the game canvas has no WebGL context, so nothing here is rendering in 3D. '
          + 'getContext("webgl2") returns null once a 2d context exists on the same canvas -- '
          + 'which is what a canvas-2D or raycaster game leaves behind. Render through '
          + 'createHost() from core/host.js.';
      }
    }
  } catch (e) { glWhy = 'the WebGL probe threw: ' + (e && e.message ? e.message : e); }
  const tri = (G.info && G.info.triangles) || 0;
  ck('the game renders through WebGL', glOk, glWhy || `${tri} triangles in the last frame`);

  const analyse = async (u) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = u; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const seen = new Map();
    for (let i = 0; i < px.length; i += 4 * 37) {           // sparse sample; plenty
      const k = (px[i] >> 3) + ',' + (px[i + 1] >> 3) + ',' + (px[i + 2] >> 3);
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    let top = 0, total = 0;
    for (const v of seen.values()) { total += v; top = Math.max(top, v); }
    const lum = [];
    for (let i = 0; i < px.length; i += 4 * 13) {
      lum.push(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]);
    }
    lum.sort((p, q) => p - q);
    return { url: u, buckets: seen.size, dom: top / total,
             p90: lum[Math.floor(lum.length * 0.9)] || 0,
             mean: lum.reduce((s, v) => s + v, 0) / Math.max(1, lum.length) };
  };

  const shots = [];
  for (const u of frames) { if (u) { try { shots.push(await analyse(u)); } catch (e) {} } }
  if (!shots.length) {
    ck('a frame can be captured', false, 'createHost needs captureFrames: true');
  } else {
    // The richest frame of the run. Judged on the best rather than on a fixed moment,
    // because every state sampled is one a player can reach, and a renderer that never
    // draws anything draws nothing in all of them.
    const best = shots.reduce((a, b) => (b.buckets > a.buckets ? b : a));
    ck('the frame is not a blank fill', best.buckets > 4 && best.dom < 0.97,
       `${best.buckets} colour buckets, largest ${(best.dom * 100).toFixed(0)}% of pixels`
       + (shots.length > 1 ? ` (best of ${shots.length} frames: ${shots.map((s) => s.buckets).join(', ')})` : ''));
    out.frame = best.url;

    // Brightness, judged on the BRIGHTEST frame of the run, for the same reason the check above
    // judges the richest. A single frame cannot tell "this game is too dark" from "the camera
    // happens to be a metre from a wall right now" -- and a maze legitimately spawns you in a
    // corridor. Measuring one moment would fail a well-lit game for a bad spawn and, worse,
    // would blame the lighting for it. If EVERY frame in the run is near-black, the scene is
    // unlit; if only the first is, the spawn is the defect and it gets its own line below.
    const bright = shots.reduce((a, b) => (b.buckets > a.buckets ? b : a));
    out.luminance = { p90: +bright.p90.toFixed(1), mean: +bright.mean.toFixed(1),
                      all: shots.map((s) => +s.p90.toFixed(0)) };
    // LEGIBILITY, not luminance. This was `p90 >= 60` -- the brightest tenth against a fixed
    // floor -- and that number is gameable in the one way that destroys a game: AMBIENT light.
    // Ambient is the only light type that removes shading, so flooding it lifts every pixel while
    // making every surface the same value. A generated maze did exactly that over four check
    // rounds (11 -> 11 -> 27 -> 59 -> 61), ending at `lights: false, manageColour: false,
    // AmbientLight 2.8`. It passed 23/23 and its walls were unreadable. The metric and its own
    // stated purpose moved in opposite directions.
    //
    // Measured across every frame this suite produces, plus that flooded maze:
    //     flooded maze (illegible)   7 buckets, p90 61   <- passed the old check
    //     the same maze's build 1    4 buckets, p90 11
    //     lowest healthy scene      21 buckets  (top-down)
    //     healthy range          21-380 buckets
    // Distinct colour buckets separate them by 3x. Luminance SPREAD does not -- the flooded maze
    // spans 24 and `driving`, a flat but brightly lit desert that reads perfectly, spans 22. The
    // question is not "how bright" nor "how much range" but "are the surfaces distinguishable".
    // The low absolute floor stays only to catch a frame that is essentially black but noisy.
    // IS THIS SAMPLE REPRESENTATIVE? Brightness is read from the BEST of a handful of frames, and
    // that only means something if the frames are of the GAME rather than of wherever the harness
    // happened to be wedged.
    //
    // A generated first-person maze passed this at 22 colours and p90 42 while being, in the
    // player's words, black in every direction they faced. The filmstrip explains it: all six
    // frames were close-ups of a brick wall at ~1.5 units, the one distance where that game was
    // bright, because a maze that publishes no exit position gives the harness nowhere to steer.
    // It drove into a wall and photographed it six times. Taking the BEST of six such frames then
    // certifies the game as legible.
    //
    // A first attempt gated this on how far the actor ROAMED, which does not catch it: the harness
    // moved several metres along the corridor while facing a wall the entire time. The condition
    // that does apply is the one the progress check already reports -- a game that publishes no
    // objective positions cannot be navigated to a representative view, so its frames are whatever
    // the harness bumped into.
    const legible = bright.buckets >= 14 && bright.p90 >= 25;
    // BOTH conditions, not either. Blind-driving alone is normal for whole genres -- an open
    // desert publishes no objectives and the harness still roams it and photographs it fine;
    // gating on that alone silently dropped legibility from three healthy scenes. What made
    // the maze's frames worthless is that it ALSO spent the drive jammed against geometry,
    // so the pictures are of the obstacle rather than of the game.
    if (blindDrive && wedged && legible) {
      sk('the scene is legible -- surfaces are distinguishable',
         'this game publishes no objective positions, so the harness had nowhere to steer and these '
         + 'frames are whatever it drove into -- not a sample of the game. A first-person maze was '
         + 'certified legible here on six close-ups of the wall it was pressed against, while being '
         + 'black in every direction the player faced. Publish where the objectives are, as '
         + '`screen: { exit: picker.project(exit.position) }`, and this can be judged on the game '
         + 'instead of one corner of it.');
    } else
    ck('the scene is legible -- surfaces are distinguishable', legible,
       `${bright.buckets} distinct colours, brightest tenth ${bright.p90.toFixed(0)}/255 `
       + `(whole frame ${bright.mean.toFixed(0)})`
       + (legible ? '' : bright.p90 < 25
          ? '. The frame is nearly black -- nothing is lit. Add a light that CASTS (directional or '
            + 'point), not just ambient.'
          : '. The frame is bright but FLAT: too few distinct colours means walls, floor and props '
            + 'all render at the same value and the player cannot read the space. Do NOT raise '
            + 'ambient light -- ambient lights every surface equally whichever way it faces, so it '
            + 'removes the shading that makes shape visible, and it is what produced this. Use a '
            + 'directional or point light for shape, and make adjacent surfaces differ in colour '
            + '(walls lighter than floor, floor lighter than ceiling). A dark game is fine; an '
            + 'undifferentiated one is not.'));

    // The spawn view specifically. A player whose first frame is black assumes the game is
    // broken, even when moving one step would reveal a lit corridor -- and a generated maze
    // shipped exactly that: "player starts in corner staring at wall".
    if (shots.length > 1 && bright.p90 >= 60 && shots[0].p90 < 30) {
      ck('the view at spawn is not a black wall', false,
         `the first frame's brightest tenth is ${shots[0].p90.toFixed(0)}/255 while the run `
         + `reaches ${bright.p90.toFixed(0)} -- the lighting is fine, the player just starts `
         + 'facing a wall or inside geometry. Spawn facing an open direction.');
    }
  }

  // ---- framing and reachable controls. Both came out of a benchmark against production,
  // where the SAME brief was built with and without this engine. Neither is a defect the
  // engine introduced -- production's mobile build had both -- which is precisely why they
  // belong here: they are what a 3D game on a phone gets wrong regardless of how it is made.
  // Sampled across a window, best taken. One reading failed our own lane runner at 26% and then
  // passed it on identical code, because a scene that recycles its world -- track segments,
  // chunks, spawned obstacles -- has more or less of it in view from moment to moment. The
  // question is whether the game CAN fill the frame, so a single unlucky instant is not an
  // answer. Fourth check in this file to need a window instead of a point.
  let cov = G.frameCoverage ? G.frameCoverage() : null;
  const covs = [];
  if (cov !== null) {
    for (let i = 0; i < 6; i++) {
      try { const c = G.frameCoverage(); if (c !== null) covs.push(c); } catch (e) {}
      await sleep(250);
    }
    if (covs.length) cov = Math.max(...covs);
  }
  if (cov === null) {
    sk('the world fills the frame', G.frameCoverage
       ? 'no visible content meshes to measure'
       : 'this build predates frameCoverage() in core/diagnostics.js');
  } else {
    // A world larger than the view reports ~1.0, which is the normal case. A small object
    // marooned in a big screen is the failure: a tower-defence board sat in the middle of
    // a portrait phone with empty margins top and bottom.
    ck('the world fills the frame', cov > 0.35,
       `content covers ${(cov * 100).toFixed(0)}% of the screen`
       + (covs.length > 1
          ? ` (best of ${covs.length} samples: ${covs.map((c) => (c * 100).toFixed(0)).join(', ')}%)`
          : '')
       + (cov > 0.35 ? '' : ' -- decide the orientation and frame from the live aspect ratio;'
                          + ' a wide world in a tall viewport wastes most of the screen'));
  }

  // TWO READOUTS IN THE SAME PLACE. Measured in the DOM, because a screenshot cannot tell
  // overstruck glyphs from a busy font and getState() cannot see pixels at all. One racing build
  // shipped this twice in one screen: createShell's `fields` chip drew "LAP 0/3" under the game's
  // own "0 km/h" (both pinned top-left, so the corner rendered as unreadable overstrike), and its
  // POSITION panel clipped the best-lap line. Every check passed -- the lap number was correct in
  // both places, which is all a state-based check can ask about.
  const collided = (() => {
    const win = window, doc = document;
    const boxes = [];
    const walk = (el) => {
      for (const c of el.children) {
        const cs = getComputedStyle(c);
        if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
        const b = c.getBoundingClientRect();
        if (b.width <= 0 || b.height <= 0) continue;
        // Only leaf-ish TEXT. A container that merely wraps two readouts overlaps them by
        // construction and is not a defect, so descend instead of reporting the parent.
        const own = [...c.childNodes]
          .filter((n) => n.nodeType === 3 && (n.textContent || '').trim()).length;
        if (own && b.height < win.innerHeight * 0.5 && b.width < win.innerWidth * 0.9) {
          boxes.push({ el: c, t: (c.textContent || '').trim().slice(0, 22), b });
        }
        walk(c);
      }
    };
    walk(doc.body);
    const hits = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        // A label nested inside its own chip overlaps it by construction, not by mistake.
        if (boxes[i].el.contains(boxes[j].el) || boxes[j].el.contains(boxes[i].el)) continue;
        const A = boxes[i].b, B = boxes[j].b;
        const ox = Math.min(A.right, B.right) - Math.max(A.left, B.left);
        const oy = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
        if (ox <= 2 || oy <= 2) continue;
        const area = ox * oy;
        const small = Math.min(A.width * A.height, B.width * B.height) || 1;
        if (area / small < 0.30) continue;          // a touching edge is not a collision
        hits.push(`"${boxes[i].t}" over "${boxes[j].t}"`);
      }
    }
    return hits.slice(0, 4);
  })();
  if (Array.isArray(collided)) {
    ck('two readouts are not drawn on top of each other', collided.length === 0,
       collided.length
         ? `${collided.join('; ')} -- overlapping text renders as overstruck glyphs nobody can `
           + 'read. Two HUDs is the usual cause: createShell\'s `fields` draws a row across the '
           + 'top, so a scene that also pins its own bar there gets both. Pick ONE -- either '
           + 'declare fields and let the shell draw them, or drop `fields` and keep your own bar '
           + '-- and still merge shell.report() into getState() either way. When both readouts '
           + 'are yours, give them different corners or lay them out in one flex row.'
         : 'no two text readouts overlap');
  }

  const clipped = G.clippedControls ? G.clippedControls() : null;
  if (clipped === null) {
    sk('no labelled control is cut off the screen',
       'this build predates clippedControls() in core/diagnostics.js');
  } else {
    ck('no labelled control is cut off the screen', clipped.length === 0,
       clipped.length ? `${clipped.join(', ')} extend past the screen edge -- half a button`
                        + ' is half a control the player cannot press'
                      : 'every labelled control is fully on screen');
  }

  // EVERY DRAWN CONTROL MUST BE PRESSABLE BY A FINGER.
  //
  // applyInput() writes straight into the region object, so a control the DOM makes unreachable
  // passes every other check in this file. Two properties decide it, and neither needs a click:
  // the element either lets the touch through to the canvas (pointer-events: none, which is how
  // every control this engine draws works) or catches it itself with a click handler. An element
  // that does neither eats the tap and nothing acts on it.
  //
  // Measured: this flags 6 of 7 controls in a generated tower defence and 4 of 4 in the engine's
  // own placement skeleton before that bug was fixed, and 0 across nine other games. Each verdict
  // was confirmed by clicking for real -- flagged controls did nothing, cleared ones worked.
  const unpressable = [...document.querySelectorAll('[data-region]')].filter((el) => {
    if (getComputedStyle(el).pointerEvents === 'none') return false;    // falls through, fine
    // A click reaches a DOM element two ways and only one goes through addEventListener.
    // `el.onclick = fn` is a property assignment the init-script shim cannot see, so checking only
    // the shim reports a working control as dead. Enumerated from the DOM rather than from the
    // games in front of me: of 60 generated builds only 2 use onclick -- exactly the kind of
    // minority a sample-driven rule misses, and a false failure sends an agent chasing nothing.
    for (let n = el; n; n = n.parentElement) if (n.__hasClick || n.onclick) return false;
    return true;
  }).map((el) => el.dataset.region);
  ck('every drawn control can be pressed by a finger', unpressable.length === 0,
     unpressable.length
       ? `${unpressable.join(', ')} -- the element sits over the canvas with pointer-events other `
         + 'than none and has no click handler, so the touch is swallowed and nothing reads it. '
         + 'Injected taps still work, which is why the checks above pass. Draw controls with '
         + 'pointer-events: none as core/controls.js does, or attach a real click listener.'
       : 'every labelled control either passes the touch to the canvas or handles it itself');

  ck('no errors after being driven', G.errors.length === 0, JSON.stringify(G.errors.slice(0, 3)));
  out.strip = strip;
  out.state = G.getState();
  out.fps = G.fps;
  out.info = G.info;
  return out;
}
"""

EYES = """
LOOK AT THE SCREENSHOT. These failures are invisible to every check above, and each
one of them shipped to a real user in this project:

  1. Do objects cast shadows onto the ground?
     Without shadows, everything -- crates, rocks, trees, the player -- reads as
     floating in mid-air. This was reported as "all objects are floating".
  2. Does the actor sit ON the surface?
     A body hovering a visible gap above its own wheels or feet reads as broken,
     even when the physics is correct.
  3. Can you tell where to touch?
     If no control is drawn on screen, the player cannot find it. Reported verbatim
     as "there is no particular drag handle".
  4. Is it bright enough, and is the palette coherent?
     A phone is held in daylight. Dusk lighting plus five unrelated hues reads as
     unfinished; a limited palette reads as designed.
  5. Is there anything to look at?
     An empty plain is characterless. Vertical landmarks give the eye something to
     steer by, which is what makes terrain feel like a place.
"""


def compose_filmstrip(strip, dest) -> "Path | None":
    """Lay the labelled frames out as one contact sheet.

    One image, because that is what actually reaches the agent. Six separate attachments get
    skimmed; a single sheet read left to right is a second of gameplay, and the defects this
    project keeps shipping are all one second long -- a countdown that never clears, a knob
    that never moves, a car that leans left under a frame labelled RIGHT.
    """
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return None
    tiles = []
    for f in strip or []:
        url = (f or {}).get('url') or ''
        if ',' not in url:
            continue
        try:
            raw = base64.b64decode(url.split(',', 1)[1])
            tiles.append(((f.get('label') or '')[:40], Image.open(io.BytesIO(raw)).convert('RGB')))
        except Exception:                          # noqa: BLE001 -- a bad frame is not fatal
            continue
    if len(tiles) < 2:
        return None
    TW, BAR, PAD, COLS = 320, 24, 8, 3
    th = max(1, round(TW * tiles[0][1].height / max(1, tiles[0][1].width)))
    rows = (len(tiles) + COLS - 1) // COLS
    sheet = Image.new('RGB', (COLS * TW + (COLS + 1) * PAD,
                              rows * (th + BAR) + (rows + 1) * PAD), (24, 24, 27))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.load_default(size=15)
    except TypeError:                              # Pillow < 10.1 takes no size
        font = ImageFont.load_default()
    for i, (label, im) in enumerate(tiles):
        c, r = i % COLS, i // COLS
        x = PAD + c * (TW + PAD)
        y = PAD + r * (th + BAR + PAD)
        draw.text((x + 2, y + 4), label, fill=(235, 235, 240), font=font)
        sheet.paste(im.resize((TW, th)), (x, y + BAR))
    sheet.save(dest)
    return dest


STRIP_EYES = """
  READ THE FILMSTRIP AS A SEQUENCE, not as separate pictures. It is one run, in order,
  and every question below is answered by COMPARING adjacent frames -- no single frame, and
  no check above, can answer any of them:

    1. Do frames 3 and 4 differ from each other?
       They are the SAME control, held for one second and for two. Identical tiles mean the
       game is not running: a countdown that never clears, an overlay still swallowing input,
       a step() returning early. This shipped as a build that passed and froze on the phone.
       Frame 2 is the moment before the drive begins -- if 2, 3 and 4 are all the same
       picture, nothing you wrote is executing at all.
    2. Does the WORLD move between 3 and 4 -- ground, walls, props sliding past?
       These tiles are the GL canvas only; the touch controls are DOM drawn over it and do
       not appear here, so judge motion by the scenery, not by the knob. For the controls
       themselves, open the single "frame (with UI)" shot.
    3. In frame 5, labelled RIGHT, does the actor actually turn right?
       If it leans left, the steering is mirrored -- reported here verbatim as "if we swipe
       right, its going left".
    4. Does anything change between 5 and 6?
       A game that ends the run looking exactly like it started it has no progress.
    5. Are the props the right size next to the player?
       Trees the size of houses only read as wrong with the player in frame for scale.
"""


def find_chrome() -> str | None:
    for c in CHROME_CANDIDATES:
        if Path(c).exists():
            return c
    for n in ('google-chrome', 'chromium', 'chromium-browser'):
        p = shutil.which(n)
        if p:
            return p
    return None


def _memo_path(scene: str) -> Path:
    return ROOT / 'dist' / f'.{scene}-attempts.json'


def _remember(scene: str, failed: list[str], passed: int = -1) -> tuple[int, int]:
    """Record this run and return (consecutive runs with NO IMPROVEMENT, fewest failures seen).

    The loop has no memory of its own, which is how a racing game spent seven check cycles and
    27 bundles oscillating between the same two failures -- and then shipped auto-steer toward
    the track centre to satisfy one of them. Nothing was able to notice that the game was being
    changed to fit the checker rather than the other way round. A file in dist/ is enough.

    Progress is judged on the FEWEST FAILURES ever seen, not on how many checks passed and not
    on the failure set being identical. Counting passes was wrong because the NUMBER OF CHECKS
    VARIES between runs -- which checks apply depends on what the game declares, and a real
    racing build saw totals of 18, 28, 29 and 30 in one session. Storing an absolute pass count
    then printed "Best ever reached: 29 of 28 checks", and worse: a run that passed ALL 28 after
    an earlier run passed 29 of 30 was recorded as no improvement. Failures are total-independent
    and progress is judged on the failure set being
    identical. An earlier version compared the sorted failure names, which fires on a run that
    is truly stuck and never on one that oscillates: fix check A, break check B, fix B, break A
    -- the set differs every time, so the counter resets to 1 forever. That is exactly the shape
    the racing game had (18/20 -> 19/20 -> 18/20 for seven cycles), i.e. the case this rule was
    written for was the one case it could not see. A run only resets the counter by beating the
    high-water mark, so trading one failure for another counts as the standstill it is.
    """
    p = _memo_path(scene)
    key = sorted(failed)
    runs, fewest = 0, -1
    try:
        old = json.loads(p.read_text(encoding='utf8'))
        runs = int(old.get('runs', 0))
        fewest = int(old.get('fewest', old.get('best', -1)))
    except Exception:
        pass
    here = len(key)
    if fewest < 0 or here < fewest:
        fewest, runs = here, 1          # genuine progress: fewer things broken than ever before
    else:
        runs = runs + 1 if key else 1
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({'failed': key, 'runs': runs, 'fewest': fewest}), encoding='utf8')
    except Exception:
        pass
    return runs, fewest


def repeat_warning(scene: str, failed: list[str], passed: int = -1, total: int = -1) -> str:
    runs, fewest = _remember(scene, failed, passed)
    if runs < 3:
        return ''
    here = f'{len(failed)} failing now'
    best = f'{fewest} at best' if fewest >= 0 else 'unknown'
    return (
        '\n'
        + '=' * 78 + '\n'
        + f'{runs} CONSECUTIVE RUNS WITH NO IMPROVEMENT. {here}; {best}'
        + (f' of {total} checks.\n' if total > 0 else '.\n')
        + '=' * 78 + '\n'
        'Stop changing the game to satisfy them. Three attempts that each altered how the game\n'
        'behaves and got no further than before is the signature of a check that is wrong for\n'
        'this genre, not a game that is broken in three different ways. Trading one failure for\n'
        'another is not progress -- that is why this counts the best score reached, not whether\n'
        'the same checks are failing.\n'
        '\n'
        'This is not hypothetical. A generated racing game failed "never stuck while the control\n'
        'is held" seven times, because the harness pushes the accelerator and cannot steer, so a\n'
        'closed circuit means a wall every time. To pass it the build added auto-steering toward\n'
        'the track centre -- a car that drives itself when you let go -- and still never went\n'
        'green. It cost 27 bundles and 75 turns.\n'
        '\n'
        'Report the failures and what you tried, and say which check you believe does not apply.\n'
        'A wrong check costs one message to say so, and a game whose handling was altered to\n'
        'appease it costs the player.\n')


def main() -> int:
    # Line-buffer stdout so every print lands when it is written. Python block-buffers when
    # piped, which is why the bundle-freshness lines above did not appear either under a
    # `timeout 60` -- the output existed and was sitting in a buffer nobody ever flushed.
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument('--scene', default='main')
    ap.add_argument('--no-bundle', action='store_true')
    ap.add_argument('--seconds', type=float, default=6.0, help='settle time before driving')
    ap.add_argument('--shot', default=None)
    # Override the orientation app.json declares. Framing cannot be judged in the wrong
    # aspect ratio, so being able to ask "what would this look like the other way up"
    # is how you test a framing fix without editing the project's config.
    ap.add_argument('--orientation', choices=('portrait', 'landscape'), default=None,
                    help='check in this orientation instead of the one app.json declares')
    ap.add_argument('--allow-placeholder', action='store_true',
                    help='the template itself ships unbuilt on purpose; a real project must not')
    args = ap.parse_args()
    global VIEWPORT, VIEWPORT_WHY
    if args.orientation:
        VIEWPORT = PORTRAIT if args.orientation == 'portrait' else LANDSCAPE
        VIEWPORT_WHY = f'{args.orientation} (forced with --orientation)'

    # What does the APP import? A built scene is worthless if the .ts the app reads is
    # still the placeholder. A generated game shipped GAME_HTML = "" and showed a black
    # screen on a real device, with the engine sitting unused beside it.
    ts = ROOT.parent / 'assets' / 'game' / 'gameHtml.ts'
    if ts.is_file() and not args.allow_placeholder:
        body = ts.read_text(encoding='utf8')
        built = 'GAME_HTML = ""' not in body and 'bundle was never built' not in body
        print(f"\n  {'PASS' if built else 'FAIL'}  the app imports a built bundle"
              f'   {ts} is {len(body):,} bytes')
        if not built:
            print('        the app is still importing the placeholder, so it will render the'
                  '\n        "bundle was never built" page instead of your game. Run:'
                  '\n          python3 bundle.py --scene main --ts ../assets/game/gameHtml.ts')
            APP_BUNDLE_MISSING.append(str(ts))
        else:
            # The project now ships a WORKING starter, so "not the placeholder" no longer
            # proves the bundle is yours: edit the scene, skip the rebuild, and the app
            # keeps running the starter -- a wrong game that looks like a working one.
            newest = max((f.stat().st_mtime for f in (ROOT / 'scenes').rglob('*.js')), default=0)
            core = max((f.stat().st_mtime for f in (ROOT / 'core').rglob('*.js')), default=0)
            src_at = max(newest, core)
            fresh = ts.stat().st_mtime >= src_at - 1
            print(f"  {'PASS' if fresh else 'FAIL'}  the bundle is newer than the game source")
            if not fresh:
                import datetime as _dt

                def fmt(t):
                    return _dt.datetime.fromtimestamp(t).strftime('%H:%M:%S')
                print(f'        the scene changed at {fmt(src_at)} but the bundle was built at'
                      f' {fmt(ts.stat().st_mtime)},'
                      '\n        so the app is still running the PREVIOUS game. Rebuild:'
                      '\n          python3 bundle.py --scene main --ts ../assets/game/gameHtml.ts')
                APP_BUNDLE_MISSING.append(str(ts) + ' (stale)')

    html = ROOT / 'dist' / f'{args.scene}.html'
    if not args.no_bundle:
        r = subprocess.run([sys.executable, str(ROOT / 'bundle.py'), '--scene', args.scene,
                            '--out', str(html)], capture_output=True, text=True)
        if r.returncode != 0:
            print('BUNDLE FAILED:\n' + (r.stderr or r.stdout))
            return 1
        print((r.stdout or '').strip())
    if not html.is_file():
        print(f'no bundle at {html}; drop --no-bundle')
        return 1

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print('playwright is not importable, so the game cannot be driven.\n'
              'The screenshot and the checks both need it: pip install playwright')
        return 1

    chrome = find_chrome()
    shot = Path(args.shot) if args.shot else ROOT / 'dist' / f'{args.scene}-frame.png'

    # Say this BEFORE the long silent part, and flush it. Every print below happens after the
    # browser run finishes, and stdout is block-buffered when piped -- so `timeout 60 python3
    # check.py` produces literally no output and reads exactly like a hang. A generated maze
    # concluded it had hung, wrote its own puppeteer harness with --disable-gpu
    # --disable-software-rasterizer (which is what REMOVES WebGL), got "no WebGL", called it a
    # CI limitation and shipped the game unverified while reporting it as fine. The run it gave
    # up on takes about two minutes and works.
    print(f'driving scene "{args.scene}" in headless chromium. This takes roughly two minutes and\n'
          'prints nothing until it finishes -- there is no progress to report while the browser\n'
          'runs the game. Do NOT kill it, and do NOT substitute another browser harness: WebGL\n'
          'works here via --enable-unsafe-swiftshader below, so a "no WebGL" result from your own\n'
          'launcher means your own flags removed it.', flush=True)

    with sync_playwright() as ctx:
        launch = {'headless': True, 'args': ['--no-sandbox', '--enable-unsafe-swiftshader']}
        if chrome:
            launch['executable_path'] = chrome     # ms-playwright browsers may be absent
        browser = ctx.chromium.launch(**launch)
        page = browser.new_page(viewport=VIEWPORT)
        errors: list[str] = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        # WHO CAN CATCH A TAP? Installed BEFORE the bundle runs, so it sees every listener the
        # game registers. Pointer listeners live on the canvas, so a DOM control is pressable
        # only if it lets the touch through (pointer-events: none) or catches it itself with a
        # click handler. An element that does neither is invisible to every other check in this
        # file, because applyInput() writes straight into the region and never touches the DOM.
        # The engine shipped exactly that bug in its own shelf control, and a generated tower
        # defence inherited it: six of its seven controls could not be pressed by a finger while
        # it passed 18 of 18.
        page.add_init_script("""
          (() => {
            const orig = EventTarget.prototype.addEventListener;
            EventTarget.prototype.addEventListener = function (type, fn, opts) {
              if (type === 'click' || type === 'pointerdown' || type === 'pointerup') {
                try { this.__hasClick = true; } catch (e) {}
              }
              return orig.call(this, type, fn, opts);
            };
          })();
        """)
        page.goto(html.resolve().as_uri())
        page.wait_for_timeout(int(args.seconds * 1000))

        # ---- CAN A FINGER START THIS GAME? Asked with a REAL pointer event, from out here.
        #
        # Everything in DRIVER reaches controls through G.applyInput(region, ...), which writes
        # straight into region state and never touches the DOM. That is fast and it is blind: it
        # bypasses hit-testing, z-order, visibility and pointer-events, so the harness can operate
        # controls no human can reach. Three generated games froze on a start screen and every one
        # of them passed every check:
        #   * a runner wrote `display:none` into the overlay's cssText AFTER show(), leaving an
        #     INVISIBLE start screen -- the harness tapped its region by name and started the game
        #     through a button nobody could see;
        #   * a racing build put a full-screen overlay at `pointer-events:auto` with no click
        #     handler, so every real touch was swallowed while injection sailed past it;
        #   * an island explorer declared a broad invisible region over its D-pad and three of the
        #     four buttons were dead to a finger and fine to the harness.
        # A click dispatched by the browser at real coordinates obeys all the rules a finger obeys.
        # This is the only check in the file that does, and it is the one that catches this class.
        start_tap = None
        try:
            gate = page.evaluate(START_GATE_JS)
            if gate:
                spot = page.evaluate(ACTION_SPOT_JS)
                if spot:
                    page.mouse.click(spot['x'], spot['y'])
                    page.wait_for_timeout(450)
                after = page.evaluate(START_GATE_JS)
                start_tap = {'gate': gate, 'spot': spot, 'cleared': not after, 'after': after}
        except Exception as e:                       # noqa: BLE001 -- never abort the run
            start_tap = {'gate': None, 'spot': None, 'cleared': None, 'error': str(e)[:200]}
        page.evaluate('(v) => { window.__START_TAP__ = v; }', start_tap)

        try:
            res = page.evaluate(DRIVER)
        except Exception as e:                     # noqa: BLE001 -- report, never crash
            res = {'checks': [{'name': 'the driver ran', 'ok': False, 'detail': str(e)[:300]}],
                   'frame': None, 'state': None, 'fps': None, 'info': None}
        # Full-page shot so on-screen controls (drawn as DOM) appear too.
        page.screenshot(path=str(shot))
        browser.close()

    checks = res.get('checks', [])
    skipped = res.get('skipped', [])
    print()
    for c in checks:
        print(f"  {'PASS' if c['ok'] else 'FAIL'}  {c['name']}"
              + (f"   {c['detail']}" if c['detail'] else ''))
    # Printed, never hidden: "11/11 passed" while four invariants silently did not run is
    # how an unplayable game got a clean bill of health.
    for sp in skipped:
        print(f"  SKIP  {sp['name']}   ({sp['why']})")
    if res.get('idleChange') is not None:
        print(f"\n  with nobody playing, {res['idleChange']}% of the picture changed over 5 s"
              '\n        (an idle animation is fine; a large number means something moves on its own)')
    if errors:
        print('\n  page errors:')
        for e in errors[:4]:
            print(f'    {e[:200]}')

    if res.get('frame'):
        gl = shot.with_name(shot.stem + '-gl.png')
        gl.write_bytes(base64.b64decode(res['frame'].split(',', 1)[1]))
        # Reusing the same quote character INSIDE an f-string expression is PEP 701, i.e.
        # Python 3.12+. The pods that run this ship 3.11, where it is a SyntaxError -- and it
        # is a syntax error in the file that verifies every generated game, so two builds spent
        # turns repairing the checker instead of their own game. Keep the subscripts outside.
        vw, vh = VIEWPORT['width'], VIEWPORT['height']
        print(f'  tested in {vw}x{vh} -- {VIEWPORT_WHY}')
        print(f'\n  frame (GL only):  {gl}')
    print(f'  frame (with UI):  {shot}')
    sheet = None
    if res.get('strip'):
        try:
            sheet = compose_filmstrip(res['strip'], shot.with_name(shot.stem + '-filmstrip.png'))
        except Exception as e:                     # noqa: BLE001 -- never fail a run over a picture
            print(f'  (filmstrip not composed: {e})')
    if sheet:
        print(f'  FILMSTRIP:        {sheet}   <- {len(res["strip"])} labelled moments, in order')
    if res.get('state'):
        print(f"\n  state: {json.dumps(res['state'])[:400]}")
    print(f"  fps={res.get('fps')} info={res.get('info')}"
          '   (a desktop software renderer; not a device framerate)')
    if sheet:
        print(STRIP_EYES)
    print(EYES)

    failed = [c['name'] for c in checks if not c['ok']]
    if APP_BUNDLE_MISSING:
        failed.append('the app imports a built, current bundle')
    passed = len(checks) - len(failed)
    # The DENOMINATOR INCLUDES THE SKIPS when there are any, because the number printed here is
    # the number that gets repeated to the user, and "20/20 checks passed" was being repeated
    # without the skip count every single time. Six builds reported a clean score to a user while
    # this line said "NOT fully checked" two words later -- a runner at 20/20 with 7 skipped, a
    # tower defence at 18/18 with 10. Asking for the skips to be mentioned did not work; making
    # the honest figure the ONLY figure does, because there is no longer a flattering number to
    # quote instead.
    if skipped:
        print(f'{passed} of {len(checks) + len(skipped)} checks passed -- {len(skipped)} could '
              f'not run, so this game was NOT fully checked '
              f'({passed}/{len(checks)} of the ones that did)')
    else:
        print(f'{passed}/{len(checks)} checks passed')
    # A perfect score over a mostly-skipped run is not a pass, and it reads like one. A generated
    # tower defence printed "17/17 checks passed, 11 skipped" -- every control region among the
    # skips, each noting "Nothing that depends on driving this region was verified" -- and shipped
    # with nothing a finger could press. Say what was NOT established, next to the number.
    if skipped and not failed and len(skipped) >= max(3, len(checks) // 3):
        print(f'  UNVERIFIED: {len(skipped)} of {len(checks) + len(skipped)} checks did not run.'
              '\n  A clean score over that many skips does not mean the game works -- it means'
              '\n  most of it was never exercised. Read the SKIP lines above: each names'
              '\n  something this run could not establish.')
    if failed:
        print('FAILED: ' + ', '.join(failed))
        print(repeat_warning(args.scene, failed, passed, len(checks)), end='')
        return 1
    _remember(args.scene, [], passed)
    print('Checks passed. They do NOT tell you it looks right -- open the screenshot.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
