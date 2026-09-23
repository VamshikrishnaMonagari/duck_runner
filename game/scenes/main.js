// Duck Runner — Temple Escape
// Endless runner with a procedural duck, built on the pre-debugged engine.
import * as THREE from '../vendor/three.module.js';
import { createHost }  from '../core/host.js';
import { createLoop }  from '../core/loop.js';
import { createInput } from '../core/input.js';
import { attachLifecycle }   from '../core/lifecycle.js';
import { attachDiagnostics } from '../core/diagnostics.js';
import { createBridge }   from '../core/bridge.js';
import { createContacts } from '../core/contact.js';
import { createShell }    from '../core/shell.js';
import { laneDelta }      from '../core/motion.js';

const LANES  = [-2.5, 0, 2.5];
const CHUNK  = 20;
const AHEAD  = 7;
const PATH_W = 7.5;
const SPD0   = 12;
const SPD_MAX = 30;
const GRAV   = 30;
const JVEL   = 12;
const SLIDE_DUR = 0.8;

export function start(canvas) {

  /* ── host ── */
  const host = createHost({ canvas, captureFrames: true });
  const { scene, camera } = host;

  scene.background = new THREE.Color(0x0B1628);
  scene.fog = new THREE.FogExp2(0x0E1A30, 0.014);

  scene.add(new THREE.HemisphereLight(0x4466AA, 0x221100, 1.6));
  const sun = new THREE.DirectionalLight(0xFFDDAA, 2.2);
  sun.position.set(4, 14, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const sc = sun.shadow.camera;
  sc.left = -15; sc.right = 15; sc.top = 30; sc.bottom = -5; sc.far = 60;
  scene.add(sun);

  camera.position.set(0, 5, 8);
  camera.lookAt(0, 1, -10);

  /* ── duck ── */
  function makeDuck() {
    const g = new THREE.Group();
    const Y  = new THREE.MeshStandardMaterial({ color: 0xF5D442 });
    const O  = new THREE.MeshStandardMaterial({ color: 0xE8891C });
    const DY = new THREE.MeshStandardMaterial({ color: 0xE8C83A });
    const BK = new THREE.MeshStandardMaterial({ color: 0x111111 });

    const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), Y);
    body.scale.set(1, 0.85, 1.1); body.position.y = 0.5; body.castShadow = true;
    g.add(body);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.35, 16, 12), Y);
    head.position.set(0, 1.05, -0.15); head.castShadow = true;
    g.add(head);

    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 8), O);
    beak.rotation.x = -Math.PI / 2; beak.position.set(0, 1.0, -0.5);
    g.add(beak);

    const eG = new THREE.SphereGeometry(0.06, 8, 8);
    const le = new THREE.Mesh(eG, BK); le.position.set(-0.18, 1.15, -0.35); g.add(le);
    const re = new THREE.Mesh(eG, BK); re.position.set(0.18, 1.15, -0.35);  g.add(re);

    const wG = new THREE.BoxGeometry(0.1, 0.35, 0.45);
    const lw = new THREE.Mesh(wG, DY); lw.position.set(-0.55, 0.55, 0); g.add(lw);
    const rw = new THREE.Mesh(wG, DY); rw.position.set(0.55, 0.55, 0);  g.add(rw);

    const fG = new THREE.BoxGeometry(0.15, 0.08, 0.2);
    const lf = new THREE.Mesh(fG, O); lf.position.set(-0.15, 0.04, -0.05); g.add(lf);
    const rf = new THREE.Mesh(fG, O); rf.position.set(0.15, 0.04, -0.05);  g.add(rf);

    g._p = { lw, rw, lf, rf };
    return g;
  }

  const duck = makeDuck();
  duck.position.set(0, 0, 0);
  scene.add(duck);

  const shieldBubble = new THREE.Mesh(
    new THREE.SphereGeometry(0.9, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0x66BB6A, transparent: true, opacity: 0.25,
      emissive: 0x66BB6A, emissiveIntensity: 0.3 })
  );
  shieldBubble.position.y = 0.5; shieldBubble.visible = false;
  duck.add(shieldBubble);

  /* ── shared geo ── */
  const pathGeo = new THREE.BoxGeometry(PATH_W, 0.3, CHUNK);
  const pathMat = new THREE.MeshStandardMaterial({ color: 0x7A7A6E });
  const tileGeo = new THREE.BoxGeometry(PATH_W, 0.32, 0.06);
  const tileMat = new THREE.MeshStandardMaterial({ color: 0x5A5A50 });
  const wallGeo = new THREE.BoxGeometry(0.5, 1.5, CHUNK);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x5A5A50 });
  const coinGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.1, 16);
  const coinMat = new THREE.MeshStandardMaterial({ color: 0xFFD700, emissive: 0xFFD700,
    emissiveIntensity: 0.3, metalness: 0.7, roughness: 0.2 });

  /* ── contacts ── */
  const contacts = createContacts();
  const coinRefs = [];

  /* ── state ── */
  let lane = 1, spd = SPD0, dist = 0, score = 0, coinCnt = 0;
  let alive = true, started = false, overSent = false, tumbleT = 0, elapsed = 0, sMult = 1;
  let jumping = false, jvy = 0, py = 0;
  let sliding = false, slT = 0;
  let magnetOn = false, magnetT = 0, shieldOn = false, boostOn = false, boostT = 0;
  let pendingKeyDir = null;
  let dObs = 0, nObs = 22, dPow = 0, nPow = 40 + Math.random() * 40;
  const wasAt = duck.position.clone();
  const chunks = [];

  /* ── audio ── */
  let actx = null, sndOn = true;
  function ac() {
    if (!actx) try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
    return actx;
  }
  function sfx(type) {
    if (!sndOn) return;
    const c = ac(); if (!c) return;
    const n = c.currentTime;
    if (type === 'coin') {
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.value = 880; g.gain.setValueAtTime(0.12, n);
      g.gain.exponentialRampToValueAtTime(0.001, n + 0.1);
      o.connect(g).connect(c.destination); o.start(n); o.stop(n + 0.1);
    } else if (type === 'jump') {
      const len = c.sampleRate * 0.12 | 0;
      const b = c.createBuffer(1, len, c.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const s = c.createBufferSource(); s.buffer = b;
      const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2000;
      const g = c.createGain(); g.gain.setValueAtTime(0.08, n);
      s.connect(f).connect(g).connect(c.destination); s.start(n);
    } else if (type === 'slide') {
      const len = c.sampleRate * 0.15 | 0;
      const b = c.createBuffer(1, len, c.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const s = c.createBufferSource(); s.buffer = b;
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 400;
      const g = c.createGain(); g.gain.setValueAtTime(0.08, n);
      s.connect(f).connect(g).connect(c.destination); s.start(n);
    } else if (type === 'hit') {
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.value = 120; g.gain.setValueAtTime(0.25, n);
      g.gain.exponentialRampToValueAtTime(0.001, n + 0.3);
      o.connect(g).connect(c.destination); o.start(n); o.stop(n + 0.3);
    } else if (type === 'over') {
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.setValueAtTime(440, n); o.frequency.exponentialRampToValueAtTime(110, n + 0.8);
      g.gain.setValueAtTime(0.15, n); g.gain.exponentialRampToValueAtTime(0.001, n + 0.8);
      o.connect(g).connect(c.destination); o.start(n); o.stop(n + 0.8);
    } else if (type === 'power') {
      [440, 660, 880].forEach((fr, i) => {
        const o = c.createOscillator(), g = c.createGain();
        o.frequency.value = fr; g.gain.setValueAtTime(0.1, n + i * 0.07);
        g.gain.exponentialRampToValueAtTime(0.001, n + i * 0.07 + 0.12);
        o.connect(g).connect(c.destination); o.start(n + i * 0.07); o.stop(n + i * 0.07 + 0.12);
      });
    }
  }

  /* ── collision handler ── */
  function onHit() {
    if (!alive || !started) return;
    if (shieldOn) { shieldOn = false; shieldBubble.visible = false; bridge.haptic('medium'); return; }
    alive = false; sfx('hit'); bridge.haptic('heavy'); tumbleT = 1.5;
  }

  /* ── obstacle spawning ── */
  function addObs(chunk, lz) {
    const t = Math.floor(Math.random() * 4);
    const z = chunk.startZ - lz;
    const ms = chunk.meshes;

    if (t === 0) { // LOG — jump
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, PATH_W, 12),
        new THREE.MeshStandardMaterial({ color: 0x6B4226 }));
      m.rotation.z = Math.PI / 2; m.position.set(0, 0.4, z); m.castShadow = true;
      scene.add(m); ms.push(m);
      for (let l = 0; l < 3; l++) {
        const h = new THREE.Object3D(); h.position.set(LANES[l], 0, z);
        scene.add(h); ms.push(h);
        contacts.hazard(h, { radius: 1.0, group: chunk, onHit: () => { if (py < 1.0) onHit(); } });
      }
    } else if (t === 1) { // BRANCH — slide
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, PATH_W, 10),
        new THREE.MeshStandardMaterial({ color: 0x6B4226 }));
      m.rotation.z = Math.PI / 2; m.position.set(0, 1.8, z);
      scene.add(m); ms.push(m);
      [-2, 0, 2].forEach(lx => {
        const lf = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 8),
          new THREE.MeshStandardMaterial({ color: 0x2D5A27 }));
        lf.position.set(lx, 2.1, z); scene.add(lf); ms.push(lf);
      });
      for (let l = 0; l < 3; l++) {
        const h = new THREE.Object3D(); h.position.set(LANES[l], 0, z);
        scene.add(h); ms.push(h);
        contacts.hazard(h, { radius: 1.0, group: chunk, onHit: () => { if (!sliding) onHit(); } });
      }
    } else if (t === 2) { // STONE WALL — dodge
      const nL = 1 + Math.floor(Math.random() * 2);
      const sL = Math.floor(Math.random() * (3 - nL + 1));
      for (let i = 0; i < nL; i++) {
        const w = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2, 0.8),
          new THREE.MeshStandardMaterial({ color: 0x7A7A6E }));
        w.position.set(LANES[sL + i], 1, z); w.castShadow = true;
        scene.add(w); ms.push(w);
        const h = new THREE.Object3D(); h.position.set(LANES[sL + i], 0, z);
        scene.add(h); ms.push(h);
        contacts.hazard(h, { radius: 1.0, group: chunk, onHit: () => onHit() });
      }
    } else { // FIRE RING — jump through
      const li = Math.floor(Math.random() * 3);
      const m = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.12, 12, 24),
        new THREE.MeshStandardMaterial({ color: 0xFF4500, emissive: 0xFF4500, emissiveIntensity: 0.5 }));
      m.position.set(LANES[li], 1.2, z); m.rotation.y = Math.PI / 2;
      scene.add(m); ms.push(m);
      const h = new THREE.Object3D(); h.position.set(LANES[li], 0, z);
      scene.add(h); ms.push(h);
      contacts.hazard(h, { radius: 1.0, group: chunk, onHit: () => { if (py < 0.8) onHit(); } });
    }
  }

  /* ── coin line ── */
  function addCoins(chunk, lz) {
    const li = Math.floor(Math.random() * 3);
    const n = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const c = new THREE.Mesh(coinGeo, coinMat);
      c.position.set(LANES[li], 1.0, chunk.startZ - lz - i * 1.5);
      scene.add(c); chunk.meshes.push(c); coinRefs.push(c);
      contacts.pickup(c, { radius: 1.2, group: chunk, onTake: () => {
        coinCnt++; score += 10 * sMult; sfx('coin'); bridge.haptic('light');
        const idx = coinRefs.indexOf(c); if (idx >= 0) coinRefs.splice(idx, 1);
      } });
    }
  }

  /* ── powerup ── */
  function addPow(chunk, lz) {
    const types = ['magnet', 'shield', 'speed'];
    const t = types[Math.floor(Math.random() * 3)];
    const li = Math.floor(Math.random() * 3);
    const mats = {
      magnet: new THREE.MeshStandardMaterial({ color: 0x4FC3F7, emissive: 0x4FC3F7, emissiveIntensity: 0.5 }),
      shield: new THREE.MeshStandardMaterial({ color: 0x66BB6A, emissive: 0x66BB6A, emissiveIntensity: 0.5 }),
      speed:  new THREE.MeshStandardMaterial({ color: 0xEF5350, emissive: 0xEF5350, emissiveIntensity: 0.5 }),
    };
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.4, 16, 12), mats[t]);
    m.position.set(LANES[li], 1.2, chunk.startZ - lz);
    scene.add(m); chunk.meshes.push(m);
    contacts.pickup(m, { radius: 1.0, group: chunk, onTake: () => {
      sfx('power'); bridge.haptic('medium');
      if (t === 'magnet') { magnetOn = true; magnetT = 8; }
      else if (t === 'shield') { shieldOn = true; shieldBubble.visible = true; }
      else { boostOn = true; boostT = 5; sMult = 2; }
    } });
  }

  /* ── chunk ── */
  function spawnChunk(items) {
    const sZ = chunks.length ? chunks[chunks.length - 1].startZ - CHUNK : 0;
    const ms = [];

    const p = new THREE.Mesh(pathGeo, pathMat);
    p.position.set(0, 0, sZ - CHUNK / 2); p.receiveShadow = true;
    scene.add(p); ms.push(p);
    for (let i = 0; i < CHUNK; i += 2) {
      const l = new THREE.Mesh(tileGeo, tileMat);
      l.position.set(0, 0.16, sZ - i); scene.add(l); ms.push(l);
    }
    const lW = new THREE.Mesh(wallGeo, wallMat);
    lW.position.set(-PATH_W / 2 - 0.25, 0.75, sZ - CHUNK / 2); scene.add(lW); ms.push(lW);
    const rW = new THREE.Mesh(wallGeo, wallMat);
    rW.position.set(PATH_W / 2 + 0.25, 0.75, sZ - CHUNK / 2); scene.add(rW); ms.push(rW);

    // trees
    for (let i = 0, n = 1 + Math.floor(Math.random() * 3); i < n; i++) {
      const s = Math.random() < 0.5 ? -1 : 1;
      const xo = PATH_W / 2 + 2 + Math.random() * 5;
      const h = 4 + Math.random() * 4;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 2, 8),
        new THREE.MeshStandardMaterial({ color: 0x6B4226 }));
      trunk.position.set(s * xo, 1, sZ - Math.random() * CHUNK); trunk.castShadow = true;
      scene.add(trunk); ms.push(trunk);
      const top = new THREE.Mesh(new THREE.ConeGeometry(1.2, h, 8),
        new THREE.MeshStandardMaterial({ color: 0x2D5A27 }));
      top.position.set(s * xo, 2 + h / 2, trunk.position.z); top.castShadow = true;
      scene.add(top); ms.push(top);
    }
    // ruins 30%
    if (Math.random() < 0.3) {
      const s = Math.random() < 0.5 ? -1 : 1;
      const rh = 1 + Math.random() * 3;
      const r = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, rh, 8),
        new THREE.MeshStandardMaterial({ color: 0x8A8A7A }));
      r.position.set(s * (PATH_W / 2 + 1.5), rh / 2, sZ - Math.random() * CHUNK);
      scene.add(r); ms.push(r);
    }
    // torches 40%
    if (Math.random() < 0.4) {
      const s = Math.random() < 0.5 ? -1 : 1;
      const tz = sZ - CHUNK / 2;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 6),
        new THREE.MeshStandardMaterial({ color: 0x6B4226 }));
      pole.position.set(s * (PATH_W / 2 + 0.25), 2, tz); scene.add(pole); ms.push(pole);
      const fl = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 8),
        new THREE.MeshStandardMaterial({ color: 0xFF6600, emissive: 0xFF6600, emissiveIntensity: 1 }));
      fl.position.set(pole.position.x, 2.6, tz); scene.add(fl); ms.push(fl);
      const tl = new THREE.PointLight(0xFF6600, 3, 10);
      tl.position.copy(fl.position); scene.add(tl); ms.push(tl);
    }

    const chunk = { startZ: sZ, meshes: ms };
    chunks.push(chunk);
    if (items) addCoins(chunk, 3 + Math.random() * 12);
    return chunk;
  }

  for (let i = 0; i < AHEAD; i++) spawnChunk(i > 1);

  /* ── bridge ── */
  const bridge = createBridge({
    onRestore: (s) => { if (s && typeof s.soundEnabled === 'boolean') sndOn = s.soundEnabled; },
    onAppState: (s) => { s !== 'active' ? loop.pause() : loop.resume(); },
  });
  if (typeof window !== 'undefined' && window.__GAME_CONFIG__) {
    sndOn = window.__GAME_CONFIG__.soundEnabled !== false;
  }

  /* ── input ── */
  const input = createInput(canvas, {});
  input.addRegion('track', { x: 0, y: 0, w: 1, h: 1 });

  /* ── shell ── */
  const shell = createShell(input, {
    fields: { score: { label: '⭐' }, dist: { label: '🏃' }, coins: { label: '💰' } },
    screens: {
      start: { title: 'DUCK RUN', hint: 'Temple Escape\n\nSwipe or Arrow Keys / WASD\n← → dodge · ↑ / Space jump · ↓ slide', action: 'TAP TO PLAY' },
      pause: { title: 'PAUSED', action: '▶ RESUME' },
      over:  { title: 'GAME OVER', action: 'PLAY AGAIN' },
    },
    onAction: (from) => {
      if (from === 'start') { started = true; pauseBtn.style.display = 'flex'; }
      else if (from === 'pause') { pauseBtn.style.display = 'flex'; quitBtn.style.display = 'none'; }
      else if (from === 'over') { doReset(); }
    },
  });
  shell.show('start');
  shell.set('score', '0'); shell.set('dist', '0m'); shell.set('coins', '0');

  /* ── keyboard (web / desktop) ── */
  if (typeof window !== 'undefined') {
    const keyMap = {
      ArrowLeft: 'left', a: 'left', A: 'left',
      ArrowRight: 'right', d: 'right', D: 'right',
      ArrowUp: 'up', w: 'up', W: 'up', ' ': 'up', Spacebar: 'up',
      ArrowDown: 'down', s: 'down', S: 'down',
    };
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const d = keyMap[e.key];
      if (!d && e.key !== 'Enter') return;
      e.preventDefault();
      // Any control key dismisses a shell screen (start / pause / game-over).
      if (shell.screen) { if (shell.button) shell.button.click(); return; }
      if (!started || !alive) return;
      if (d) pendingKeyDir = d;
    });
    // Keep keyboard focus on the game frame after a click, so keys keep working.
    window.addEventListener('pointerdown', () => { try { window.focus(); } catch (err) {} });
  }

  /* pause / quit buttons */
  const pauseBtn = document.createElement('div');
  pauseBtn.textContent = '⏸';
  pauseBtn.style.cssText = 'position:fixed;top:8px;right:8px;width:44px;height:44px;display:none;align-items:center;justify-content:center;font-size:22px;color:white;background:rgba(0,0,0,0.35);border-radius:22px;cursor:pointer;z-index:50;user-select:none;-webkit-tap-highlight-color:transparent';
  document.body.appendChild(pauseBtn);
  pauseBtn.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); e.preventDefault();
    if (started && alive && !shell.screen) {
      shell.show('pause'); pauseBtn.style.display = 'none'; quitBtn.style.display = 'block';
    }
  });

  const quitBtn = document.createElement('div');
  quitBtn.textContent = '🏠 QUIT';
  quitBtn.style.cssText = 'position:fixed;top:55%;left:50%;transform:translate(-50%,-50%);padding:12px 32px;background:rgba(255,255,255,0.15);color:#E8E0D0;font:bold 16px sans-serif;border-radius:12px;cursor:pointer;z-index:200;display:none;user-select:none;-webkit-tap-highlight-color:transparent';
  document.body.appendChild(quitBtn);
  quitBtn.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); e.preventDefault();
    quitBtn.style.display = 'none'; pauseBtn.style.display = 'none';
    alive = false; overSent = true;
    bridge.notify('GAME_OVER', { score: Math.round(score), coins: coinCnt, distance: Math.round(dist) });
    shell.show('over', { hint: '⭐ ' + Math.round(score) + '  💰 ' + coinCnt + '  🏃 ' + Math.round(dist) + 'm' });
  });

  /* ── loop ── */
  const loop = createLoop({
    mode: 'continuous',
    step(dt) {
      shell.update(dt);
      if (shell.screen) return;
      if (!started) return;

      /* death */
      if (!alive) {
        tumbleT -= dt;
        duck.rotation.x += dt * 5;
        if (tumbleT > 1.2) camera.position.x += (Math.random() - 0.5) * 0.4;
        if (tumbleT <= 0 && !overSent) {
          overSent = true; sfx('over');
          bridge.notify('GAME_OVER', { score: Math.round(score), coins: coinCnt, distance: Math.round(dist) });
          shell.show('over', { hint: '⭐ ' + Math.round(score) + '  💰 ' + coinCnt + '  🏃 ' + Math.round(dist) + 'm' });
        }
        return;
      }

      elapsed += dt;
      spd = Math.min(SPD_MAX, SPD0 + Math.floor(elapsed / 10) * 0.5);
      const eff = boostOn ? spd * 1.5 : spd;
      const moved = eff * dt;
      dist += moved; score += moved * sMult; dObs += moved; dPow += moved;

      if (magnetOn) { magnetT -= dt; if (magnetT <= 0) magnetOn = false; }
      if (boostOn) { boostT -= dt; if (boostT <= 0) { boostOn = false; sMult = 1; } }

      /* input */
      const reg = input.region('track');
      const dir = reg.swipe ? reg.swipe.dir : pendingKeyDir;
      pendingKeyDir = null;
      if (dir) {
        const d = dir;
        if (d === 'left' || d === 'right') {
          lane = Math.max(0, Math.min(2, lane + laneDelta(camera, d)));
          bridge.haptic('light');
        } else if (d === 'up' && !jumping && !sliding) { jumping = true; jvy = JVEL; sfx('jump'); }
        else if (d === 'down' && !jumping && !sliding) { sliding = true; slT = SLIDE_DUR; sfx('slide'); }
      }

      /* lane */
      duck.position.x += (LANES[lane] - duck.position.x) * Math.min(1, dt * 14);

      /* jump */
      if (jumping) { jvy -= GRAV * dt; py += jvy * dt; if (py <= 0) { py = 0; jumping = false; jvy = 0; } }
      duck.position.y = py;

      /* slide */
      if (sliding) {
        slT -= dt; duck.scale.y = 0.4; duck.position.y = py = -0.1;
        if (slT <= 0) { sliding = false; duck.scale.y = 1; duck.position.y = py = 0; }
      }

      /* duck anim */
      const ws = eff * 1.5;
      const wf = jumping ? Math.sin(elapsed * 20) * 0.4 : Math.sin(elapsed * ws * 0.5) * 0.15;
      const dp = duck._p;
      dp.lw.rotation.z = wf; dp.rw.rotation.z = -wf;
      const fa = Math.sin(elapsed * ws) * 0.15;
      dp.lf.position.z = -0.05 + fa; dp.rf.position.z = -0.05 - fa;
      if (shieldBubble.visible) shieldBubble.material.opacity = 0.15 + Math.sin(elapsed * 4) * 0.1;

      /* world stream */
      for (const ch of chunks) {
        ch.startZ += eff * dt;
        for (const m of ch.meshes) if (m.position) m.position.z += eff * dt;
      }
      while (chunks.length && chunks[0].startZ > CHUNK * 2) {
        const old = chunks.shift();
        for (const m of old.meshes) { scene.remove(m); }
        contacts.removeGroup(old);
        for (const m of old.meshes) { const i = coinRefs.indexOf(m); if (i >= 0) coinRefs.splice(i, 1); }
      }
      while (chunks.length < AHEAD) {
        const ch = spawnChunk(true);
        if (dObs >= nObs) {
          const diff = Math.min(1, dist / 500);
          addObs(ch, 5 + Math.random() * 10);
          dObs = 0; nObs = 12 + (25 - 12) * (1 - diff) + Math.random() * 5;
        }
        if (dPow >= nPow) { addPow(ch, 10); dPow = 0; nPow = 40 + Math.random() * 40; }
      }

      /* coins rotate + magnet */
      for (const c of coinRefs) {
        c.rotation.y += dt * 2;
        if (magnetOn) {
          const dx = duck.position.x - c.position.x, dz = duck.position.z - c.position.z;
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d < 5 && d > 0.1) { c.position.x += dx / d * dt * 12; c.position.z += dz / d * dt * 12; }
        }
      }

      /* contacts */
      contacts.step(wasAt, duck.position, { radius: 0.5 });
      wasAt.copy(duck.position);

      /* camera */
      camera.position.x += (duck.position.x - camera.position.x) * 0.1;
      camera.position.y = 5 + py * 0.3;

      /* HUD */
      shell.set('score', Math.round(score).toLocaleString());
      shell.set('dist', Math.round(dist) + 'm');
      shell.set('coins', coinCnt);
    },
    render() { host.present(); },
  });

  attachLifecycle({ canvas, loop, host });

  /* ── reset ── */
  function doReset() {
    for (const ch of chunks) {
      for (const m of ch.meshes) scene.remove(m);
      contacts.removeGroup(ch);
    }
    chunks.length = 0; coinRefs.length = 0;
    lane = 1; spd = SPD0; dist = 0; score = 0; coinCnt = 0;
    alive = true; started = false; overSent = false; tumbleT = 0; elapsed = 0; sMult = 1;
    jumping = false; jvy = 0; py = 0; sliding = false; slT = 0;
    magnetOn = false; shieldOn = false; shieldBubble.visible = false; boostOn = false;
    dObs = 0; nObs = 22; dPow = 0; nPow = 40 + Math.random() * 40;
    duck.position.set(0, 0, 0); duck.rotation.set(0, 0, 0); duck.scale.set(1, 1, 1);
    camera.position.set(0, 5, 8); camera.lookAt(0, 1, -10);
    wasAt.copy(duck.position);
    pauseBtn.style.display = 'none'; quitBtn.style.display = 'none';
    for (let i = 0; i < AHEAD; i++) spawnChunk(i > 1);
    shell.set('score', '0'); shell.set('dist', '0m'); shell.set('coins', '0');
    shell.show('start');
  }

  /* ── diagnostics ── */
  const diag = attachDiagnostics({
    host, loop, input, actor: duck,
    getState: () => ({
      scene: 'duckRunner', view: 'onRails', lane,
      pos: duck.position.toArray().map(n => +n.toFixed(3)),
      facing: [0, 0, -1],
      distance: Math.round(dist), speed: +spd.toFixed(1),
      progress: Math.round(dist),
      score: Math.round(score), coins: coinCnt, alive, started,
      chunks: chunks.length,
      covered: chunks.some(c => c.startZ - CHUNK <= 0 && c.startZ >= 0),
      ahead: chunks.filter(c => c.startZ < 0).length,
      ...shell.report(),
      ...contacts.report(),
    }),
    reset: doReset,
  });

  loop.start();
  bridge.ready();
  return { host, loop, input, diag, bridge };
}
