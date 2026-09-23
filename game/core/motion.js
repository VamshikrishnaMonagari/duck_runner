import * as THREE from '../vendor/three.module.js';

/**
 * Turning a stick into MOVEMENT. The step every game re-derived by hand, and where every
 * remaining control defect lived.
 *
 * input.js reads the finger and hands back `{x, y}`. Interpreting that -- which way is
 * forward, which axis turns, how the camera relates to it -- was left to each scene, so each
 * scene wrote the same trigonometry and some got it wrong. Four genres, four defects, one
 * cause:
 *
 *   maze     `addScaledVector(fwd, -mv.y * SPEED * dt)`   one minus sign: drag back walks forward
 *   island   moveDir -> heading -> camera -> moveDir      camera-relative feeding a chase camera:
 *                                                          pull back and the avatar spins in place
 *   runner   mirrored camera + a second input path        both of the above at once
 *   racing   steering hand-rolled per build               same class
 *
 * The README warned about the sign explicitly ("invert screen Y exactly once"). Prose in this
 * project measures 0 for 21 on behavioural instructions, so the warning did nothing. Modules
 * measure 12 for 12.
 *
 * Both helpers return a vector that ALREADY carries direction and magnitude, so a scene writes
 * `pos.addScaledVector(v, SPEED * dt)` and there is no sign left to get wrong.
 */

const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _xAxis = new THREE.Vector3(1, 0, 0);
const _camDir = new THREE.Vector3();
const _camWant = new THREE.Vector3();
const _camTgt = new THREE.Vector3();

function report(msg) {
  const g = globalThis.__GAME__;
  if (g && typeof g.reportError === 'function') g.reportError(msg);
  else console.error(msg);
}

const warned = new Set();
function warnOnce(key, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  // Deferred: motion helpers are called from the loop, which starts before attachDiagnostics
  // in some scenes. controls.js hit the same problem and lost its first warning entirely.
  setTimeout(() => report(msg), 0);
}

/**
 * CAMERA-RELATIVE movement: the stick direction is the world direction the player goes.
 *
 * Returns a flattened world direction scaled by how far the stick is pushed (0..1), so:
 *     player.position.addScaledVector(walkDirection(...), SPEED * dt);
 *
 * `regions.look` is REQUIRED and enforced, not advised. Camera-relative movement is only
 * coherent while the camera's yaw is an independent input. Combined with a chase camera that
 * follows the avatar's heading -- where the heading follows the movement -- it closes a loop
 * with no damping: pulling back flips the heading, the camera whips round, and the stick's
 * meaning inverts every frame. That shipped, and on a device it read as "if i drag down, it
 * just rotates". A scene that has not declared a look region is told to use tankDrive instead.
 */
export function walkDirection(input, regions, camera, { radius = 60, deadzone = 0.15 } = {}) {
  const moveName = typeof regions === 'string' ? regions : regions.move;
  const lookName = typeof regions === 'string' ? null : regions.look;

  if (!lookName || !input.region(lookName)) {
    warnOnce('walk:' + moveName,
      `walkDirection('${moveName}') is CAMERA-RELATIVE, which needs a separate look control that `
      + `owns the camera's yaw. This scene declared ${lookName ? `no region '${lookName}'` : 'no look region'}. `
      + 'With a chase camera that follows the avatar instead, camera-relative movement feeds back '
      + 'into itself and the avatar spins on the spot instead of reversing. Either add a look '
      + 'region, or use tankDrive() -- x turns, y drives -- which cannot form that loop.');
  }

  const v = input.sample(moveName, { radius, deadzone });
  const mag = Math.min(1, Math.hypot(v.x, v.y));
  if (mag === 0) return _dir.set(0, 0, 0);

  camera.getWorldDirection(_dir);
  _dir.y = 0;
  if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, -1);   // camera pointing straight down
  _dir.normalize();
  _right.crossVectors(_dir, _up).normalize();

  // y is UP-positive out of sample(), meaning "pushed away from the player" = forward. This is
  // the single place that convention is applied; a scene never sees the sign.
  return _dir.multiplyScalar(v.y).addScaledVector(_right, v.x).normalize().multiplyScalar(mag);
}

/**
 * TANK drive: stick x turns, stick y drives along the heading.
 *
 * The camera is never an input here, so the feedback loop above cannot be built. This is the
 * correct scheme for a single joystick with a chase camera, and for boats, tanks and turrets.
 *
 *     const m = tankDrive(input, 'stick', heading.yaw, { dt });
 *     heading.yaw = m.yaw;
 *     player.rotation.y = m.yaw;
 *     player.position.addScaledVector(m.velocity, SPEED * dt);
 *
 * `velocity` already carries the throttle sign, so reverse works without the scene negating
 * anything -- the defect that made a lane runner walk forward when dragged backward.
 */
export function tankDrive(input, region, yaw, { dt = 0.016, turnRate = 2.2, radius = 60, deadzone = 0.15, turnAtRest = true, camera = null } = {}) {
  const v = input.sample(region, { radius, deadzone });
  // Turning while stationary is usually wanted on foot and usually not in a vehicle, where
  // steering should scale with speed. Explicit rather than assumed either way.
  const turnScale = turnAtRest ? 1 : Math.min(1, Math.abs(v.y));
  const nextYaw = yaw - v.x * turnRate * dt * turnScale;
  const forward = _dir.set(Math.sin(nextYaw), 0, Math.cos(nextYaw));
  if (camera && Math.abs(v.y) > 0) {
    // Pass `camera` for a first-person scene and the mismatch below becomes impossible to ship
    // silently. THIS forward is +Z at yaw 0; a three.js camera looks -Z, so a scene that writes
    // `camera.rotation.y = yaw` points the camera exactly backwards from the direction this
    // function moves it. A generated maze did that and rendered a wall while walking away from it.
    camera.getWorldDirection(_camFwd);
    _camFwd.y = 0;
    if (_camFwd.lengthSq() > 1e-6 && _camFwd.normalize().dot(forward) < 0) {
      warnOnce('tank:camera:' + region,
        'tankDrive() is moving along +Z at yaw 0 but the camera is facing the opposite way, so the '
        + 'player walks backwards out of the view. Do not set the camera with `camera.rotation.y = yaw`: '
        + "a camera's forward is -Z, a mesh's is +Z. Use faceYaw(camera, yaw) from core/motion.js, "
        + 'which applies the right one for whichever object you pass it.');
    }
  }
  return { yaw: nextYaw, throttle: v.y, turn: v.x, velocity: forward.multiplyScalar(v.y) };
}

/**
 * Which way a LANE INDEX should move when the player swipes screen-left or screen-right.
 *
 * A lane array is laid out along a world axis, but whether that axis reads left-to-right ON
 * SCREEN depends on the camera. A three.js camera looks down -Z, where +X is screen-right. Turn
 * it around -- a runner travelling +Z with a chase cam behind -- and cross(forward, up) becomes
 * -X, so +X is now screen-LEFT and the lane array is mirrored.
 *
 * None of that is visible locally. The swipe handler, the lane array and its own comment can be
 * perfectly self-consistent and still be backwards. A generated endless runner had exactly this:
 * `const LANE_X = [-2, 0, 2]; // left, center, right` with `player.position.z += speed * dt` and
 * the camera at z = -5. Every line was defensible; swiping right moved the player left on the
 * device.
 *
 *     const d = laneDelta(camera, reg.swipe.dir);
 *     if (d) targetLane = Math.min(LANES - 1, Math.max(0, targetLane + d));
 *
 * The scene never writes a sign -- for the same reason tankDrive returns a velocity rather than a
 * heading. A sign a scene never sees is a sign it cannot invert. Pass `axis` for lanes laid out
 * along something other than world X.
 */
export function laneDelta(camera, dir, axis = _xAxis) {
  if (dir !== 'left' && dir !== 'right') return 0;   // 'up'/'down' are jumps, not lane changes
  camera.getWorldDirection(_dir);
  _dir.y = 0;
  if (_dir.lengthSq() < 1e-6) return dir === 'right' ? 1 : -1;   // camera straight down
  _right.crossVectors(_dir.normalize(), _up).normalize();        // the world vector that is screen-right
  const sign = Math.sign(_right.dot(axis)) || 1;                 // does +axis point screen-right?
  return dir === 'right' ? sign : -sign;
}

/**
 * TURN with BUTTONS, without ever writing the sign yourself.
 *
 *     yaw = steer(input, { left: 'steerLeft', right: 'steerRight' }, yaw, { dt, camera }).yaw;
 *
 * This exists because `tankDrive` and `laneDelta` covered sticks and swipes, and buttons were
 * left uncovered -- so every button-steered vehicle hand-rolled `yaw += RATE * dt`, and the
 * sign is a coin flip. A generated racing game did exactly that, having ALSO wired a stick
 * through tankDrive for the checker to find: the stick path was correct, the button path the
 * player actually touched was mirrored, and the game reported `screen x 361 -> 351` on every
 * single run for 62 minutes while the agent rewrote one path and broke the other. Two control
 * paths for one action is the defect; one helper that owns the sign is the fix.
 *
 * The sign comes from the camera, exactly as `laneDelta` derives it: pressing `right` always
 * turns the actor toward screen-right, whatever the camera's orientation or the scene's yaw
 * convention. `rate` is radians per second. Multiply the result by your own speed factor if the
 * vehicle should steer less at low speed -- that is handling, not direction.
 */
export function steer(input, { left, right }, yaw, { dt = 0.016, rate = 2.2, camera = null, scale = 1 } = {}) {
  const held = (name) => {
    if (!name) return false;
    const reg = input.region(name);
    return !!(reg && (reg.held || reg.pressed));
  };
  const l = held(left), r = held(right);
  if (l === r) return { yaw, turning: 0 };            // neither, or both: no net turn

  // Which way does yaw have to move for the actor to turn toward screen-right? d/dyaw of
  // (sin yaw, 0, cos yaw) is (cos yaw, 0, -sin yaw); project that onto the camera's screen-right.
  let sign = 1;
  if (camera) {
    camera.getWorldDirection(_dir);
    _dir.y = 0;
    if (_dir.lengthSq() > 1e-6) {
      _right.crossVectors(_dir.normalize(), _up).normalize();
      const d = _right.x * Math.cos(yaw) + _right.z * -Math.sin(yaw);
      sign = Math.sign(d) || 1;
    }
  }
  const turning = (r ? 1 : -1) * sign;
  return { yaw: yaw + turning * rate * dt * scale, turning };
}

/**
 * Point an object along the SAME heading tankDrive() drives it, whatever kind of object it is.
 *
 *     const m = tankDrive(input, 'stick', yaw, { dt, camera });
 *     yaw = m.yaw;
 *     faceYaw(camera, yaw);            // first person: the camera IS the player
 *     faceYaw(playerMesh, yaw);        // third person: the mesh is the player
 *
 * A three.js camera's local forward is -Z; a mesh you built has no inherent facing, and every
 * scene here builds geometry facing +Z, which is also tankDrive's forward. So `rotation.y = yaw`
 * is correct for the mesh and 180 degrees wrong for the camera -- the same expression, two
 * outcomes, which is exactly the kind of thing a scene should never have to know. It cost a
 * generated first-person maze a camera that faced the wall behind the player.
 */
export function faceYaw(obj, yaw) {
  obj.rotation.set(0, obj.isCamera ? yaw + Math.PI : yaw, 0);
  return obj;
}

/**
 * Put the camera BEHIND the actor and look at it. The last piece of camera trigonometry each
 * scene still wrote by hand, and the last place a sign could hide.
 *
 * `back` is a DISTANCE and must be POSITIVE. That distinction is the entire reason this
 * function exists. A detailed racing brief shipped this:
 *
 *     const behind = -12;
 *     targetX = car.position.x - Math.sin(yaw) * behind;
 *
 * The formula subtracts; the constant is already negative; the two cancel, and the camera
 * parks across the bonnet looking back at the driver. Both halves are individually sensible --
 * the formula is copied correctly from this project's own documentation, and a constant named
 * `behind` invites a negative value because "behind" reads as a direction, not a magnitude.
 * Composed, they invert. The car drove straight along its own facing (alignment 0.98), it
 * never spun, every world-space check passed, and on a phone the player accelerated into
 * their own viewpoint with the track hidden behind the camera.
 *
 * So a non-positive `back` throws instead of quietly framing the game from the front.
 *
 * THIRD PERSON ONLY. First person is `faceYaw(camera, yaw)` -- the camera IS the player and
 * there is no "behind" to get wrong. Overhead, orbit and fixed cameras have no heading to
 * follow and should not use this.
 */
export function followCam(camera, target, yaw, {
  back = 11, height = 5.5, lookHeight = 1, lookAhead = 0, lerp = 0, dt = 0.016, minY = null,
} = {}) {
  if (!(back > 0)) {
    throw new Error(`followCam: 'back' is the DISTANCE behind the actor and must be positive, got ${back}. `
      + 'The direction is applied inside followCam, so passing a negative distance places the camera IN '
      + 'FRONT of the actor looking back at the player -- which no world-space check can see. Pass a '
      + 'positive number: followCam(camera, pos, yaw, { back: 12 }).');
  }
  const t = target.isVector3 ? target : _camTgt.set(target.x, target.y, target.z);
  _camDir.set(Math.sin(yaw), 0, Math.cos(yaw));   // tankDrive's forward: the one convention
  _camWant.copy(t).addScaledVector(_camDir, -back);
  _camWant.y = t.y + height;
  if (minY !== null) _camWant.y = Math.max(_camWant.y, minY);
  if (lerp > 0) camera.position.lerp(_camWant, Math.min(1, dt * lerp));
  else camera.position.copy(_camWant);
  camera.lookAt(t.x + _camDir.x * lookAhead, t.y + lookHeight, t.z + _camDir.z * lookAhead);
  return camera;
}
