// SMOKE SCENE: first person. Stresses TWO simultaneous input regions (move pad +
// look area) and camera-as-actor -- the camera IS the controlled entity.
import * as THREE from '../vendor/three.module.js';
import { createHost } from '../core/host.js';
import { createLoop } from '../core/loop.js';
import { createInput } from '../core/input.js';
import { attachLifecycle } from '../core/lifecycle.js';
import { attachDiagnostics } from '../core/diagnostics.js';
import { walkDirection } from '../core/motion.js';

export function start(canvas) {
  const host = createHost({ canvas, captureFrames: true });
  const { scene, camera } = host;
  scene.background = new THREE.Color(0x243048);
  scene.fog = new THREE.Fog(0x243048, 40, 160);
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x404a5e, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 2.0); key.position.set(8, 14, 6); scene.add(key);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: 0x4a5570 }));
  floor.rotation.x = -Math.PI / 2; scene.add(floor);
  // Keep a clear radius around the spawn point: a block at the origin puts the
  // camera inside geometry, and backface culling then shows a black screen with
  // no error at all.
  for (let i = 0; i < 40; i++) {
    const h = 2 + Math.random() * 6;
    const b = new THREE.Mesh(new THREE.BoxGeometry(2, h, 2),
      new THREE.MeshStandardMaterial({ color: 0x7c8bb0 }));
    let x = 0, z = 0;
    do { x = (Math.random() - 0.5) * 80; z = (Math.random() - 0.5) * 80; }
    while (Math.hypot(x, z) < 6);
    b.position.set(x, h / 2, z);
    scene.add(b);
  }

  // camera IS the actor
  camera.position.set(0, 1.7, 0);
  const look = { yaw: 0, pitch: 0 };
  const SPEED = 6, LOOK = 2.2;

  const input = createInput(canvas);
  input.addRegion('move', { x: 0, y: 0.45, w: 0.45, h: 0.55 });   // bottom-left pad
  input.addRegion('look', { x: 0.45, y: 0, w: 0.55, h: 1 });      // right side

  const fwd = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);

  const loop = createLoop({
    mode: 'continuous',
    step(dt) {
      const lv = input.sample('look', { radius: 90, deadzone: 0.05 });
      look.yaw -= lv.x * LOOK * dt;
      look.pitch = Math.max(-1.2, Math.min(1.2, look.pitch + lv.y * LOOK * dt));
      camera.rotation.set(0, 0, 0);
      camera.rotateY(look.yaw); camera.rotateX(look.pitch);

        // Camera-relative, via the engine. The 'look' region owns the camera's yaw, which is
        // what makes this scheme safe -- walkDirection() reports an error when it is missing.
        // Hand-rolling this trigonometry is what put a minus sign on mv.y in a generated maze:
        // "if i drag backward, then its going forward".
        const d = walkDirection(input, { move: 'move', look: 'look' }, camera, { radius: 70 });
        if (d.lengthSq() > 1e-6) {
          camera.position.addScaledVector(d, SPEED * dt);
          camera.position.y = 1.7;
        }
    },
    render() { host.present(); diag.onFrame(); input.endFrame(); },
  });

  attachLifecycle({ canvas, loop, host });
  // NOT reused from the movement scratch vector above: getState() is called by the
  // checker between frames, and writing that one here would corrupt a step in flight.
  const facingVec = new THREE.Vector3();
  const reset = () => { camera.position.set(0, 1.7, 0); look.yaw = 0; look.pitch = 0; };
  const diag = attachDiagnostics({ host, loop, input, actor: camera, reset,
    getState: () => ({ scene: 'first-person', progress: +Math.hypot(camera.position.x, camera.position.z).toFixed(1), view: 'firstPerson', pos: camera.position.toArray().map(n => +n.toFixed(3)),
                       yaw: +look.yaw.toFixed(4), pitch: +look.pitch.toFixed(4),
                       // In a first-person view the camera IS the actor, so its world
                       // direction is what "facing" means.
                       facing: (camera.getWorldDirection(facingVec), [+facingVec.x.toFixed(3), +facingVec.y.toFixed(3), +facingVec.z.toFixed(3)]) }) });
  loop.start();
  return { host, loop, input, diag };
}
