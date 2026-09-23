import * as THREE from '../vendor/three.module.js';

/**
 * Screen coordinates -> world ray -> hits. In the core because turning a screen
 * position into world meaning is the single most common source of 3D bugs, and
 * every genre needs it in some form.
 */
export function createPicker({ canvas, camera }) {
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  function pick(screenX, screenY, targets, recursive = true) {
    const r = canvas.getBoundingClientRect();
    ndc.x = ((screenX - r.left) / r.width) * 2 - 1;
    ndc.y = -((screenY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ndc, camera);
    const list = Array.isArray(targets) ? targets : [targets];
    return { ray, hits: ray.intersectObjects(list, recursive) };
  }

  /** Height of the first hit directly below a world position -- the check that
   *  catches a physics collider misaligned with the visible ground. */
  function groundAt(x, z, target, from = 500) {
    ray.set(new THREE.Vector3(x, from, z), new THREE.Vector3(0, -1, 0));
    const h = ray.intersectObject(target, true);
    return h.length ? h[0].point.y : null;
  }

  /** World position -> screen coordinates (CSS px). The inverse of pick(); used
   *  for DOM labels over 3D objects, and by automated checks to aim a tap. */
  /** World point -> screen point. Accepts a Vector3 or a plain {x, y, z}: requiring a
   *  Vector3 threw `clone is not a function` on the obvious call, which is a trap rather
   *  than a contract. */
  function project(worldPos) {
    const r = canvas.getBoundingClientRect();
    const p = worldPos && typeof worldPos.clone === 'function'
      ? worldPos.clone()
      : new THREE.Vector3(worldPos.x, worldPos.y, worldPos.z);
    const v = p.project(camera);
    // BEHIND THE CAMERA IS NOT A SCREEN POSITION. project() divides by w, and for a point behind the
    // eye w is negative -- the result is a number, just not a pixel. A generated maze published its
    // exit through this and got { x: 1954130064637594400, y: -8636116375160754 }. The harness read
    // that as nonsense and reported "this game published no objective positions", blaming the game
    // for failing to publish what it had in fact published, through the sanctioned API. A quarter of
    // the builds on record -- 16 of 65 -- project a fixed goal that can sit behind the player, so
    // this is not a corner case. null means "not on screen", which is both true and checkable.
    if (v.z < -1 || v.z > 1) return null;
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((-v.y + 1) / 2) * r.height, z: v.z };
  }

  return { pick, groundAt, project };
}
