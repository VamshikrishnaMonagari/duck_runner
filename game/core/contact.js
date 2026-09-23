import * as THREE from '../vendor/three.module.js';

/**
 * WHAT HAPPENS WHEN THE ACTOR TOUCHES SOMETHING. Collecting and dying are the same
 * measurement with different consequences, so they are one module.
 *
 * This is the layer the engine did not own, and the checks could not see. Two device reports
 * on the same build:
 *
 *   "coins not getting collected"
 *   "not getting out even after colliding with obstacles"
 *
 * That build passed 18 of 18 checks. It could not have failed: 35 checks exist and every one
 * of them measures whether the game BOOTS, RENDERS, is VISIBLE, is CONTROLLABLE or is
 * GROUNDED. Not one measures whether the game works as a game -- because a generic harness
 * cannot know what a coin is. Route the verb through here and it can: an item registered
 * below is one the checker can place the actor on and assert that it was taken.
 *
 * THREE things this does that a hand-written `if (dist < 1)` does not, and they are the reason
 * to use it rather than a matter of taste:
 *
 *  1. SWEPT, NOT SAMPLED. A car at 40 m/s covers 0.67 m per frame at 60 fps and much more on
 *     a phone that drops to 20. A point test at each frame steps straight over a 1 m pickup
 *     and the coin is never collected -- which is exactly the reported symptom, and it gets
 *     WORSE on slower devices, so it will not reproduce on a desktop. This tests the segment
 *     the actor actually travelled.
 *  2. LATCHED. An overlapping hazard fires once, not once per frame. A hand-rolled test
 *     subtracts a life sixty times a second while the actor is inside the box.
 *  3. REPORTED. `report()` feeds getState(), so the checker can verify collecting and dying
 *     without knowing what was collected or what killed you.
 *
 * The consequence stays YOURS. A runner dies, a tower defence loses a life, a racer just
 * scrapes the wall -- so `onHit` is a callback and this module never ends a game by itself.
 * Same split as createUnstick: the engine detects, the scene decides.
 */

const _seg = new THREE.Vector3();
const _to = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _now = new THREE.Vector3();
const _relA = new THREE.Vector3();
const _relB = new THREE.Vector3();
const _origin = new THREE.Vector3(0, 0, 0);

/** Shortest distance from a point to the segment a->b. The whole reason this is swept. */
function distToSegment(p, a, b) {
  _seg.subVectors(b, a);
  const len2 = _seg.lengthSq();
  if (len2 < 1e-9) return p.distanceTo(a);
  let t = _to.subVectors(p, a).dot(_seg) / len2;
  t = Math.max(0, Math.min(1, t));
  _closest.copy(a).addScaledVector(_seg, t);
  return p.distanceTo(_closest);
}

/** See collide.js `_solidsCreated`: registration is what makes an abandoned module visible. */
export const _contactsCreated = [];

export function createContacts() {
  const items = [];          // { obj, radius, kind, cb, taken, latched, group }
  let takenCount = 0, hitCount = 0, steps = 0;

  function add(kind, obj, { radius = 0.8, onTake = null, onHit = null, group = null } = {}) {
    if (!obj || !obj.position) throw new Error(
      'createContacts: register a THREE object (or anything with .position), not a plain value. '
      + 'contacts.pickup(coinMesh, { radius, onTake }).');
    const rec = { obj, radius, kind, cb: kind === 'pickup' ? onTake : onHit, taken: false,
                latched: false, group, prev: null };
    items.push(rec);
    return rec;
  }

  /** A thing that disappears when touched and scores. Coins, gems, rings, checkpoints, power-ups. */
  const pickup = (obj, opts) => add('pickup', obj, opts);

  /** A thing that hurts when touched and stays. Trains, barriers, spikes, walls, enemies. */
  const hazard = (obj, opts) => add('hazard', obj, opts);

  function remove(objOrRec) {
    const i = items.findIndex((r) => r === objOrRec || r.obj === objOrRec);
    if (i >= 0) items.splice(i, 1);
    return i >= 0;
  }

  /** Drop everything in a group -- a runner recycling a chunk removes that chunk's items. */
  function removeGroup(group) {
    let n = 0;
    for (let i = items.length - 1; i >= 0; i--) if (items[i].group === group) { items.splice(i, 1); n++; }
    return n;
  }

  /**
   * Call ONCE per frame, AFTER the actor has moved, with where it was and where it is.
   *
   * Passing the previous position is the point. It is the same contract as collide.js's
   * resolve() and place(), for the same reason: the actor is somewhere else by the time you
   * ask, and the interesting thing happened in between.
   */
  function step(from, to, { radius = 0.5 } = {}) {
    steps += 1;
    const took = [], hits = [];
    for (let i = items.length - 1; i >= 0; i--) {
      const r = items[i];
      if (r.taken) continue;
      // A hidden or detached object cannot be touched. A runner parks recycled props out of
      // the world rather than deleting them, and an invisible coin that still scores reads as
      // a phantom pickup.
      if (r.obj.visible === false || !r.obj.parent) {
        // Keep prev current even while untouchable, or re-showing a recycled prop reads as a
        // sweep across the whole distance it was parked away at.
        if (r.prev) { if (r.obj.getWorldPosition) r.obj.getWorldPosition(_now); else _now.copy(r.obj.position); r.prev.copy(_now); }
        continue;
      }
      // RELATIVE motion, not the actor's alone. Sweeping only the actor is right for a game
      // where the actor moves through a static world and useless for the genre that reported
      // the bug: an endless runner holds the player almost still on the x axis and translates
      // the WORLD past it at up to 34 m/s, which is 1.7 m per frame at 20 fps -- so the coin
      // does the tunnelling, not the player. Subtracting each item's own movement covers both
      // cases with the same test, and the degenerate case (nothing moved) falls out of it.
      if (r.obj.getWorldPosition) r.obj.getWorldPosition(_now); else _now.copy(r.obj.position);
      if (!r.prev) r.prev = _now.clone();
      _relA.subVectors(from, r.prev);
      _relB.subVectors(to, _now);
      const near = distToSegment(_origin, _relA, _relB) <= (r.radius + radius);
      r.prev.copy(_now);
      if (!near) { r.latched = false; continue; }
      if (r.kind === 'pickup') {
        r.taken = true; takenCount++;
        items.splice(i, 1);
        if (r.obj.parent) r.obj.parent.remove(r.obj);
        took.push(r);
        if (r.cb) r.cb(r.obj);
      } else {
        if (r.latched) continue;    // already reported while overlapping; do not bill it again
        r.latched = true; hitCount++;
        hits.push(r);
        if (r.cb) r.cb(r.obj);
      }
    }
    return { took, hits, taken: took.length, hit: hits.length };
  }

  function reset() {
    for (const r of items) r.latched = false;
    takenCount = 0; hitCount = 0;
  }

  /** Merge into getState() so the checker can see that collecting and dying actually work. */
  function report() {
    let pickups = 0, hazards = 0;
    for (const r of items) (r.kind === 'pickup' ? pickups++ : hazards++);
    return { pickupsLeft: pickups, hazards, collected: takenCount, hitsTaken: hitCount,
             // steps is what tells a wired module apart from an abandoned one
             contactSteps: steps };
  }

  const api = { pickup, hazard, remove, removeGroup, step, reset, report,
                get count() { return items.length; }, get steps() { return steps; } };
  _contactsCreated.push(api);
  return api;
}
