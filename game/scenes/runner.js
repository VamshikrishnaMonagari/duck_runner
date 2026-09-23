// SMOKE SCENE: endless runner. Stresses SWIPE input (not a joystick) and chunk
// streaming with an accumulated world offset -- the case where spawning from a
// monotonic counter while the world translates opens ever-growing holes that only
// appear after ten or more seconds of play.
import * as THREE from '../vendor/three.module.js';
import { createHost } from '../core/host.js';
import { createLoop } from '../core/loop.js';
import { createInput } from '../core/input.js';
import { attachLifecycle } from '../core/lifecycle.js';
import { attachDiagnostics } from '../core/diagnostics.js';
import { createBridge } from '../core/bridge.js';
import { createContacts } from '../core/contact.js';
import { laneDelta } from '../core/motion.js';

const LANES = [-2.2, 0, 2.2], CHUNK = 20, ACTIVE = 6;

export function start(canvas) {
  const host = createHost({ canvas, captureFrames: true });
  const { scene, camera } = host;
  scene.background = new THREE.Color(0x2b2f4a);
  scene.fog = new THREE.Fog(0x2b2f4a, 60, 170);
  scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x505a78, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.9); key.position.set(4, 14, 6); scene.add(key);

  const roadGeo = new THREE.BoxGeometry(8, 0.2, CHUNK);
  const roadMat = new THREE.MeshStandardMaterial({ color: 0x5c6486 });
  const propGeo = new THREE.BoxGeometry(1.4, 1.4, 1.4);
  const propMat = new THREE.MeshStandardMaterial({ color: 0xe2665c });
  const coinGeo = new THREE.IcosahedronGeometry(0.34, 0);
  const coinMat = new THREE.MeshStandardMaterial({ color: 0xf2c14e, metalness: 0.5, roughness: 0.3 });

  // Collecting and dying come from core/contact.js. Registered once at spawn; the module owns
  // the test. A device build hand-rolled both and shipped with coins that never counted and
  // trains you could drive through -- while passing 18 of 18 checks, because nothing here
  // measured the verb until contacts.report() was merged into getState() below.
  const contacts = createContacts();
  let coins = 0, lives = 3;

  const player = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1.6),
    new THREE.MeshStandardMaterial({ color: 0x6fe0c8 }));
  player.position.set(0, 0.8, 0); scene.add(player);
  camera.position.set(0, 4.2, 7); camera.lookAt(0, 1, -8);

  // Chunks are spawned RELATIVE TO THE LAST LIVE CHUNK, never from an absolute
  // counter, so no gap can accumulate as the world translates.
  const chunks = [];
  function spawnChunk() {
    const startZ = chunks.length ? chunks[chunks.length - 1].startZ - CHUNK : 0;
    const meshes = [];
    const road = new THREE.Mesh(roadGeo, roadMat);
    road.position.set(0, 0, startZ - CHUNK / 2); scene.add(road); meshes.push(road);
    const chunk = { startZ, meshes };
    const n = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) {
      const p = new THREE.Mesh(propGeo, propMat);
      p.position.set(LANES[Math.floor(Math.random() * 3)], 0.8, startZ - Math.random() * CHUNK);
      scene.add(p); meshes.push(p);
      // touching it costs a life -- the CONSEQUENCE is the scene's, the detection is not
      contacts.hazard(p, { radius: 0.85, group: chunk, onHit: () => { lives -= 1; bridge.haptic('heavy'); } });
    }
    for (let i = 0; i < 3; i++) {
      const c = new THREE.Mesh(coinGeo, coinMat);
      c.position.set(LANES[Math.floor(Math.random() * 3)], 0.9, startZ - Math.random() * CHUNK);
      scene.add(c); meshes.push(c);
      contacts.pickup(c, { radius: 0.7, group: chunk, onTake: () => { coins += 1; bridge.haptic('light'); } });
    }
    chunks.push(chunk);
  }
  for (let i = 0; i < ACTIVE; i++) spawnChunk();

  let lane = 1, speed = 14, distance = 0, spawned = ACTIVE, best = 0, paused = false;
  const wasAt = player.position.clone();

  // Bridge is a no-op outside a WebView, so the same bundle runs in a browser.
  const bridge = createBridge({
    onRestore: (state) => { best = (state && state.best) || 0; },
    onAppState: (s) => { paused = s !== 'active'; paused ? loop.pause() : loop.resume(); },
  });
  let loopRef = null;
  const input = createInput(canvas, { onActivity: () => loopRef && loopRef.invalidate() });
  input.addRegion('track', { x: 0, y: 0, w: 1, h: 1 });
  let swipeArmed = true;

  const loop = loopRef = createLoop({
    mode: 'continuous',
    step(dt) {
      speed = Math.min(34, speed + dt * 0.6);
      distance += speed * dt;

      // swipe: one lane change per gesture, re-armed on release
      const v = input.sample('track', { radius: 55, deadzone: 0.35 });
      if (swipeArmed && Math.abs(v.x) > 0.35) {
        // laneDelta, not `v.x > 0 ? 1 : -1`. The raw sign is screen-space; which WORLD direction
        // is screen-right depends on where the camera looks, and an on-rails camera does not have
        // to look down -Z. Deriving it by hand is the same coin flip that shipped a racer whose
        // buttons steered the wrong way on all twelve of its check runs. laneDelta asks the
        // camera, so a scene that later moves the camera keeps working.
        lane = Math.max(0, Math.min(2, lane + laneDelta(camera, v.x > 0 ? 'right' : 'left')));
        swipeArmed = false;
        bridge.haptic('light');
      }
      if (!input.region('track').held) swipeArmed = true;
      player.position.x += (LANES[lane] - player.position.x) * Math.min(1, dt * 12);

      for (const ch of chunks) {
        ch.startZ += speed * dt;
        for (const m of ch.meshes) m.position.z += speed * dt;
      }
      while (chunks.length && chunks[0].startZ > CHUNK) {
        for (const m of chunks[0].meshes) scene.remove(m);
        contacts.removeGroup(chunks[0]);   // recycled props must stop being touchable
        chunks.shift();
      }
      while (chunks.length < ACTIVE) { spawnChunk(); spawned++; }

      // AFTER both the player and the world have moved, with where the player was: the module
      // sweeps the relative motion, which is what makes a coin at 34 m/s collectable at 20 fps.
      contacts.step(wasAt, player.position, { radius: 0.5 });
      wasAt.copy(player.position);
      // Lives come back; DISTANCE DOES NOT RESET. Zeroing it made progress run backwards
      // (38 -> 22) and failed the progress check on this very skeleton -- a game whose reported
      // progress can decrease is indistinguishable from one that is going nowhere. A real runner
      // ends the run here and shows a score; this smoke scene keeps going so the checker has
      // something continuous to measure.
      if (lives <= 0) { lives = 3; coins = 0; }

      if (Math.round(distance) > best) { best = Math.round(distance); bridge.save({ best }); }
    },
    render() { host.present(); diag.onFrame(); input.endFrame(); },
  });

  attachLifecycle({ canvas, loop, host });
  const diag = attachDiagnostics({ host, loop, input, actor: player,
    // pos even though this is on rails: the forward motion is automatic, but there IS an
    // actor, and without pos the checker cannot see whether it holds still between lanes.
    getState: () => ({ scene: 'runner', view: 'onRails', lane, x: +player.position.x.toFixed(2),
                       // The world is carried past the player, so the player's heading is fixed:
                       // it travels -Z. Publishing it is what lets the checker see which side the
                       // camera is on -- an on-rails game has a camera permanently behind the
                       // player and was, until now, the one shape never checked for it.
                       facing: [0, 0, -1],
                       pos: player.position.toArray().map((n) => +n.toFixed(3)),
                       distance: Math.round(distance), speed: +speed.toFixed(1),
                       chunks: chunks.length, spawned,
                       // the streaming guard: is there road under and ahead of the player?
                       covered: chunks.some((c) => c.startZ - CHUNK <= 0 && c.startZ >= 0),
                       ahead: chunks.filter((c) => c.startZ < 0).length,
                       best, hosted: bridge.isHosted, coins, lives,
                       // contacts.report() is what makes collecting and dying CHECKABLE at all
                       ...contacts.report() }) });
  loop.start();
  bridge.ready();
  return { host, loop, input, diag, bridge };
}
