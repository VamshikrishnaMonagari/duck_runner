import * as THREE from '../vendor/three.module.js';
import { _solidsCreated, _bodiesCreated } from './collide.js';
import { _contactsCreated } from './contact.js';

const _ray = new THREE.Raycaster();
const _down = new THREE.Vector3(0, -1, 0);
const _from = new THREE.Vector3();
const _hereNow = new THREE.Vector3();

const SHOVED = 0.25;         // metres: a prop the actor pushed has moved this far; a wall has not.
const SELF_PROPELLED = 6;    // metres of cumulative travel: a shoved prop covers single digits
                             // in a whole run, a car under power covers hundreds.

/** Penetration is an EVENT, not a state. The first version sampled once after the drive had
 *  finished -- by which time a car at 14 m/s had gone through the wall AND out the far side, so
 *  the fixture written to prove the check works passed instead. Accumulate as the game runs. */

/**
 * The QA seam. Exposes frame stats, collected errors, a state getter and a way
 * to inject input, so an automated check can drive the scene and assert on the
 * result instead of a human doing it.
 *
 * One rule governs what belongs here: a check is only real if the harness has its
 * OWN source for the number. An audit of 21 generated games found the grounding
 * check did real work in 3 of them -- 9 reported a constant, 2 computed groundY
 * from the actor's own position (making clearance a fixed 0.5 m that could not
 * fail), and the rest reported nothing. So `probeGround` below measures the scene
 * directly instead of asking the game how high its ground is.
 */
export function attachDiagnostics({ host, loop, input, getState = () => ({}), actor = null, reset = null }) {
  const ray = new THREE.Raycaster();
  const DOWN = new THREE.Vector3(0, -1, 0);
  const origin = new THREE.Vector3();
  const actorPos = new THREE.Vector3();
  const _screenV = new THREE.Vector3();
  const _footBox = new THREE.Box3();

  const partOfActor = (obj) => {
    for (let o = obj; o; o = o.parent) if (o === actor) return true;
    return false;
  };

  /** Ground height under a world position, measured by raycasting the real scene.
   *  Independent of anything the game reports, which is the whole point: a game
   *  cannot satisfy this by choosing a convenient number. Needs `actor` so the
   *  actor's own body is not mistaken for the ground it stands on; without it the
   *  checker reports an honest skip rather than a number nobody verified. */
  function probeGround(x, z, fromY = 500) {
    if (!actor) return null;
    origin.set(x, fromY, z);
    ray.set(origin, DOWN);
    const surfaces = [];
    for (const h of ray.intersectObjects(host.scene.children, true)) {
      if (partOfActor(h.object) || h.object.userData.notGround) continue;
      surfaces.push(h.point.y);
    }
    if (!surfaces.length) return null;

    // Take the surface UNDERFOOT, not the topmost one. Returning the first hit from 500 m up
    // means any geometry ABOVE the player is reported as the ground: a roof, a tunnel, a
    // bridge, an archway, or a hollow prop the player is standing inside. Measured on the
    // first-person reference scene -- the camera walked inside a 2.67 m block, the downward
    // ray struck its roof, and clearance came out as -0.97 m, failing "the actor is not sunk
    // into the ground" on a camera standing 1.7 m above a flat floor.
    //
    // Hits from a downward ray arrive highest-first, so the highest surface at or below the
    // actor is what it is standing on. When NOTHING is at or below it, the actor really is
    // underneath the world and the topmost hit is returned so the sunk check still fires.
    actor.getWorldPosition(actorPos);
    let best = null;
    for (const y of surfaces) if (y <= actorPos.y + 0.02 && (best === null || y > best)) best = y;
    return best === null ? surfaces[0] : best;
  }

  /** How much of the screen the world actually occupies, 0..1.
   *
   *  A benchmark run put a tower-defence board in the middle of a portrait phone with
   *  large empty margins above and below -- "the orientation of the field is not that
   *  good". fitBounds was working correctly; fitting a WIDE world into a TALL viewport
   *  simply leaves margins, and nothing measured the result. Prose telling the scene to
   *  pick an orientation is in the README and the prompt and was ignored in two of three
   *  runs, so this measures instead of advising.
   *
   *  Background shells are excluded: a sky sphere or a tube drawn with BackSide encloses
   *  the camera, so counting it would report full coverage for every scene.
   */
  function frameCoverage() {
    const box = new THREE.Box3();
    let any = false;
    host.scene.traverse((o) => {
      if (!o.isMesh || !o.visible || !o.geometry) return;
      const m = o.material;
      const side = Array.isArray(m) ? (m[0] && m[0].side) : (m && m.side);
      if (side === THREE.BackSide) return;               // an enclosing shell, not content
      box.expandByObject(o);
      any = true;
    });
    if (!any || box.isEmpty()) return null;

    // Content reaching behind the eye cannot be measured by projecting corners: a point
    // behind the camera projects to nonsense. It also cannot be BADLY FRAMED -- the viewer
    // is inside the world, so the world fills the view by definition. This is the exact
    // trap documented in host.js that made fitBounds overshoot by 3x, and I walked into it
    // again in a new function: a first-person scene reported 0% coverage and an open-world
    // explorer 20%, both of which fill the screen completely.
    const cam = host.camera;
    cam.updateMatrixWorld();
    if (box.containsPoint(cam.position)) return 1;
    const near = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      near.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      near.applyMatrix4(cam.matrixWorldInverse);
      if (near.z > -cam.near) return 1;                // this corner is at or behind the eye
    }

    const v = new THREE.Vector3();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      v.project(host.camera);
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
      minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
    }
    const w = Math.max(0, Math.min(1, maxX) - Math.max(-1, minX)) / 2;
    const h = Math.max(0, Math.min(1, maxY) - Math.max(-1, minY)) / 2;
    return +(w * h).toFixed(3);
  }


  /** Labelled controls drawn partly off the screen. Returns their labels.
   *
   *  A generated tower defence drew its tower picker wider than the phone, so "Basic" and
   *  "Start Wave" were sliced in half at the screen edges -- the primary action of the
   *  game, half unreachable. Only elements carrying a short label are considered, because
   *  those are the buttons; a full-bleed canvas sitting exactly on the edge is not a bug.
   */
  const _pen = [];
  const _lastPos = new Map();
  const _travel = new Map();
  const _actorish = new Set();
  const _travelOf = (o) => _travel.get(o.uuid) || 0;
  function _track(o) {
    const key = o.uuid;
    _hereNow.setFromMatrixPosition(o.matrixWorld);
    const prev = _lastPos.get(key);
    if (!prev) { _lastPos.set(key, _hereNow.clone()); return; }
    const step = _hereNow.distanceTo(prev);
    prev.copy(_hereNow);
    if (step < 1e-4) return;
    const t = _travelOf(o) + step;
    _travel.set(key, t);
    if (t >= SELF_PROPELLED) _actorish.add(key);
  }
  let _penFrame = 0;
  let _spawn = null;
  const _spawnNow = new THREE.Vector3();
  function _accumulatePenetration() {
    // Every 12th frame -- about 5 Hz. Fast enough to catch a wall at any speed a phone renders,
    // cheap enough to disappear next to the render itself.
    if ((_penFrame++ % 12) !== 0 || _pen.length >= 4) return;
    // Not until the actor has actually gone somewhere. A scene that spawns its actor at the
    // origin and then places it on the ground overlaps something for a frame or two, and that
    // is setup, not a player driving through a wall.
    if (!actor) return;
    actor.getWorldPosition(_spawnNow);
    if (!_spawn) { _spawn = _spawnNow.clone(); return; }
    if (_spawnNow.distanceTo(_spawn) < 1.5) return;
    for (const m of (api._intersectNow() || [])) {
      const had = _pen.find((x) => x.name === m.name && String(x.size) === String(m.size));
      if (!had) { _pen.push(m); continue; }
      // UPGRADE, never downgrade. The first time any mesh is seen there is no previous position
      // to compare against, so it is classified static by default -- and a plain de-dupe then
      // kept that first guess forever, labelling four self-propelled rival cars as scenery and
      // sending the fix to the wrong module. Travel is only known from the second sample on.
      if (m.kind === 'actor') had.kind = 'actor';
    }
  }

  function clippedControls() {
    const W = window.innerWidth, H = window.innerHeight, out = [];
    for (const el of document.body.querySelectorAll('*')) {
      const t = (el.textContent || '').trim();
      if (!t || t.length > 24 || el.children.length) continue;      // a leaf with a label
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none' || +st.opacity === 0) continue;
      if (r.right > W + 2 || r.left < -2 || r.bottom > H + 2 || r.top < -2) {
        out.push(`"${t.slice(0, 18)}"`);
        if (out.length >= 4) break;
      }
    }
    return out;
  }

  let frames = 0, fps = 0, acc = 0, last = performance.now();
  const longFrames = [];

  let _frameSeen = -1;
  function onFrame() {
    // Idempotent per rendered frame. The loop calls this itself, and every scene written before
    // it did also calls it by hand; counting both would double the reported fps.
    const f = loop && typeof loop.frame === 'number' ? loop.frame : -1;
    if (f >= 0 && f === _frameSeen) return;
    _frameSeen = f;
    _accumulatePenetration();
    const now = performance.now();
    const d = now - last; last = now; acc += d; frames++;
    if (d > 50) longFrames.push(Math.round(d));
    if (acc >= 500) { fps = Math.round((frames * 1000) / acc); frames = 0; acc = 0; }
  }

  // Subscribe the per-frame tail to the loop, so neither call can be forgotten by a scene.
  // Scenes written before this still call diag.onFrame() and input.endFrame() by hand: onFrame
  // is idempotent per rendered frame, and clearing an already-cleared gesture is a no-op, so
  // both paths coexist. A scene now needs to do nothing at all for either to happen.
  if (loop && typeof loop.onFrame === 'function') {
    loop.onFrame(() => {
      onFrame();
      if (input && typeof input.endFrame === 'function') input.endFrame();
    });
  }

  const api = {
    onFrame,
    get fps() { return fps; },
    get longFrames() { return longFrames.slice(-20); },
    get errors() { return host.errors.slice(); },
    /** Let engine modules report a scene-authoring bug into the error list the checks read.
     *  `errors` above is a COPY, so pushing to it does nothing -- controls.js tried exactly
     *  that when reporting a button given a non-numeric anchor, and the message vanished. */
    reportError(msg) { host.errors.push(String(msg)); },
    get info() { const i = host.renderer.info; return { drawCalls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures }; },
    getState,
    /** Optional: put the game back to a known state. Automated checks call this before
     *  measuring anything precise, because a measurement taken from wherever the previous
     *  check happened to leave the player is not a measurement of the game.
     *
     *  This was `typeof reset === 'function' ? reset : null` while `reset` was not a
     *  parameter of this function -- so it resolved to nothing in scope, was always null,
     *  and every `await reset()` in check.py was a silent no-op for every game ever run.
     *  explorer.js had been passing a correct reset() the whole time and it was discarded
     *  here. Measured cost: the direction check on a car travelled 30.8 m and 35.6 m on its
     *  first two attempts and then 1.0, 0.9 and 0.3 m, because the car was parked against
     *  the world barrier by earlier checks and never put back. A generated coin game failed
     *  its progress check three times for the same reason and shipped with a broken counter,
     *  its agent correctly observing that "the checker drives the player to the edge of the
     *  world". Passing an argument the callee does not accept fails silently in JS, so the
     *  absence is also reported as a visible SKIP by check.py rather than assumed. */
    reset: typeof reset === 'function' ? reset : null,
    // The generic checker cannot guess what a game called its controls, so the game
    // reports them. Without this, an automated check can only verify that something
    // rendered -- never that the controls do anything.
    regions: () => input.names(),
    // Injecting into an unregistered region is recorded as an error rather than
    // ignored, so a mistyped name fails the "no runtime errors" check instead of
    // masquerading as a scene that does not respond to input.
    applyInput(region, vec) {
      if (input.inject(region, vec || {}) === false) {
        // Only a region that does not EXIST is an error. inject also refuses a tap aimed
        // outside the region's hit area, which is a legitimate miss by a checker probing
        // where a game's objects are -- reporting that as "no such region" would be a
        // false message, and it would fail the no-errors check on a healthy game.
        if (!input.region(region)) {
          host.errors.push(`applyInput: no such region '${region}'; scene has [${input.names().join(', ')}]`);
        }
        return false;
      }
      loop.invalidate && loop.invalidate();
      return true;
    },
    releaseInput(region, opts = {}) {
      if (input.inject(region, { down: false, ...(opts || {}) }) === false) {
        if (!input.region(region)) {
          host.errors.push(`releaseInput: no such region '${region}'; scene has [${input.names().join(', ')}]`);
        }
        return false;
      }
      // Wake the loop on RELEASE too. A tap is only complete when the finger lifts, so on
      // a render-on-demand loop the tap was recorded and then never read by any frame --
      // the game looked like it ignored input entirely. This hits real games, not just the
      // checker: anything that acts on release drops the event while the loop is idle.
      loop.invalidate && loop.invalidate();
      return true;
    },
    captureFrame: () => host.captureFrame(),
    /** World Y of the LOWEST point of the actor's geometry, or null if it has none.
     *
     *  The grounding checks measured `pos.y` -- the actor's ORIGIN -- against the ground, and an
     *  origin means nothing consistent: a vehicle's sits on the ground and reports 0.00, an
     *  avatar's sits at its centre and legitimately reports half its height. So the tolerances
     *  had to be metres wide (sunk below -0.2 m, hovering above 2.0 m), and a generated island
     *  explorer whose feet visibly clipped into the terrain cleared them by an order of
     *  magnitude in every one of six builds.
     *
     *  The bottom of the bounding box has no convention to guess at: it should sit ON the
     *  surface, whatever the origin does. A camera has no geometry, so this returns null and the
     *  origin-based checks stay in charge for first-person. */
    actorFootY() {
      if (!actor) return null;
      _footBox.setFromObject(actor);
      if (_footBox.isEmpty()) return null;
      const y = _footBox.min.y;
      return Number.isFinite(y) ? y : null;
    },
    /** Project a world point to CSS pixels, so a checker can ask "did this move screen-LEFT or
     *  screen-RIGHT" without knowing anything about the camera.
     *
     *  Every movement check here compared WORLD coordinates, which is why a mirrored lateral
     *  axis was invisible: a generated lane runner travelled +Z with the camera behind it, so
     *  cross(forward, up) made +X screen-LEFT, and its `LANE_X = [-2, 0, 2] // left, center,
     *  right` sent the player the wrong way on a device while every world-space assertion
     *  passed. Screen space is the only frame in which "the player swiped right and the player
     *  went right" is even expressible. */
    screenOf(world) {
      if (!world) return null;
      const x = Array.isArray(world) ? world[0] : world.x;
      const y = Array.isArray(world) ? world[1] : world.y;
      const z = Array.isArray(world) ? world[2] : world.z;
      if (![x, y, z].every((n) => Number.isFinite(n))) return null;
      const v = _screenV.set(x, y, z).project(host.camera);
      const el = host.renderer.domElement;
      const w = el.clientWidth || el.width || 1;
      const h = el.clientHeight || el.height || 1;
      return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, z: v.z };
    },
    probeGround,
    frameCoverage,
    clippedControls,
    /** WHICH MESHES IS THE ACTOR CURRENTLY INSIDE? Nobody can legitimately be inside a
     *  building, so this is a fact rather than a threshold.
     *
     *  It exists because "collision runs" and "collision covers what a player will hit" are
     *  different claims, and only the first was checkable. A racing build registered five
     *  barriers with createSolids, called resolve() fifty-two times, passed every check --
     *  and left the rival cars and every scenery prop unregistered, on purpose: "AI cars
     *  won't use solids collision at all, they only need to follow waypoints". On a device
     *  you drove through all of it.
     *
     *  Excluded, and both are facts and not tuning: a mesh whose box also contains the
     *  CAMERA is a room or a skybox and the actor is supposed to be inside it, and a
     *  BackSide material is the same thing seen from within. The actor's own hierarchy is
     *  skipped too. */
    _intersectNow() {
      if (!actor || !host || !host.scene) return [];
      const A = new THREE.Vector3();
      actor.getWorldPosition(A);
      const cam = new THREE.Vector3();
      host.camera.getWorldPosition(cam);
      const own = new Set();
      actor.traverse((o) => own.add(o));
      let p = actor;
      while (p) { own.add(p); p = p.parent; }
      const out = [];
      const box = new THREE.Box3();
      let kind = 'static';
      // Everything below the actor, so the surface it rests on is never reported as penetration.
      // Cast from HIGH ABOVE the actor's column, not from the actor. A ray starting inside a
      // mesh does not hit it -- backfaces are not tested -- so a car momentarily below a hill
      // never saw the terrain in this set, and the terrain got reported as something it had
      // driven through. That false-positived our own driving and explorer scenes. From above,
      // the ray enters every surface in the column from outside and hits all of them.
      const underfoot = new Set();
      _from.set(A.x, A.y + 200, A.z);
      _ray.set(_from, _down);
      _ray.far = 600;
      // Only surfaces AT OR BELOW the actor's own height count as something it stands on.
      // Without that, a ray from above hits the TOP of the very wall the actor is inside and
      // excuses it -- which silently disarmed the check on a fixture built to fail.
      for (const h of _ray.intersectObjects(host.scene.children, true)) {
        if (h.point.y <= A.y + 0.05) underfoot.add(h.object);
      }
      host.scene.traverse((o) => {
        if (!o.isMesh || own.has(o) || out.length >= 4) return;
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        if (m && m.side === THREE.BackSide) return;          // a room, seen from inside

        // TRACK FIRST. Travel needs history from BEFORE the encounter: a rival eight metres
        // ahead must already be known to be moving by the time the actor reaches it, or it is
        // classified on its first and only overlap sample and filed as scenery. Rejecting
        // distant meshes before tracking them caught one rival out of four. This is a matrix
        // read and a Map write; setFromObject below is the expensive part, not this.
        _track(o);

        // CHEAP REJECT SECOND. setFromObject walks the geometry, and doing it for every mesh in
        // the scene five times a second added enough per-frame work to tip the starter scene's
        // progress check, which sits at 0.14/s and has almost no margin. A bounding sphere is
        // cached on the geometry after the first call, so this costs one distance test.
        if (o.geometry) {
          if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
          const bs = o.geometry.boundingSphere;
          if (bs) {
            _hereNow.setFromMatrixPosition(o.matrixWorld);
            const sc = o.matrixWorld.getMaxScaleOnAxis();
            if (_hereNow.distanceTo(A) > bs.radius * sc + 4) return;
          }
        }
        box.setFromObject(o);
        if (box.isEmpty()) return;
        if (!box.containsPoint(A)) return;
        if (box.containsPoint(cam)) return;                  // a room or a skybox
        const sz = box.getSize(new THREE.Vector3());
        void kind;
        // A floor is a box you stand ON, not one you are IN. A flat floor is easy -- the actor
        // is above its top face. DISPLACED TERRAIN is not: a 240x240 heightfield with 4 m hills
        // has an 8 m tall bounding box, so a car sitting in a dip at y=1.43 is inside it, and
        // the first version of this check failed our own driving scene for exactly that. A box
        // is a poor model of a heightfield, so ask the geometry instead of the box: whatever a
        // ray straight down from the actor hits IS the ground, and you cannot pass through the
        // thing you are standing on.
        if (A.y >= box.max.y - 0.02) return;
        if (underfoot.has(o)) return;
        // THREE buckets, not two. The first version excused everything that had not travelled
        // SELF_PROPELLED metres -- which is true of every wall in every game, so `static` below
        // was unreachable and this check could not fail. It passed a car driving through a wall
        // placed dead ahead of its own spawn. What deserves excusing is a prop the actor has
        // SHOVED: it has moved a little, because the actor pushed it, and a rigid-body solver
        // interpenetrates by design. A wall has not moved at all. Travel separates the three:
        //   ~0            a wall, a barrier, a building   -> report, kind 'static'
        //   SHOVED..6 m   a crate the actor pushed        -> excuse
        //   >= 6 m        a rival, a vehicle, an enemy    -> report, kind 'actor'
        const _t = _travelOf(o);
        const _isActor = _actorish.has(o.uuid) || _t >= SELF_PROPELLED;
        if (!_isActor && _t > SHOVED) return;                // a shoved prop
        kind = _isActor ? 'actor' : 'static';
        out.push({ name: o.name || o.type, kind, uuid: o.uuid,
                   size: [+sz.x.toFixed(1), +sz.y.toFixed(1), +sz.z.toFixed(1)] });
      });
      return out;
    },
    /** Every mesh the actor has been inside since load. */
    /** RE-CLASSIFIED at report time, not trusted from the sample.
     *
     *  Travel is only known from the second sample of a mesh onward, so a crate the actor is
     *  about to shove has travelled 0 at the instant of contact and looks like a wall. That
     *  made this check fail the explorer scene intermittently -- a physics prop reported as
     *  static geometry. By the time the drive is over the crate has moved metres, so ask again
     *  here: whatever is still at ~0 travel never moved, and that is the definition of a wall.
     *  Same reasoning as the UPGRADE rule above, applied at the other end. */
    penetrations: () => _pen.filter((m) => {
      if (!m.uuid) return true;                       // pre-uuid record; keep it
      const t = _travel.get(m.uuid) || 0;      // _travelOf takes an Object3D, not a uuid
      if (_actorish.has(m.uuid) || t >= SELF_PROPELLED) { m.kind = 'actor'; return true; }
      return !(t > SHOVED);                           // moved a little => the actor shoved it
    }).map((m) => ({ ...m })),
    /** Modules that were CREATED but may never have been fed. A racing build called
     *  createSolids, registered its buildings, and never called resolve() -- so the car drove
     *  through every wall while 32 of 32 checks passed. Existence is not wiring. */
    engineUse: () => ({
      solids: _solidsCreated.map((s) => ({ shapes: s.discs.length + s.boxes.length, resolves: s.resolves })),
      contacts: _contactsCreated.map((c) => ({ items: c.count, steps: c.steps })),
      bodies: _bodiesCreated.map((b) => ({ items: b.count, separations: b.separations,
                                           overlapping: b.overlapping() })),
    }),
    /** Per-region: is the element this region is bound to reachable by a finger right now?
     *  Absent keys are bare hit areas, which have no element and so nothing to hide. */
    boundVisibility: () => (input.boundVisibility ? input.boundVisibility() : {}),
    /** True when the scene identified its avatar, so the checker can tell "measured
     *  and fine" apart from "never measured". */
    hasActor: () => !!actor,
    frameStats() { return { fps, frame: loop.frame, simTime: +loop.simTime.toFixed(3), longFrames: longFrames.length }; },
  };
  globalThis.__GAME__ = api;
  return api;
}
