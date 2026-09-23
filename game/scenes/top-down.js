// SMOKE SCENE: top-down / tower-defence. Stresses picking against a GROUND PLANE
// (not just objects), camera pan, pinch-zoom, and tap-to-place.
import * as THREE from '../vendor/three.module.js';
import { createHost } from '../core/host.js';
import { createLoop } from '../core/loop.js';
import { createInput } from '../core/input.js';
import { createPicker } from '../core/pick.js';
import { attachLifecycle } from '../core/lifecycle.js';
import { attachDiagnostics } from '../core/diagnostics.js';

export function start(canvas) {
  const host = createHost({ canvas, captureFrames: true });
  const { scene, camera } = host;
  scene.background = new THREE.Color(0x2a3a2e);
  scene.add(new THREE.HemisphereLight(0xdfeedd, 0x5a6a5e, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.8); key.position.set(10, 20, 8); scene.add(key);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ color: 0x6f8a63 }));
  ground.rotation.x = -Math.PI / 2; scene.add(ground);
  const grid = new THREE.GridHelper(60, 30, 0x9fb894, 0x8aa37f); scene.add(grid);

  // fixed high angle; drag pans the focus point, pinch changes height
  const focus = new THREE.Vector3(0, 0, 0);
  const view = { height: 26, tilt: 0.95 };
  function applyCamera() {
    camera.position.set(focus.x, view.height, focus.z + view.height / Math.tan(view.tilt));
    camera.lookAt(focus);
  }
  applyCamera();

  let loopRef = null;
  const input = createInput(canvas, { onActivity: () => loopRef && loopRef.invalidate() });
  input.addRegion('world', { x: 0, y: 0, w: 1, h: 1 });
  const picker = createPicker({ canvas, camera });

  const placed = [];
  const towerGeo = new THREE.CylinderGeometry(0.8, 1.1, 2.4, 8);
  const towerMat = new THREE.MeshStandardMaterial({ color: 0xd8b25a });
  let lastPinch = null;

  const loop = loopRef = createLoop({
    mode: 'onDemand',
    render() {
      const reg = input.region('world');
      const p = input.pinch('world');
      if (p && lastPinch) { view.height = Math.max(10, Math.min(60, view.height - (p.dist - lastPinch) * 0.05)); applyCamera(); }
      lastPinch = p ? p.dist : null;
      if (!p) {
        const v = input.sample('world', { radius: 150, deadzone: 0.02 });
        if (v.x || v.y) { focus.x -= v.x * 0.6; focus.z += v.y * 0.6; applyCamera(); }
      }
      if (reg.tap) {
        // pick against the ground plane, snap to the grid, place a tower
        const { hits } = picker.pick(reg.tap.x, reg.tap.y, ground);
        if (hits.length) {
          const pt = hits[0].point;
          const t = new THREE.Mesh(towerGeo, towerMat);
          t.position.set(Math.round(pt.x / 2) * 2, 1.2, Math.round(pt.z / 2) * 2);
          scene.add(t); placed.push(t);
        }
      }
      host.present(); diag.onFrame(); input.endFrame();
    },
  });

  attachLifecycle({ canvas, loop, host });
  const diag = attachDiagnostics({ host, loop, input,
    getState: () => ({ scene: 'top-down', view: 'placement', placed: placed.length, height: +view.height.toFixed(2),
                       focus: [+focus.x.toFixed(2), +focus.z.toFixed(2)],
                       last: placed.length ? placed[placed.length - 1].position.toArray().map(n => +n.toFixed(2)) : null }) });
  loop.start();
  return { host, loop, input, diag };
}
