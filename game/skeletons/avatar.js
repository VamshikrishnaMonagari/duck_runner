// STARTER SCENE: the file a generated game edits. Deliberately minimal but
// complete -- it renders, it has working touch input, it persists state, and it
// stops when you lift your finger. Replace the gameplay; keep the wiring.
import * as THREE from '../vendor/three.module.js';
import { createHost } from '../core/host.js';
import { createLoop } from '../core/loop.js';
import { createInput } from '../core/input.js';
import { createPicker } from '../core/pick.js';
import { attachLifecycle } from '../core/lifecycle.js';
import { attachDiagnostics } from '../core/diagnostics.js';
import { tankDrive } from '../core/motion.js';
import { createShell } from '../core/shell.js';
import { createSolids, createGround, createUnstick } from '../core/collide.js';
import { createBridge } from '../core/bridge.js';

export function start(canvas) {
  const host = createHost({ canvas, captureFrames: true });
  const { scene, camera } = host;

  // THE LIGHTING RIG. Copy it; it is the reason a generated world is legible.
  //
  // This block is why it matters more than anything else in this file. A benchmark build
  // from the one-line brief "walk around an island and collect coins" DID generate real
  // terrain -- its own getTerrainHeight(), with the ground under the player measured at
  // 2.18 m by the checker's raycast -- and the screenshot looked like a flat green field.
  // With two lights and no shadow map, a 2 m hill and a flat plane render identically.
  // The same brief on the web produced visible hills using the same terrain approach; the
  // only difference was that it lit the scene and we did not.
  //
  // Lighting is also the ONE visual thing that survives: the agent replaces the gameplay
  // wholesale but copies this block, verbatim -- `DirectionalLight(0xffffff, 2.0)` came
  // across byte-for-byte into that island game. So this rig, not any particular geometry,
  // is what carries visual quality into every generated game.
  //
  // Sky is a DIFFERENT colour from the fog, deliberately: matching them erases the horizon
  // and flattens depth, which is why the prompt forbids it.
  scene.background = new THREE.Color(0x8fc3e8);
  scene.fog = new THREE.Fog(0xa8cfe0, 90, 240);
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x6b7d5a, 1.4));

  // KEY light, and it casts. Without a caster nothing has a shadow, and without shadows
  // every object reads as floating -- reported verbatim from a device as "all objects are
  // floating". One 1024 map is one extra depth pass; keep the box tight around the play area.
  const key = new THREE.DirectionalLight(0xfff6e2, 2.0);
  key.position.set(12, 20, 10);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 140;
  Object.assign(key.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45 });
  key.shadow.bias = -0.0012;                 // without this, surfaces self-shadow into stripes
  key.shadow.camera.updateProjectionMatrix();
  scene.add(key);

  // FILL from the opposite side, so a slope facing away from the key light still reads as
  // a slope instead of going uniformly dark. Hemisphere alone flattens everything.
  const fill = new THREE.DirectionalLight(0xcfe0f5, 0.55);
  fill.position.set(-30, 18, -25);
  scene.add(fill);

  // THE GROUND, and the one number that decides whether it reads as terrain.
  //
  // Keep the RATIO if you change this. Wavelength is 2*PI/f, and it must be a FRACTION of
  // the world size, or the whole world is inside a single wave and renders as one smooth
  // swell. Measured from a real build: a generated island used f = 0.05 -- 126-unit
  // features on an 80-unit island, 0.6 of a wave across the entire map -- and the player
  // reported it as flat ground. Here 0.14 and 0.31 give ~45 and ~20 unit features across
  // a 200-unit ground, so 4 to 10 of them are visible at once.
  //
  // ONE height function, read by BOTH the mesh and anything that stands on it. Two copies
  // drift apart, and that is how a car ends up hovering or sunk.
  const GROUND = 200;
  const heightAt = (x, z) => Math.sin(x * 0.14) * 1.8 + Math.cos(z * 0.14) * 1.8
                           + Math.sin((x + z) * 0.31) * 0.6;

  const groundGeo = new THREE.PlaneGeometry(GROUND, GROUND, 96, 96);
  groundGeo.rotateX(-Math.PI / 2);           // rotate the GEOMETRY, so x/z stay world axes
  const gpos = groundGeo.attributes.position;
  for (let i = 0; i < gpos.count; i++) gpos.setY(i, heightAt(gpos.getX(i), gpos.getZ(i)));
  groundGeo.computeVertexNormals();          // without this the slopes are lit as if flat
  const ground = new THREE.Mesh(groundGeo,
    new THREE.MeshStandardMaterial({ color: 0x6f8f5a, roughness: 0.95 }));
  ground.receiveShadow = true;               // the ground must RECEIVE or nothing lands on it
  scene.add(ground);

  const avatar = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.8),
    new THREE.MeshStandardMaterial({ color: 0x6fe0c8 }));
  avatar.position.y = heightAt(0, 0) + 0.6;
  avatar.castShadow = true;                  // and the actor must CAST, or it floats
  scene.add(avatar);

  // SOLIDS and GROUND. Trees the player cannot walk through, and a world with an edge.
  // Both were device-reported failures: "we are able to move through the trees", and being
  // able to walk out onto the water and then getting stuck at its edge.
  const solids = createSolids();
  const unstick = createUnstick();   // our own rule: recover, never leave the player wedged
  const land = createGround(heightAt, { radius: GROUND / 2, waterLevel: -0.4 });   // `ground` is the mesh

  for (const [tx, tz] of [[6, -4], [-7, -6], [10, 8], [-4, 9], [14, 2], [-12, 3]]) {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 3.2, 8),
      new THREE.MeshStandardMaterial({ color: 0x6b4a2f }));
    trunk.position.set(tx, heightAt(tx, tz) + 1.6, tz);
    const crown = new THREE.Mesh(new THREE.ConeGeometry(2.0, 3.4, 9),
      new THREE.MeshStandardMaterial({ color: 0x2f7d4f }));
    crown.position.set(tx, heightAt(tx, tz) + 4.2, tz);
    trunk.castShadow = crown.castShadow = true;
    scene.add(trunk); scene.add(crown);
    solids.addDisc(tx, tz, 0.9);          // the trunk stops the player, the crown does not
  }

  // Pickups placed where `blocked()` is false and the ground is usable, so a coin can never
  // end up inside a trunk or under the water. Once props became solid, a coin inside a trunk
  // made a game impossible to finish at 14 of 15 -- this is that rule as code rather than prose.
  const coins = [];
  const spots = [];
  for (let i = 0; i < 200 && spots.length < 5; i++) {
    const a = (spots.length + i * 0.37) * 2.399, d = 5 + ((i * 7) % 20);
    const cx = Math.cos(a) * d, cz = Math.sin(a) * d;
    if (!land.usable(cx, cz)) continue;
    if (solids.blocked(cx, cz, 1.1)) continue;   // player radius + a little clearance
    spots.push([cx, cz]);
  }
  for (const [cx, cz] of spots) {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.14, 14),
                             new THREE.MeshStandardMaterial({ color: 0xffd447 }));
    c.position.set(cx, heightAt(cx, cz) + 0.7, cz);
    c.rotation.x = Math.PI / 2; c.castShadow = true;
    scene.add(c); coins.push(c);
  }

  const heading = { yaw: 0 };
  const cam = { orbit: 0, pitch: 0.35 };   // driven by the 'look' region
  const SPEED = 9, TURN = 2.2;

  let loopRef = null;
  const input = createInput(canvas, { onActivity: () => loopRef && loopRef.invalidate() });
  input.addRegion('stick', { x: 0, y: 0.4, w: 0.5, h: 0.6 });   // bottom-left
  // A second control, because this file is what a generated game copies. A benchmark run
  // against production built the same brief with a working look control while the version
  // built from this starter could only walk -- the generated game shipped exactly the one
  // region the starter declared. What the starter demonstrates is what gets built.
  input.addRegion('look', { x: 0.5, y: 0, w: 0.5, h: 1 });      // right side: drag to look
  const picker = createPicker({ canvas, camera });

  // THE SHELL: score readout, start/win screens, restart. In the setup block deliberately --
  // this is the part of a scene that gets copied when the gameplay below is replaced.
  // `total` is a function so the display reports what EXISTS; a hard-coded total is how a game
  // came to promise more pickups than it had placed and could never be completed.
  const shell = createShell(input, {
    fields: { coins: { label: '\u{1FA99}', total: () => coins.length } },
    screens: {
      start: { title: 'ISLAND', hint: 'Collect every coin', action: 'PLAY' },
      win: { title: 'All collected', hint: 'Nicely done', action: 'PLAY AGAIN' },
    },
    onAction: () => reset(),
  });
  // SHOW the start screen -- do not delete this line to make the game boot faster.
  //
  // It is here because it is TESTED here, and nothing else in the suite tests it. A start
  // screen pauses the loop behind an overlay, so a checker has to press PLAY before anything
  // it measures means anything. check.py could not: it touched the button with a drag rather
  // than a tap, so `shell.update()`'s `if (r.tap) fire()` never fired. Every archetype passed
  // anyway, because not one of them ever put a PLAY button in front of the checker. Two
  // generated games found it instead -- an island explorer and a maze, both held on 'start',
  // between them 6 spurious failures and 16 wasted edits, and the island DELETED its own
  // start screen to get past it. assemble_publish.sh gates every publish on this scene, so
  // with the screen shown here that class of bug cannot reach a tarball again.
  shell.show('start');

  let score = 0, best = 0, collected = 0;
  const bridge = createBridge({
    onRestore: (s) => { best = (s && s.best) || 0; },
    onAppState: (s) => (s === 'active' ? loop.resume() : loop.pause()),
  });

  const camTarget = new THREE.Vector3();
  const loop = loopRef = createLoop({
    mode: 'continuous',
    step(dt) {
      // TANK drive via the engine: x turns, y drives. Hand-rolling this is where the control
      // defects came from -- a sign on y walks backwards, and deriving the heading FROM a
      // camera-relative direction while the camera follows the heading makes the avatar spin
      // in place instead of reversing. `velocity` already carries the throttle sign, so
      // reverse works without negating anything here.
      shell.update();                      // lets the harness and a finger press the same button
      if (shell.screen) return;            // paused behind an overlay: do not simulate

      for (const c of coins) {
        if (c.visible && c.position.distanceTo(avatar.position) < 1.6) {
          c.visible = false;
          collected += 1;
          shell.set('coins', collected);   // ONE value: the HUD and getState read the same field
          if (collected >= coins.length) shell.show('win');
        }
      }

      const m = tankDrive(input, 'stick', heading.yaw, { dt, turnRate: TURN, radius: 70 });
      heading.yaw = m.yaw;
      avatar.rotation.y = m.yaw;
      const was = { x: avatar.position.x, z: avatar.position.z };
      avatar.position.addScaledVector(m.velocity, SPEED * dt);
      // Solids first, then the world edge and the waterline, then sit on the surface. The
      // scene never computes a normal or a sign; both helpers return a corrected position.
      avatar.position.copy(unstick.step(avatar.position, m.velocity, dt));
      avatar.position.copy(solids.resolve(avatar.position, 0.6, was));
      avatar.position.copy(land.place(avatar.position, 0.6, was));
      const v = { x: m.turn, y: m.throttle };
      // Follow the ground. Same function the mesh was built from, so they cannot disagree.

      score += Math.abs(v.y) * dt * 10;
      if (score > best) { best = score; bridge.save({ best: Math.round(best) }); }

      // Look: orbit around the avatar, pitch clamped so the camera never ends up under
      // the ground or staring at the sky.
      const lk = input.sample('look', { radius: 90, deadzone: 0.08 });
      cam.orbit -= lk.x * 2.0 * dt;
      cam.pitch = Math.max(0.08, Math.min(0.85, cam.pitch + lk.y * 1.2 * dt));

      const a = heading.yaw + cam.orbit, r = 9 * Math.cos(cam.pitch);
      camTarget.set(avatar.position.x - Math.sin(a) * r, 1 + 9 * Math.sin(cam.pitch), avatar.position.z - Math.cos(a) * r);
      camera.position.lerp(camTarget, Math.min(1, dt * 4));
      camera.lookAt(avatar.position);
    },
    render() { host.present(); diag.onFrame(); input.endFrame(); },
  });

  attachLifecycle({ canvas, loop, host });
  // Put the world back where it started. Automated checks call this before every precise
  // measurement, because by then earlier checks have deliberately driven the player to the
  // edge of the world, and a number taken from there is not a measurement of the game: a
  // reference car reported 30.8 m and 35.6 m of travel on its first two direction checks
  // and then 1.0, 0.9 and 0.3 m, parked against the barrier. Restore POSITION and heading;
  // restore anything consumable (collectibles, spawned enemies) so an objective can be
  // reached again. Do not clear `best` -- that is saved progress, not run state.
  const reset = () => {
    avatar.position.set(0, heightAt(0, 0) + 0.6, 0);
    heading.yaw = 0; avatar.rotation.y = 0;
    cam.orbit = 0; cam.pitch = 0.35;
    score = 0;
    collected = 0;
    for (const c of coins) c.visible = true;
    shell.set('coins', 0);
  };

  const diag = attachDiagnostics({ host, loop, input, actor: avatar, reset,
    getState: () => ({ scene: 'starter', view: 'avatar', pos: avatar.position.toArray().map((n) => +n.toFixed(2)),
                       // Contract read by check.py -- see game/README.md.
                       facing: [+Math.sin(heading.yaw).toFixed(3), 0, +Math.cos(heading.yaw).toFixed(3)],
                       groundY: +heightAt(avatar.position.x, avatar.position.z).toFixed(3),
                       yaw: +heading.yaw.toFixed(4),
                       // `progress` is the COIN COUNT, not the distance walked. A progress field
                       // that rises merely from holding the stick can never fail, so it verifies
                       // nothing: a build whose coin counter was broken passed this check by
                       // reporting movement. Report the thing the player is actually trying to do.
                       progress: collected,
                       // WHERE the coins are, in screen pixels. The harness steers toward these,
                       // so "can the player make progress" becomes a real test of collection
                       // instead of a hope that driving forward happens to cross a pickup.
                       screen: Object.fromEntries(coins.map((c, i) =>
                         [`coin${i}`, c.visible ? picker.project(c.position) : null])),
                       score: Math.round(score), best: Math.round(best),
                       hosted: bridge.isHosted, ...shell.report() }) });
  loop.start();
  bridge.ready();
  return { host, loop, input, diag, bridge };
}
