/**
 * RACING archetype: a closed circuit with barriers on both sides.
 *
 * This exists because driving.js is OPEN TERRAIN -- no track, no walls -- so nothing in the
 * suite reproduced what a racing game actually is, and the checks written against it were
 * therefore never tested on a real course. A generated racer then failed "never stuck while
 * the control is held" seven times, because the harness holds the accelerator and cannot
 * steer, so a closed circuit means a barrier every time. To pass it that build added
 * auto-steering toward the track centre: a car that drives itself when you let go.
 *
 * The fix is in this scene, not in the check: it publishes the next three waypoints ahead in
 * `screen:`, and the harness steers along them instead of driving into the first wall. Any
 * vehicle game on a closed course should do the same -- it is the difference between a check
 * that cannot be satisfied and one that measures whether the car wedges on its own route.
 *
 * Geometry is deliberately drivable: turn radius SPEED/turnRate = 5 m against the oval's
 * tightest curvature of RZ^2/RX = 12 m. A tighter version failed with an 8 s stall and proved
 * only that the track was impossible.
 */
import * as THREE from '../vendor/three.module.js';

import { createSolids, createBodies } from '../core/collide.js';
import { attachControls } from '../core/controls.js';
import { attachDiagnostics } from '../core/diagnostics.js';
import { createHost } from '../core/host.js';
import { createInput } from '../core/input.js';
import { attachLifecycle } from '../core/lifecycle.js';
import { createLoop } from '../core/loop.js';
import { faceYaw, tankDrive, followCam } from '../core/motion.js';
import { createPicker } from '../core/pick.js';
import { createShell } from '../core/shell.js';

const RX = 26, RZ = 18, HALF = 7;   // oval radii, half track width
const SPEED = 9;   // turn radius 9/1.8 = 5 m, well inside the oval's tightest 12 m

export function start(canvas) {
  const host = createHost({ canvas, captureFrames: true });
  const { scene, camera } = host;
  scene.background = new THREE.Color(0x8ea9c4);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120),
    new THREE.MeshStandardMaterial({ color: 0x4b5b3f, roughness: 0.95 }));
  ground.rotateX(-Math.PI / 2);
  ground.receiveShadow = true;
  scene.add(host.track(ground));

  const solids = createSolids();
  const waypoints = [];
  const N = 24;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const cx = Math.cos(a) * RX, cz = Math.sin(a) * RZ;
    waypoints.push(new THREE.Vector3(cx, 1, cz));
    // barriers on both sides of the racing line
    for (const k of [1 - HALF / Math.hypot(RX, RZ), 1 + HALF / Math.hypot(RX, RZ)]) {
      const bx = Math.cos(a) * RX * k, bz = Math.sin(a) * RZ * k;
      const b = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.2, 2.4),
        new THREE.MeshStandardMaterial({ color: 0xcc4444, roughness: 0.8 }));
      b.position.set(bx, 0.6, bz);
      b.castShadow = true;
      scene.add(host.track(b));
      solids.addBox(bx, bz, 2.4, 2.4);
    }
  }

  const car = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.8, 3.4),
    new THREE.MeshStandardMaterial({ color: 0x3a7ae8, roughness: 0.5 }));
  car.castShadow = true;
  car.position.set(RX, 0.4, 0);
  scene.add(host.track(car));

  // RIVALS. A racing exemplar with an empty track taught racing games with no opponents, and
  // every generated racer inherited it -- including the one that showed the player "P1 of 1" and
  // was reported as wrong position ranking. Rivals are also the only way this suite exercises
  // createBodies and the check "the actor cannot pass through other actors", both of which were
  // shipped with no scene using them: that check SKIPPED on all twelve scenes.
  //
  // Rival vehicles are NOT static solids -- a solid is a wall, and resolve() would let a rival
  // shove the player through one. Actor-vs-actor is createBodies: it separates two movers by
  // their masses, so a car bumping a car is a nudge and not a teleport.
  const bodies = createBodies();
  bodies.add(car, { radius: 1.5, mass: 1 });
  const rivals = [];
  for (let i = 0; i < 3; i++) {
    const r = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.8, 3.4),
      new THREE.MeshStandardMaterial({ color: [0xe8a13a, 0x8ad06a, 0xd06a9e][i], roughness: 0.5 }));
    const a = -((i + 1) * 0.22);                       // staggered back along the racing line
    r.position.set(Math.cos(a) * RX, 0.4, Math.sin(a) * RZ);
    r.castShadow = true;
    scene.add(host.track(r));
    rivals.push({ mesh: r, next: 1, speed: 11 + i * 1.4 });
    bodies.add(r, { radius: 1.5, mass: 1 });
  }

  const input = createInput(canvas);
  // The stick region is declared FIRST and covers the lower-left 60% -- deliberately, because
  // that is the mistake a generated island explorer made and it cost three of its four D-pad
  // buttons: onDown() takes the FIRST region whose area contains the touch. Drawing the buttons
  // through attachControls binds them to their own elements, and a bound (i.e. DRAWN) region is
  // hit-tested ahead of any invisible one, so the order stops mattering. This scene keeps the
  // bad order on purpose, so the suite exercises that guarantee instead of assuming it.
  input.addRegion('stick', { x: 0, y: 0.4, w: 0.6, h: 0.6 });
  input.addRegion('brake', { x: 0.62, y: 0.55, w: 0.38, h: 0.45 });
  attachControls(input, {
    stick: { region: 'stick', x: 110, y: 110, radius: 70, deadzone: 0.12 },
    // ONE JOB PER CONTROL. This scene used to draw left/right arrows that steered exactly as the
    // stick already did, purely so the suite exercised steer(). Five generated racing games copied
    // that block -- same region names, same arrow glyphs -- and shipped five controls where one
    // would do; a user's verdict on the last one was "only joystick is enough, those 4 buttons are
    // working but not necessary". An exemplar is a design, not a test fixture: whatever it shows,
    // builds ship. The stick steers and drives; the button does the thing the stick CANNOT do.
    // jumper.js (stick + JUMP) and explorer.js (stick + BOOST/BRAKE) were already right.
    buttons: [
      { region: 'brake', label: 'BRAKE', right: 34, bottom: 62, colour: 'rgba(255,90,90,0.20)' },
    ],
  });
  const picker = createPicker({ canvas, camera });

  let yaw = 0, odo = 0, next = 1, lastSpeed = 0;   // tangent to the oval at (RX,0,0), not into the wall
  let lap = 0;
  const LAPS = 3;

  const resetState = () => {
    car.position.set(RX, 0.4, 0); yaw = 0; odo = 0; next = 1; lap = 0;
    // Rivals reset too, or "measurements from a known state" measures a different grid each run.
    rivals.forEach((rv, i) => {
      const a = -((i + 1) * 0.22);
      rv.mesh.position.set(Math.cos(a) * RX, 0.4, Math.sin(a) * RZ);
      rv.next = 1;
    });
    shell.set('lap', 0);
  };

  // THE STATE MACHINE COMES WITH THE SKELETON. Three consecutive generated games froze on a start
  // screen they had hand-rolled -- one wrote `display:none` into the overlay's cssText after
  // showing it, another left a full-screen overlay at `pointer-events:auto` with no click handler
  // -- and both were unreachable for a player while passing every check. createShell's overlay is
  // INERT by default and its button is a real input region, which is what makes it dismissable by
  // a finger AND by the harness. A skeleton without one asks every racing game to reinvent the
  // exact thing that keeps breaking.
  const shell = createShell(input, {
    fields: { lap: { label: 'LAP', total: () => LAPS } },
    screens: {
      start: { title: 'CIRCUIT', hint: `${LAPS} laps against the clock`, action: 'RACE' },
      win: { title: 'FINISHED', hint: 'Nicely driven', action: 'RACE AGAIN' },
    },
    onAction: () => resetState(),
  });
  shell.show('start');
  let diag;

  const loop = createLoop({
    mode: 'continuous',
    step(dt) {
      // shell.update() EVERY frame, before the early return. It reads the action region, so an
      // injected tap on the start button fires -- and it runs the overlay's self-repair, which
      // restores a screen a scene has hidden from outside while `screen` is still set. This
      // scene did not call it, and a generated racer noticed the contradiction: "circuit.js
      // doesn't call shell.update() and works fine, so I'll just follow that pattern". It works
      // because a real finger click reaches the button through the DOM -- but the repair never
      // runs, and the exemplar was teaching the omission.
      shell.update();
      if (shell.screen) return;        // paused behind the start or win overlay
      const was = { x: car.position.x, z: car.position.z };
      const m = tankDrive(input, 'stick', yaw, { dt, camera, turnRate: 1.8 });
      yaw = m.yaw;
      faceYaw(car, yaw);
      // The brake is a verb the stick has no way to express: it scrubs speed without steering.
      const braking = !!(input.region('brake') || {}).held;
      lastSpeed = (braking ? SPEED * 0.25 : SPEED) * m.velocity.length();
      car.position.addScaledVector(m.velocity, (braking ? SPEED * 0.25 : SPEED) * dt);
      car.position.copy(solids.resolve(car.position, 1.2, was));
      car.position.y = 0.4;
      odo += Math.hypot(car.position.x - was.x, car.position.z - was.z);
      if (car.position.distanceTo(waypoints[next]) < 6) {
        next = (next + 1) % waypoints.length;
        if (next === 1) {                     // wrapped past the start/finish line
          lap += 1;
          shell.set('lap', lap);
          if (lap >= LAPS) shell.show('win');
        }
      }

      // Rivals follow the same waypoints the player races, so they stay on the track without
      // needing their own collision. They move BEFORE separate(), which is the whole point:
      // separating before the movers have moved resolves last frame's overlap, not this one.
      for (const rv of rivals) {
        const wp = waypoints[rv.next];
        const dx = wp.x - rv.mesh.position.x, dz = wp.z - rv.mesh.position.z;
        const d = Math.hypot(dx, dz) || 1;
        rv.mesh.position.x += (dx / d) * rv.speed * dt;
        rv.mesh.position.z += (dz / d) * rv.speed * dt;
        rv.mesh.rotation.y = Math.atan2(dx, dz);
        if (d < 6) rv.next = (rv.next + 1) % waypoints.length;
      }
      bodies.separate();
      car.position.y = 0.4;
      for (const rv of rivals) rv.mesh.position.y = 0.4;

      // followCam, NOT hand-rolled trigonometry. This scene used to write the two lines below by
      // hand, and hand-rolled chase cameras are where the worst bug in this project came from: a
      // generated racer named its distance `behind` and set it to -12, which puts the camera in
      // FRONT of the car looking back, and no world-space check can see that. followCam applies
      // the direction itself and throws on a non-positive `back`, so that mistake is unwritable.
      // Leaving the manual version here taught every racing build the dangerous shape.
      followCam(camera, car.position, yaw, { back: 11, height: 6.1, lookHeight: 1 });
    },
    render() { host.present(); diag.onFrame(); input.endFrame(); },
  });

  attachLifecycle({ canvas, loop, host });
  diag = attachDiagnostics({
    host, loop, input, actor: car, reset: resetState,
    getState: () => ({
      scene: 'circuit',
      view: 'vehicle',
      pos: car.position.toArray().map((n) => +n.toFixed(2)),
      facing: [Math.sin(yaw), 0, Math.cos(yaw)],
      yaw: +yaw.toFixed(3),
      progress: +odo.toFixed(1),
      // Published because the BRAKE only changes speed. A control whose whole effect is invisible
      // in getState() fails "control 'brake' does something" -- which is exactly how a generated
      // racer failed it, and it then made the button do something else to satisfy the check.
      speed: +lastSpeed.toFixed(2),
      ...shell.report(),        // phase + lap: the HUD and the report are the same numbers
      // the next few waypoints ahead: this is what lets a checker drive the lap
      screen: Object.fromEntries([0, 1, 2].map((k) => {
        const w = waypoints[(next + k) % waypoints.length];
        return [`wp${k}`, picker.project(w)];
      })),
    }),
  });
  loop.start();
}
