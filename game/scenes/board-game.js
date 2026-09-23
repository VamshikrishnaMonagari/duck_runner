// SMOKE SCENE: 3D board game. Stresses a TWO-PHASE tap interaction (select a
// piece, then a destination) and the tween scheduler -- no physics, no per-frame
// gameplay, animation driven entirely by simTime.
import * as THREE from '../vendor/three.module.js';
import { createHost } from '../core/host.js';
import { createLoop } from '../core/loop.js';
import { createInput } from '../core/input.js';
import { attachControls } from '../core/controls.js';
import { createPicker } from '../core/pick.js';
import { attachLifecycle } from '../core/lifecycle.js';
import { attachDiagnostics } from '../core/diagnostics.js';

const N = 6, CELL = 1.6;
const cellPos = (c, r) => new THREE.Vector3((c - (N - 1) / 2) * CELL, 0, (r - (N - 1) / 2) * CELL);

export function start(canvas) {
  const host = createHost({ canvas, captureFrames: true });
  const { scene, camera } = host;
  scene.background = new THREE.Color(0x37304a);
  scene.add(new THREE.HemisphereLight(0xe8ddff, 0x5a5070, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.8); key.position.set(6, 12, 6); scene.add(key);

  const cells = [];
  const light = new THREE.MeshStandardMaterial({ color: 0xd9d2c4 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x8c7f9c });
  const cellGeo = new THREE.BoxGeometry(CELL, 0.2, CELL);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const m = new THREE.Mesh(cellGeo, (r + c) % 2 ? dark : light);
    m.position.copy(cellPos(c, r)); m.userData = { c, r }; m.name = `cell_${c}_${r}`;
    scene.add(m); cells.push(m);
  }

  const pieces = [];
  const pieceGeo = new THREE.CylinderGeometry(0.45, 0.55, 0.6, 16);
  for (let i = 0; i < 3; i++) {
    const p = new THREE.Mesh(pieceGeo, new THREE.MeshStandardMaterial({ color: [0xe0574f, 0x4fb0e0, 0xe0c34f][i] }));
    const pos = cellPos(i * 2, 0); p.position.set(pos.x, 0.45, pos.z);
    p.name = 'piece' + i; scene.add(p); pieces.push(p);
  }

  // Frame the whole board from the LIVE aspect rather than hand-picked numbers. At
  // 0, 9, 9 the board fitted a landscape window and lost its outer columns in portrait,
  // where the horizontal field of view is a third as wide.
  const half = (N * CELL) / 2;
  const fit = () => host.fitBounds({ x: -half, y: 0, z: -half }, { x: half, y: 1.2, z: half },
                                   { dir: [0, 0.9, 1], padding: 1.1 });
  fit();

  let loopRef = null;
  const input = createInput(canvas, { onActivity: () => loopRef && loopRef.invalidate() });
  input.addRegion('board', { x: 0, y: 0, w: 1, h: 1 });
  // A SHELF of choices over a full-screen board. Both halves are here to be TESTED: the board
  // region is declared FIRST and covers everything, so this exercises drawn controls outranking
  // invisible ones, and the row is laid out by attachControls rather than by hand. The incidents
  // behind both -- swallowed buttons, and a shop wider than the phone -- are in core/controls.js.
  input.addRegion('pick0', { x: 0, y: 0, w: 0.01, h: 0.01 });
  input.addRegion('pick1', { x: 0, y: 0, w: 0.01, h: 0.01 });
  input.addRegion('pick2', { x: 0, y: 0, w: 0.01, h: 0.01 });
  input.addRegion('pick3', { x: 0, y: 0, w: 0.01, h: 0.01 });
  attachControls(input, {
    shelf: [
      { region: 'pick0', label: 'PAWN',   sub: '1' },
      { region: 'pick1', label: 'KNIGHT', sub: '3' },
      { region: 'pick2', label: 'BISHOP', sub: '3' },
      { region: 'pick3', label: 'ROOK',   sub: '5' },
    ],
  });
  let picked = 0;
  const picker = createPicker({ canvas, camera });

  let selected = null, moves = 0;
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  const loop = loopRef = createLoop({
    mode: 'onDemand',
    render() {
      for (let i = 0; i < 4; i++) {
        const r = input.region('pick' + i);
        if (r && r.tap) { picked = i; moves++; }
      }
      const reg = input.region('board');
      if (reg.tap) {
        if (!selected) {
          const { hits } = picker.pick(reg.tap.x, reg.tap.y, pieces);
          if (hits.length) { selected = hits[0].object; loop.schedule(selected.position, { y: 1.1 }, 160, easeOut); }
        } else {
          const { hits } = picker.pick(reg.tap.x, reg.tap.y, cells);
          if (hits.length) {
            const { c, r } = hits[0].object.userData;
            const dest = cellPos(c, r);
            loop.schedule(selected.position, { x: dest.x, z: dest.z, y: 0.45 }, 380, easeOut);
            selected = null; moves++;
          }
        }
      }
      host.present(); diag.onFrame(); input.endFrame();
    },
  });

  attachLifecycle({ canvas, loop, host, onResize: fit });
  const diag = attachDiagnostics({ host, loop, input,
    getState: () => ({ scene: 'board-game', view: 'placement', selected: selected && selected.name, moves, picked,
                       piece0: pieces[0].position.toArray().map(n => +n.toFixed(2)),
                       // screen positions so a check (or a DOM label) can aim precisely
                       screen: { piece0: picker.project(pieces[0].position),
                                 cell: picker.project(cellPos(4, 4)) },
                       // The board's own corners in screen space, so a check can assert
                       // the WHOLE playfield fits -- the failure that put a puzzle's ball
                       // off the left edge of a portrait phone.
                       corners: [[-half, 0, -half], [half, 0, -half],
                                 [-half, 0, half], [half, 0, half]]
                         .map(([x, y, z]) => picker.project({ x, y, z })) }) });
  loop.start();
  return { host, loop, input, diag };
}
