import * as THREE from '../vendor/three.module.js';

/**
 * Creates the renderer/scene/camera and owns presentation. Knows nothing about
 * any kind of game. Colour management is applied HERE and nowhere else: if a
 * scene adds its own composite pass it must pass `manageColour: false`.
 */
export function createHost({ canvas, onError, manageColour = true, antialias = true, captureFrames = false, lights = true } = {}) {
  const errors = [];
  const report = (e) => {
    const msg = e && e.stack ? e.stack : String(e);
    errors.push(msg);
    try { onError && onError(msg); } catch (_) {}
  };

  // Never fail silently: a blank screen with no message is the most expensive
  // failure mode there is, so surface everything the page throws.
  addEventListener('error', (ev) => report(ev.error || ev.message));
  addEventListener('unhandledrejection', (ev) => report(ev.reason));

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias, alpha: false, preserveDrawingBuffer: captureFrames });
  } catch (e) { report(e); throw e; }

  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  renderer.setPixelRatio(dpr);
  // Shadows enabled HERE, in the engine, because forgetting one renderer flag makes every
  // castShadow and receiveShadow in a scene silently do nothing -- and "everything looks
  // like it is floating" was a real device report. Costs nothing until a light actually
  // casts: with no caster, three.js runs no shadow pass at all. A scene opts in per object.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  if (manageColour) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);

  // Lit HERE, for the same reason shadows are enabled here: a three.js scene starts pitch black,
  // so every generated game invented its own rig from zero and two shipped too dark to navigate
  // ("way too dark", "low light + dense fog makes walls invisible"). Brightness was only ever an
  // eyeball item on the screenshot checklist, never a default. A sun that CASTS is half of it --
  // shadowMap above does nothing without a caster, which is what made objects read as floating.
  // A scene that wants full control passes `lights: false` and adds its own.
  let sun = null;
  let fill = null;
  let lamp = null;
  if (lights === 'interior') {
    // INTERIOR PRESET. The rig below is an OUTDOOR one: a sky-tinted hemisphere plus a sun that
    // casts. Put a ceiling over it and the sun is blocked, so a generated first-person maze had to
    // invent lighting from nothing -- and invented a torch that lit the walls beside the player and
    // left the corridor ahead pure black, which makes finding an exit impossible.
    //
    // A SPOTLIGHT WITH decay: 0, NOT A POINT LIGHT. This is the second version of this preset. The
    // first used PointLight(110, 45, decay 1.1), whose brightness is intensity / distance^decay --
    // so how bright it looks depends on how far away the walls are, which is the scene's SCALE, and
    // the engine cannot know that. Measured after shipping it:
    //
    //     wall at 1.5 m (the corridor I calibrated on)    70   fine
    //     wall at 1.0 m (a 2-unit maze cell)             110   white after tone mapping
    //     wall at 0.5 m                                  236   white
    //
    // A first-person camera in a 2-unit maze has walls at 1 m and floor and ceiling inside 1.1 m:
    // three surfaces brighter than anything I had tested, all tone-mapped to the same near-white,
    // which then failed this engine's OWN legibility check as "bright but FLAT". One generated maze
    // spent roughly a quarter of its scene rewrites discovering that before abandoning the preset
    // for `lights: false` and hand-rolling the rig below -- and an earlier one silently overrode
    // the fog for the same reason. No single intensity is correct: it is wrong at some cell size by
    // construction.
    //
    // decay: 0 removes the distance term entirely, so it cannot blow out close up or vanish far
    // away. The cone supplies the variation a point light was providing by falloff, and fog
    // supplies the depth. Two independent builds converged on exactly this shape.
    fill = new THREE.HemisphereLight(0x445566, 0x111118, 0.28);
    scene.add(fill);
    // Intensity measured at BOTH cell sizes this time, which is the whole point of decay: 0 --
    // the two geometries now track within ~5 grey levels instead of differing by 3.3x:
    //            CELL 3 (walls 1.5 m)      CELL 2 (walls 1.0 m)     legible needs >=14 buckets
    //   i=2       37 near / 8 buckets       34 near / 8 buckets      too dark, fails
    //   i=8      105 near / 12 buckets     100 near / 14 buckets     marginal
    //   i=20     168 near / 16 buckets     163 near / 17 buckets     <- chosen
    //   i=40     206 near / 17 buckets     203 near / 18 buckets     bright, near blow-out
    lamp = new THREE.SpotLight(0xffecd0, 20, 0, Math.PI * 0.28, 0.8, 0);
    lamp.position.set(0, 0, 0);
    lamp.target.position.set(0, 0, -1);
    camera.add(lamp);
    camera.add(lamp.target);
    // Children of the camera only render while the camera is itself in the scene graph. Miss this
    // and the lamp contributes nothing, and the failure looks identical to having no lamp at all.
    scene.add(camera);
    // Fog COLOUR is the ceiling on how far you can see: distance asymptotes to it, so a near-black
    // fog makes distance mean darkness however strong the light is. Measured down a corridor:
    // 0.035 @ 0x0b0d12 left the far end at 29/255; 0.02 @ 0x2a3038 reaches 49.
    scene.fog = new THREE.FogExp2(0x2a3038, 0.02);
  } else if (lights) {
    fill = new THREE.HemisphereLight(0xbcd2e8, 0x2b2b33, 0.75);
    scene.add(fill);
    sun = new THREE.DirectionalLight(0xfff3e0, 2.4);
    sun.position.set(28, 46, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const d = 60;
    sun.shadow.camera.left = -d; sun.shadow.camera.right = d;
    sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 200;
    sun.shadow.bias = -0.0005;
    scene.add(sun);
  }

  const disposables = new Set();
  const track = (obj) => { disposables.add(obj); return obj; };

  function resize(w, h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }
  resize(canvas.clientWidth || canvas.width || 1, canvas.clientHeight || canvas.height || 1);

  /** Place the camera so an axis-aligned box fits the screen AT THE CURRENT ASPECT.
   *
   *  Exists because a camera positioned by hand-picked numbers frames correctly on the
   *  screen shape it was written for and wrongly on every other one. A generated physics
   *  puzzle put its ball at x=-7 with a camera framed for widescreen; on a portrait phone
   *  the horizontal field of view is 34 degrees instead of 94, so the visible range was
   *  -3.8 to 4.8 and the ball -- the object the player throws -- was off screen. The
   *  physics, the aim and the trajectory were all correct and the game was unplayable.
   *
   *  Vertical FOV is fixed, so horizontal FOV shrinks as the screen narrows: whatever
   *  fits in landscape does NOT fit in portrait. Deriving the distance from the bounds
   *  and the live aspect is the only way both hold. Call it again on resize.
   *
   *  min/max are THREE.Vector3 (or {x,y,z}); dir is the direction FROM the box TO the
   *  camera; padding leaves a margin so nothing sits flush against an edge.
   */
  function fitBounds(min, max, { dir = [0, 0.55, 1], padding = 1.08 } = {}) {
    const c = new THREE.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    const corners = [];
    for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
      corners.push(new THREE.Vector3(x, y, z));
    }
    const v = new THREE.Vector3(dir[0], dir[1], dir[2]);
    if (v.lengthSq() === 0) v.set(0, 0.55, 1);
    v.normalize();

    /** Does the whole box fit on screen from this distance? Corners behind the camera are
     *  never "fitting": a perspective divide by a negative w flips them back inside the
     *  frame, which is how a box could look framed while sitting behind the viewer. */
    const fits = (d) => {
      camera.position.copy(c).addScaledVector(v, d);
      camera.lookAt(c);
      camera.updateMatrixWorld(true);
      camera.updateProjectionMatrix();
      const lim = 1 / padding;
      for (const p of corners) {
        const n = p.clone().project(camera);
        if (n.z > 1 || Math.abs(n.x) > lim || Math.abs(n.y) > lim) return false;
      }
      return true;
    };

    // Binary search, not a growth loop. Growing by the measured overflow overshot badly:
    // one step multiplied the distance by whatever the worst corner reported -- inflated
    // when a corner sat behind the camera -- and then stopped as soon as everything fitted,
    // never coming back. For an 8.5 x 4 x 3 box on a portrait phone it returned 50 where 15
    // frames it, and a generated puzzle rendered its crates at a tenth of their proper size.
    const radius = Math.sqrt((max.x - min.x) ** 2 + (max.y - min.y) ** 2 + (max.z - min.z) ** 2) / 2;
    let hi = Math.max(0.5, radius);
    for (let i = 0; i < 24 && !fits(hi); i++) hi *= 1.5;
    let lo = 0;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid; else lo = mid;
    }
    fits(hi);
    return hi;
  }

  // Presenting and rendering are two different things, and a scene with its own
  // render chain (a composer, a shadow prepass, a split-screen) needs the second
  // without the first. Calling present() after a composer would render the scene
  // twice and throw the post-processed frame away.
  function endFrame() {
    const gl = renderer.getContext();
    if (gl && gl.endFrameEXP) gl.endFrameEXP();
  }

  function present(sceneOverride, cameraOverride) {
    renderer.render(sceneOverride || scene, cameraOverride || camera);
    // expo-gl requires an explicit present; harmless in a browser.
    const gl = renderer.getContext();
    if (gl && typeof gl.endFrameEXP === 'function') gl.endFrameEXP();
  }

  function dispose() {
    for (const d of disposables) { try { d.dispose && d.dispose(); } catch (_) {} }
    disposables.clear();
    scene.traverse((o) => {
      if (o.geometry) { try { o.geometry.dispose(); } catch (_) {} }
      const m = o.material;
      if (m) { for (const mm of (Array.isArray(m) ? m : [m])) { try { mm.dispose(); } catch (_) {} } }
    });
    try { renderer.dispose(); } catch (_) {}
  }

  function captureFrame() { try { return canvas.toDataURL('image/png'); } catch (e) { report(e); return null; } }

  return { renderer, scene, camera, sun, fill, lamp, resize, fitBounds, present, endFrame, dispose, track, errors, report, captureFrame,
           get pixelRatio() { return dpr; } };
}
