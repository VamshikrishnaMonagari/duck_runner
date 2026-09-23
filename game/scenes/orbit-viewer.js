// SMOKE SCENE: product viewer. Stresses on-demand loop, pick, pinch-zoom,
// camera-as-orbit, tween. No physics, no simulation.
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
  scene.background = new THREE.Color(0x101018);
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x20202a, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(4, 6, 3); scene.add(key);

  const parts = [];
  const palette = [0x4fd6ff, 0xff4fa3, 0xffd54f];
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: palette[i], roughness: 0.35 }));
    m.position.set((i - 1) * 1.6, 0, 0); m.name = 'part' + i;
    scene.add(m); parts.push(m);
  }

  const target = new THREE.Vector3(0, 0, 0);
  // Distance from fitBounds, not a hand-picked number. This scene used dist: 7 and the
  // framing check measured the subject at 9% of the screen -- a viewer whose subject is a
  // speck. fitBounds returns the distance that frames the box at the LIVE aspect ratio,
  // which is the practice the guidance asks generated games to follow; a template scene
  // demonstrating the opposite teaches the opposite.
  const bounds = new THREE.Box3().setFromObject(scene);
  const orbit = { az: 0.6, pol: 1.1, dist: host.fitBounds(bounds.min, bounds.max, { padding: 1.15 }) };
  function applyCamera() {
    const sp = Math.sin(orbit.pol), cp = Math.cos(orbit.pol);
    camera.position.set(target.x + orbit.dist * sp * Math.sin(orbit.az),
                        target.y + orbit.dist * cp,
                        target.z + orbit.dist * sp * Math.cos(orbit.az));
    camera.lookAt(target);
  }
  applyCamera();

  const input = createInput(canvas, { onActivity: () => loopRef && loopRef.invalidate() });
  let loopRef = null;
  input.addRegion('view', { x: 0, y: 0, w: 1, h: 1 });
  const picker = createPicker({ canvas, camera });
  let selected = null, lastPinch = null;

  const loop = loopRef = createLoop({
    mode: 'onDemand',
    render() {
      const reg = input.region('view');
      const p = input.pinch('view');
      if (p && lastPinch) { orbit.dist = Math.max(3, Math.min(20, orbit.dist - (p.dist - lastPinch) * 0.02)); applyCamera(); }
      lastPinch = p ? p.dist : null;
      if (!p) {
        const v = input.sample('view', { radius: 120, deadzone: 0.02 });
        if (v.x || v.y) { orbit.az -= v.x * 0.06; orbit.pol = Math.max(0.2, Math.min(2.9, orbit.pol - v.y * 0.05)); applyCamera(); }
      }
      if (reg.tap) {
        const { hits } = picker.pick(reg.tap.x, reg.tap.y, parts);
        if (hits.length) {
          selected = hits[0].object;
          loop.schedule(selected.scale, { x: 1.35, y: 1.35, z: 1.35 }, 220);
          for (const m of parts) if (m !== selected) loop.schedule(m.scale, { x: 1, y: 1, z: 1 }, 220);
        }
      }
      host.present();
      diag.onFrame();
      input.endFrame();
    },
  });

  attachLifecycle({ canvas, loop, host });
  const diag = attachDiagnostics({ host, loop, input,
    getState: () => ({ scene: 'orbit-viewer', view: 'placement', camera: camera.position.toArray().map(n => +n.toFixed(3)),
                       dist: +orbit.dist.toFixed(2), az: +orbit.az.toFixed(3), selected: selected && selected.name }) });
  loop.start();
  return { host, loop, input, diag };
}
