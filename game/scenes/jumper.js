/**
 * PLATFORMER archetype: walk, and JUMP onto things.
 *
 * This scene exists because `createJump` shipped in core/collide.js and NO archetype used it.
 * The first game that did -- a generated island explorer -- wired it the obvious way:
 *
 *     pos.copy(land.place(pos, 0, was));                       // returns ground + eye
 *     const r = jump.step(pos.y, vy, groundY, dt, wantJump);    // so y === groundY, every frame
 *
 * The ascent was erased before the next frame read it, so a labelled JUMP button lifted the
 * player `jumpSpeed * dt` -- 0.15 m -- and no further. It passed 26 of 26 checks, because the
 * control was declared, drawn and read. Only a device showed it.
 *
 * The order below is the correct one: `jump.step()` OWNS y, and `place()` is applied while
 * grounded only. Keep this scene in the suite: it is the only thing that exercises the two
 * helpers together, and `createJump` now reports the collision itself if they are swapped back.
 */
import * as THREE from '../vendor/three.module.js';

import { createBridge } from '../core/bridge.js';
import { createGround, createJump, createSolids } from '../core/collide.js';
import { attachControls } from '../core/controls.js';
import { attachDiagnostics } from '../core/diagnostics.js';
import { createHost } from '../core/host.js';
import { createInput } from '../core/input.js';
import { attachLifecycle } from '../core/lifecycle.js';
import { createLoop } from '../core/loop.js';
import { faceYaw, tankDrive } from '../core/motion.js';
import { createPicker } from '../core/pick.js';

const GROUND = 60;
const EYE = 0.6;          // half the avatar's height: its origin sits EYE above the surface
const SPEED = 7;

export function start(canvas) {
  const host = createHost({ canvas, captureFrames: true });
  const { scene, camera } = host;
  scene.background = new THREE.Color(0x8fb6d8);
  scene.fog = new THREE.Fog(0x8fb6d8, 45, 130);

  const heightAt = (x, z) => Math.sin(x * 0.08) * 1.2 + Math.cos(z * 0.07) * 1.0;

  const seg = 48;
  const gGeo = new THREE.PlaneGeometry(GROUND, GROUND, seg, seg);
  gGeo.rotateX(-Math.PI / 2);
  const gp = gGeo.attributes.position;
  for (let i = 0; i < gp.count; i++) gp.setY(i, heightAt(gp.getX(i), gp.getZ(i)));
  gGeo.computeVertexNormals();
  const groundMesh = new THREE.Mesh(gGeo,
    new THREE.MeshStandardMaterial({ color: 0x6f9e5a, roughness: 0.95 }));
  groundMesh.receiveShadow = true;
  scene.add(host.track(groundMesh));

  const avatar = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2),
    new THREE.MeshStandardMaterial({ color: 0xe8663a, roughness: 0.6 }));
  avatar.castShadow = true;
  avatar.position.set(0, heightAt(0, 0) + EYE, 0);
  scene.add(host.track(avatar));

  // Crates to jump onto -- and the objectives the checker steers at, published via `screen`.
  const solids = createSolids();
  const crates = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const x = Math.cos(a) * 9;
    const z = Math.sin(a) * 9;
    const c = new THREE.Mesh(new THREE.BoxGeometry(2, 1.6, 2),
      new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.7 }));
    c.position.set(x, heightAt(x, z) + 0.8, z);
    c.castShadow = true;
    scene.add(host.track(c));
    crates.push(c);
    solids.addBox(x, z, 2, 2);
  }

  const land = createGround(heightAt, { radius: GROUND / 2 });
  const jump = createJump({ gravity: -22, jumpSpeed: 9 });

  const input = createInput(canvas);
  input.addRegion('stick', { x: 0, y: 0.4, w: 0.5, h: 0.6 });
  input.addRegion('jump', { x: 0.62, y: 0.55, w: 0.38, h: 0.45 });
  attachControls(input, {
    stick: { region: 'stick', x: 110, y: 110, radius: 70, deadzone: 0.14 },
    buttons: [{ region: 'jump', label: 'JUMP', right: 40, bottom: 48, colour: 'rgba(120,200,255,0.22)' }],
  });

  const picker = createPicker({ canvas, camera });
  const bridge = createBridge({});

  let yaw = 0;
  let vy = 0;
  let grounded = true;
  let landings = 0;
  let airTime = 0;
  let diag;

  const resetState = () => {
    avatar.position.set(0, heightAt(0, 0) + EYE, 0);
    yaw = 0; vy = 0; grounded = true; landings = 0; airTime = 0;
  };

  const loop = createLoop({
    mode: 'continuous',
    step(dt) {
      const was = { x: avatar.position.x, z: avatar.position.z };
      const m = tankDrive(input, 'stick', yaw, { dt, camera });
      yaw = m.yaw;
      faceYaw(avatar, yaw);
      avatar.position.addScaledVector(m.velocity, SPEED * dt);
      avatar.position.copy(solids.resolve(avatar.position, 0.6, was));

      // ---- ONE OWNER PER AXIS. confine() corrects x/z and never touches y; jump.step() owns y.
      // Nothing in this chain can overwrite the ascent, which is the whole point: place() would,
      // because it returns ground + eye, and that is how the generated explorer's JUMP button
      // came to lift the player 0.15 m and no further.
      const p = land.confine(avatar.position, was);
      const reg = input.region('jump');
      const wantJump = !!(reg && reg.held) && grounded;
      const wasGrounded = grounded;
      const r = jump.step(avatar.position.y - EYE, vy, land.at(p.x, p.z), dt, wantJump);
      vy = r.vy;
      grounded = r.grounded;
      avatar.position.set(p.x, r.y + EYE, p.z);
      if (grounded && !wasGrounded) landings++;
      if (!grounded) airTime += dt;

      // Chase camera, behind and above the heading.
      const back = 9;
      camera.position.set(
        avatar.position.x - Math.sin(yaw) * back,
        avatar.position.y + 4.5,
        avatar.position.z - Math.cos(yaw) * back);
      camera.lookAt(avatar.position.x, avatar.position.y + 0.8, avatar.position.z);
    },
    render() { host.present(); diag.onFrame(); input.endFrame(); },
  });

  attachLifecycle({ canvas, loop, host });
  diag = attachDiagnostics({
    host, loop, input, actor: avatar, reset: resetState,
    getState: () => ({
      scene: 'jumper',
      view: 'avatar',
      pos: avatar.position.toArray().map((n) => +n.toFixed(2)),
      facing: [Math.sin(yaw), 0, Math.cos(yaw)],
      yaw: +yaw.toFixed(3),
      groundY: +heightAt(avatar.position.x, avatar.position.z).toFixed(2),
      grounded,
      landings,
      progress: +(airTime * 10 + landings * 5).toFixed(2),
      screen: Object.fromEntries(crates.map((c, i) => [`crate${i}`, picker.project(c.position)])),
    }),
  });

  loop.start();
  bridge.ready();
}
