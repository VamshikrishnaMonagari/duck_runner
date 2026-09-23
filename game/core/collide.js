import * as THREE from '../vendor/three.module.js';

// Deferred, because these helpers run inside the loop and the loop starts before
// attachDiagnostics in some scenes -- controls.js lost its first warning entirely that way.
function report(msg) {
  setTimeout(() => {
    const g = globalThis.__GAME__;
    if (g && typeof g.reportError === 'function') g.reportError(msg);
    else console.error(msg);
  }, 0);
}

/**
 * SOLIDS, GROUND and BOUNDS -- the collision every genre needs, without a physics solver.
 *
 * Named `collide`, not `physics`, on purpose: cannon-es is vendored for real rigid-body work,
 * but almost every collision failure measured here needed none of it --
 *
 *   walking through trees        props were drawn and then forgotten
 *   a coin inside a tree trunk   once props became solid, the pickup was unreachable
 *   stuck at the track border    leaving the drivable surface with no recovery
 *   floating on water            nothing stopped the player at the shoreline
 *   maze walls                   the genre that bypassed the engine twice, because grid
 *                                collision had no support here at all
 *
 * -- and the one thing a solver WOULD have to own, terrain, must not use it: our own notes
 * record CANNON.Trimesh against a heightfield at roughly 80 ms per frame, i.e. 12 FPS. Ground
 * is sampled analytically from the same height function the mesh was built from.
 *
 * Every function takes a desired position and returns a corrected one, so a scene writes
 * `pos.copy(solids.resolve(pos, r))` and never computes a normal or a sign itself. That is the
 * same property that made motion.js work: the error-prone arithmetic lives in one place.
 */

const _v = new THREE.Vector3();
const _box = new THREE.Box3();
// A separate scratch from _v: confine() feeds place(), so one buffer would have
// place() read the vector it had just overwritten.
const _c = new THREE.Vector3();

/** Circle and box colliders in the XZ plane, with push-out resolution.
 *
 *  Resolution runs a few passes rather than one, because pushing an actor out of one collider
 *  can push it into its neighbour -- the corner case that leaves a player wedged between two
 *  trees, which is the failure the "never let the player get permanently stuck" rule exists for.
 *  Passes are capped so a genuinely impossible corner ends in the least-bad position instead of
 *  looping forever. */
/** Every solids instance ever created in this bundle. Diagnostics reads it so a scene cannot
 *  hide an abandoned one by simply not reporting it -- which is the same starvation the counter
 *  exists to catch, one level up. Creating the module is enough to be seen. */
export const _solidsCreated = [];
export const _bodiesCreated = [];

/**
 * ACTORS THAT MUST NOT OCCUPY THE SAME SPACE. createSolids handles the world -- walls, props,
 * anything that never moves. This handles the things that do: rival cars, enemies, NPCs, a
 * player and a pushable crate.
 *
 * It exists because nothing owned it, and four racing builds in a row therefore left it out ON
 * PURPOSE. Their own words: "AI cars won't use solids collision at all -- they only need to
 * follow waypoints, and steering toward those points naturally keeps them within track
 * boundaries." Every one of them shipped, and every one let the player drive straight through
 * the field. It is not a racing problem: any game with more than one actor has it.
 *
 * Static solids and moving bodies need different maths, which is why one module cannot do both.
 * A wall is resolved by pushing the actor out along the shortest axis. Two cars are resolved by
 * pushing BOTH apart along the line between them, in proportion to mass, or the heavier one
 * would teleport out of the lighter one's way.
 *
 *     const bodies = createBodies();
 *     const me = bodies.add(car, { radius: 1.4 });
 *     for (const ai of rivals) bodies.add(ai.group, { radius: 1.4 });
 *     // ...once per frame, after everything has moved:
 *     bodies.separate();
 *     // ...and in getState(): { ...bodies.report() }
 */
export function createBodies({ push = 1 } = {}) {
  const items = [];
  let separations = 0, overlaps = 0, worstOverlap = 0;

  function add(obj, { radius = 1, mass = 1, still = false } = {}) {
    if (!obj || !obj.position) throw new Error(
      'createBodies: add() needs an object with .position -- the mesh or group you move each '
      + 'frame. bodies.add(car, { radius: 1.4 }).');
    const rec = { obj, radius, mass: still ? Infinity : Math.max(0.001, mass), still };
    items.push(rec);
    return rec;
  }

  const remove = (objOrRec) => {
    const i = items.findIndex((r) => r === objOrRec || r.obj === objOrRec);
    if (i >= 0) items.splice(i, 1);
    return i >= 0;
  };

  /** Call ONCE per frame, after every actor has moved. Resolves every overlapping pair. */
  function separate() {
    separations += 1;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        if (a.mass === Infinity && b.mass === Infinity) continue;
        const ax = a.obj.position.x, az = a.obj.position.z;
        const bx = b.obj.position.x, bz = b.obj.position.z;
        let dx = bx - ax, dz = bz - az;
        let d = Math.hypot(dx, dz);
        const want = a.radius + b.radius;
        if (d >= want) continue;
        overlaps += 1;
        if (want - d > worstOverlap) worstOverlap = want - d;
        // Exactly concentric: pick an axis rather than dividing by zero. Two cars spawned on
        // the same grid slot is a real case, and NaN there stops the whole scene.
        if (d < 1e-6) { dx = 1; dz = 0; d = 1; }
        const nx = dx / d, nz = dz / d;
        const gap = (want - d) * push;
        const total = (a.mass === Infinity ? 0 : 1 / a.mass) + (b.mass === Infinity ? 0 : 1 / b.mass);
        if (total <= 0) continue;
        const sa = (a.mass === Infinity ? 0 : (1 / a.mass) / total) * gap;
        const sb = (b.mass === Infinity ? 0 : (1 / b.mass) / total) * gap;
        a.obj.position.x -= nx * sa; a.obj.position.z -= nz * sa;
        b.obj.position.x += nx * sb; b.obj.position.z += nz * sb;
      }
    }
    return overlaps;
  }

  /** Merge into getState(): `separations` is what tells a wired module from an abandoned one. */
  const report = () => ({ bodies: items.length, separations, bodyOverlaps: overlaps,
                          worstOverlap: +worstOverlap.toFixed(3) });

  const api = { add, remove, separate, report, get count() { return items.length; },
                get separations() { return separations; },
                /** Live overlap test, for the checker: which pairs are inside each other NOW. */
                overlapping() {
                  const out = [];
                  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
                    const a = items[i], b = items[j];
                    const d = Math.hypot(b.obj.position.x - a.obj.position.x,
                                         b.obj.position.z - a.obj.position.z);
                    const want = a.radius + b.radius;
                    if (d < want - 0.02) out.push(+(want - d).toFixed(2));
                  }
                  return out;
                } };
  _bodiesCreated.push(api);
  return api;
}

export function createSolids({ passes = 3 } = {}) {
  const discs = [];   // { x, z, r }
  const boxes = [];   // { x, z, hw, hd }
  // Counted so the checker can tell a scene that WIRED collision from one that merely created
  // it. A racing build called createSolids, registered its buildings, and never called
  // resolve() once -- so the player drove through every wall and every car, and passed 32 of 32
  // checks, because nothing distinguishes "collision exists" from "collision runs".
  let resolves = 0;

  function addDisc(x, z, radius) { discs.push({ x, z, r: radius }); return discs[discs.length - 1]; }
  function addBox(x, z, width, depth) { boxes.push({ x, z, hw: width / 2, hd: depth / 2 }); return boxes[boxes.length - 1]; }

  /** True when a point is inside any solid, allowing for the actor's own radius.
   *
   *  This is the query that makes "every objective must be reachable" checkable instead of
   *  advisory: place pickups and spawn points where `blocked()` is false and a coin can never
   *  end up inside a tree. */
  function blocked(x, z, radius = 0) {
    for (const d of discs) if (Math.hypot(x - d.x, z - d.z) < d.r + radius) return true;
    for (const b of boxes) {
      if (Math.abs(x - b.x) < b.hw + radius && Math.abs(z - b.z) < b.hd + radius) return true;
    }
    return false;
  }

  /** Push `pos` out of anything it overlaps, SLIDING along the surface rather than stopping.
   *
   *  Pass `from` (the position before this step) and the attempted movement is projected onto
   *  the collider's tangent, so walking into a tree at an angle carries you around it. Without
   *  that projection the push-out is purely radial, which cancels motion whenever the stick
   *  points into the obstacle -- the checker measured a 4-second stall on the reference scene
   *  doing exactly that, and this project's own rule says a player commanding movement must
   *  never be held still: "a vehicle wedged against scenery and only a manual reverse freed it".
   */
  function resolve(pos, radius = 0.5, from = null) {
    resolves += 1;
    let x = pos.x, z = pos.z;
    // Slide first: remove the component of this step that points INTO whatever it hit, then let
    // the push-out below clean up any residual overlap.
    if (from) {
      const mx = x - from.x, mz = z - from.z;
      if (mx || mz) {
        for (const d of discs) {
          if (Math.hypot(x - d.x, z - d.z) >= d.r + radius) continue;
          const nx0 = from.x - d.x, nz0 = from.z - d.z, nl = Math.hypot(nx0, nz0) || 1;
          const nx = nx0 / nl, nz = nz0 / nl;              // outward normal at the approach
          const into = mx * nx + mz * nz;                   // negative when moving inward
          if (into < 0) { x = from.x + (mx - into * nx); z = from.z + (mz - into * nz); }
        }
      }
    }
    for (let pass = 0; pass < passes; pass++) {
      let moved = false;
      for (const d of discs) {
        const dx = x - d.x, dz = z - d.z;
        const dist = Math.hypot(dx, dz), min = d.r + radius;
        if (dist < min) {
          // Degenerate case: dead centre. Any direction is correct; pick one deterministically
          // rather than dividing by zero and producing NaN, which silently freezes a scene.
          const inv = dist > 1e-6 ? 1 / dist : 0;
          x = d.x + (inv ? dx * inv : 1) * min;
          z = d.z + (inv ? dz * inv : 0) * min;
          moved = true;
        }
      }
      for (const b of boxes) {
        const dx = x - b.x, dz = z - b.z;
        const ox = b.hw + radius - Math.abs(dx), oz = b.hd + radius - Math.abs(dz);
        if (ox > 0 && oz > 0) {
          // Leave by the SHALLOWER axis: exiting a wall through its long side teleports the
          // player across it.
          if (ox < oz) x = b.x + Math.sign(dx || 1) * (b.hw + radius);
          else z = b.z + Math.sign(dz || 1) * (b.hd + radius);
          moved = true;
        }
      }
      if (!moved) break;
    }
    return _v.set(x, pos.y, z);
  }

  const api = { addDisc, addBox, blocked, resolve, discs, boxes,
           get resolves() { return resolves; },
           get count() { return discs.length + boxes.length; } };
  _solidsCreated.push(api);
  return api;
}

/** Ground following and world bounds from ONE height function.
 *
 *  `heightAt` must be the same function the visible mesh was built from -- a second, slightly
 *  different function is how a vehicle comes to sink and resurface forever.
 *
 *  `waterLevel` is the fix for two reports from a device: "able to float in water", and being
 *  unable to move at the shoreline. Water is a BOUNDARY, not decoration: below the waterline
 *  the actor is pushed back toward where it came from, so it stops at the edge instead of
 *  walking onto the sea or wedging in it. */
export function createGround(heightAt, { radius = null, waterLevel = null, margin = 0.6 } = {}) {
  function at(x, z) { return heightAt(x, z); }

  /** WHERE you may stand: inside the world and out of the water. Corrects x and z, and passes y
   *  through UNTOUCHED.
   *
   *  Separated from place(), which answers a different question -- how HIGH you are -- because a
   *  scene that jumps, climbs, falls or swims owns that answer itself. Calling place() every
   *  frame erases a jump; createJump's docs below carry that incident.
   *
   *  A scene with any vertical motion should use confine() for x/z, at() for the surface, and let
   *  its own integrator own y. Then nothing in the call chain can overwrite it. */
  function confine(pos, from = null) {
    let x = pos.x, z = pos.z;
    if (radius !== null) {
      const d = Math.hypot(x, z);
      if (d > radius - margin) { const k = (radius - margin) / (d || 1); x *= k; z *= k; }
    }
    if (waterLevel !== null && heightAt(x, z) < waterLevel && from) {
      // SLIDE along the shoreline, do not refuse the step. My first version cancelled the whole
      // move when the target was wet, and the checker caught it immediately: holding the stick
      // toward the sea froze the player for 4 seconds -- which is precisely the device report
      // this was meant to fix ("where it is flickering, we are not able to move there").
      // Cancelling both axes stops all motion; cancelling only the axis that entered the water
      // lets a player walking diagonally into the shore keep moving along it.
      if (heightAt(x, from.z) >= waterLevel) z = from.z;          // keep the dry x
      else if (heightAt(from.x, z) >= waterLevel) x = from.x;     // keep the dry z
      else { x = from.x; z = from.z; }                            // a cove: genuinely nowhere
    }
    return _c.set(x, pos.y, z);
  }

  /** confine() PLUS the surface: the whole corrected position, y included. Use it when the scene
   *  has no vertical motion of its own -- then owning y is exactly what you want.
   *
   *  `eye` is the distance from the actor's ORIGIN to its lowest point, so the model sits on the
   *  surface rather than through it. Pass the Object3D instead of a number and it is measured
   *  from the geometry -- the only way to get it right without knowing the modelling convention.
   *  A generated island explorer passed 0 with a group whose mesh extends below its origin, so
   *  the character was buried to its ankles in every frame; the default of 0 is what invited
   *  that, and it is kept only because a vehicle whose origin genuinely sits on the ground is
   *  also legitimate.
   *
   *  If the actor jumps, falls, climbs or swims, do NOT call this -- use confine() + at(). */
  function place(pos, eye = 0, from = null) {
    if (eye && typeof eye === 'object') {
      _box.setFromObject(eye);
      eye = _box.isEmpty() ? 0 : Math.max(0, (eye.position?.y ?? 0) - _box.min.y);
    }
    const p = confine(pos, from);
    return _v.set(p.x, heightAt(p.x, p.z) + eye, p.z);
  }

  /** Is this spot dry land inside the world? For placing pickups and spawn points. */
  function usable(x, z) {
    if (radius !== null && Math.hypot(x, z) > radius - margin) return false;
    if (waterLevel !== null && heightAt(x, z) < waterLevel) return false;
    return true;
  }

  return { at, place, confine, usable };
}

/** Gravity and a jump arc, so a platformer's reachability is arithmetic rather than a guess.
 *
 *  A generated parkour level put its first platform 6.1 m above a 2.88 m jump: every control
 *  worked and the game could not be played. `apex` reports how high THIS configuration can
 *  actually reach, so a scene can place platforms inside it instead of hoping. */
export function createJump({ gravity = -22, jumpSpeed = 9 } = {}) {
  const apex = (jumpSpeed * jumpSpeed) / (2 * -gravity);
  let launches = 0;
  let launchWindow = 0;
  let reported = false;
  let peakSinceLaunch = 0;
  return {
    gravity, jumpSpeed, apex,
    /** Advance vertical motion. Returns { y, vy, grounded }.
     *
     *  THIS owns the actor's Y. Anything else that writes position.y in the same frame -- most
     *  easily `createGround().place()`, which returns `ground + eye` -- erases the ascent before
     *  the next frame reads it, and the jump silently becomes a 0.15 m twitch (`jumpSpeed * dt`).
     *  A generated island explorer shipped exactly that: a labelled JUMP button that did nothing,
     *  because `place()` ran first and reset y to the ground every frame. Nothing detected it --
     *  the control was declared, drawn and read, and the scene passed 26 of 26 checks.
     *
     *  So this detects the collision itself: a real jump launches ONCE and is then airborne for
     *  most of a second. Repeated launches on consecutive frames mean something is putting the
     *  actor back on the ground, and that is reported rather than left to a device. */
    step(y, vy, groundY, dt, wantJump) {
      let nvy = vy;
      let grounded = y <= groundY + 1e-3;
      // A real jump takes ~2*jumpSpeed/-gravity seconds round trip, so it cannot launch more than
      // twice in 1.5 s. More than that means the actor is back on the ground immediately, every
      // time -- its y is being overwritten. Counted over a WINDOW rather than consecutively,
      // because the launches alternate: the frame after a launch has grounded=false, so
      // `held && grounded` is false, and a consecutive counter resets on every other frame.
      // Track how high the actor gets BETWEEN launches, and judge on that rather than on the
      // launch count alone. Counting launches alone would also condemn a game that bounces on
      // purpose -- a pogo, a trampoline, an auto-hop -- because those relaunch the moment they
      // land, which is the same rhythm as an erased jump. The difference is altitude: a real
      // bounce reaches its apex, an erased one never leaves the floor. Compared against a
      // quarter of the apex so a deliberately small hop is not condemned either.
      if (y - groundY > peakSinceLaunch) peakSinceLaunch = y - groundY;
      launchWindow += dt;
      if (launchWindow > 1.5) { launchWindow = 0; launches = 0; reported = false; }
      if (grounded && wantJump) {
        nvy = jumpSpeed;
        grounded = false;
        const roseProperly = peakSinceLaunch > apex * 0.25;
        peakSinceLaunch = 0;
        if (roseProperly) launches = 0;              // it really is bouncing; not our problem
        else if (++launches >= 5 && !reported) {
          reported = true;
          report('createJump: the actor has launched 5 times in under 1.5 s, so it is never '
            + 'leaving the ground -- something else is writing position.y after this runs. The '
            + 'usual cause is createGround().place(), which returns ground + eye: apply it only '
            + 'while grounded, or take only its x/z, and let jump.step() own y. As written the '
            + `JUMP control lifts the actor ${(jumpSpeed * dt).toFixed(2)} m and no further, `
            + 'which on a device reads as a button that does nothing.');
        }
      } else if (!grounded || nvy > 0) {
        nvy += gravity * dt;
      }
      let ny = y + nvy * dt;
      if (ny <= groundY) { ny = groundY; nvy = 0; grounded = true; }
      return { y: ny, vy: nvy, grounded };
    },
  };
}

/** Automatic recovery from being wedged -- the rule every game is told to implement and none
 *  reliably does.
 *
 *  From this project's own guidance: "Reported from a real device: a vehicle wedged against
 *  scenery and only a manual reverse freed it. If the player is commanding movement and nothing
 *  has happened for about a second, recover automatically." Leaving that to each scene meant it
 *  was written inconsistently or not at all, and check.py fails a long stall while input is held
 *  -- the reference island stalled 3.5 to 5 seconds against a 4 second limit purely from being
 *  pressed against trees and the shoreline while the stick was held.
 *
 *  The nudge is PERPENDICULAR to the direction being commanded, because pushing back along it
 *  just re-collides on the next frame. Collision resolution runs afterwards and cleans up
 *  whatever the nudge overlapped.
 */
/**
 * A STABLE at-rest flag, for the `atRest` field the checks read.
 *
 * `body.velocity.lengthSquared() < eps` flickers. A body resting on a surface never reaches zero
 * velocity -- contact resolution micro-jitters it -- so a single reading lands on either side of
 * the threshold at random. The explorer scene did exactly that and made the settle check fail on
 * one run and pass on the next with identical code.
 *
 * Hysteresis is the fix: it takes a low speed to fall asleep and a clearly higher one to wake up,
 * so the flag describes the world's state instead of this frame's noise.
 *
 *     const rest = createRest();
 *     // inside getState():
 *     atRest: rest.update(chassisBody.velocity.lengthSquared())
 */
export function createRest({ enter = 0.05, exit = 0.4 } = {}) {
  let resting = false;
  return {
    update(speedSq) {
      if (resting ? speedSq > exit : speedSq < enter) resting = !resting;
      return resting;
    },
    get resting() { return resting; },
  };
}

/** Pass `input` and the regions that DRIVE, and this reads whether a finger is actually on one
 *  of them instead of trusting the caller. `commandDir` alone was not enough: two racing builds
 *  computed a forward vector every frame whether or not anything was pressed, so `commanding`
 *  was permanently true, the nudge fired while the car sat idle, and each spent two rounds on
 *  the same loop -- add unstick, fail "the actor holds still when nothing is pressed" with 1.8 m
 *  of oscillation, then gate the call by hand. A guard the caller can defeat by passing a
 *  plausible value is not a guard.
 *
 *  input.region(name).held is the same state the QA seam writes into, so injection still drives
 *  it -- which is right: when the harness is holding the throttle, a player would be too. */
export function createUnstick({ after = 0.8, nudge = 0.9, moved = 0.04, input = null, regions = [] } = {}) {
  const driveRegions = Array.isArray(regions) ? regions : [regions];
  let stalled = 0, lastX = null, lastZ = null, flip = 1;
  return {
    /** `commandDir` is the direction the player is asking to go (may be null when idle). */
    step(pos, commandDir, dt) {
      // Held beats told. Fall back to the caller's word only when no input was wired in.
      const pressed = input && driveRegions.length
        ? driveRegions.some((n) => { const r = input.region(n); return !!(r && (r.held || r.pressed)); })
        : null;
      const dirNonZero = !!commandDir && (Math.abs(commandDir.x) > 1e-3 || Math.abs(commandDir.z) > 1e-3);
      const commanding = pressed === null ? dirNonZero : (pressed && dirNonZero);
      if (!commanding) { stalled = 0; lastX = pos.x; lastZ = pos.z; return _v.set(pos.x, pos.y, pos.z); }
      const d = lastX === null ? Infinity : Math.hypot(pos.x - lastX, pos.z - lastZ);
      lastX = pos.x; lastZ = pos.z;
      stalled = d < moved ? stalled + dt : 0;
      if (stalled < after) return _v.set(pos.x, pos.y, pos.z);
      stalled = 0;
      // Alternate sides, so a nudge that fails once tries the other way rather than oscillating
      // against the same obstacle forever.
      flip = -flip;
      const l = Math.hypot(commandDir.x, commandDir.z) || 1;
      const px = -commandDir.z / l * nudge * flip, pz = commandDir.x / l * nudge * flip;
      return _v.set(pos.x + px, pos.y, pos.z + pz);
    },
  };
}
