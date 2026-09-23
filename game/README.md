# 3D game engine — how to use this

The game is a **self-contained web bundle running in a WebView**. Everything the player
sees or touches DURING PLAY is drawn inside this bundle -- the HUD (score, lives, coin
count), every on-screen control, pause and win overlays. React Native owns only what is
outside play: navigation between screens, persistence, haptics, and the WebView host.

That boundary is the VERIFICATION boundary, which is why it matters more than it looks:
`check.py` loads this bundle alone in a headless browser, so anything drawn on the React
Native side cannot be checked by anything. A generated island game kept its joystick in
the bundle and moved its score badge to a React Native overlay fed by postMessage -- the
game counted coins correctly, every check passed, and the number on the player's screen
never left zero.

Do not swap this for `expo-gl`: the WebView path is device-verified at 91 FPS and, when it
breaks, it reports real errors instead of a black screen. A generated island game was told
by its own design spec to use `expo-gl` + `expo-three`, wrote the whole game into
`app/index.tsx`, never touched `game/scenes/main.js`, and never ran a single check.

## Layout

    game/core/       engine modules -- DO NOT rewrite these, they are pre-debugged
    game/scenes/main.js   YOUR GAME -- and it is ALREADY A COMPLETE, WORKING ONE when you
                          arrive: whichever skeleton matched the brief was copied here at
                          install time. It boots, renders in 3D, has drawn controls bound to
                          their touch regions, a start screen, a win screen, and it passes
                          check.py as installed. CHANGE it into the game you were asked for.
                          Do not rewrite it from nothing -- every defect found across fifteen
                          generated builds lived in freshly written code, none in the engine.
    game/skeletons/*.js   the five shapes. Wrong one? `python3 game/use_skeleton.py <view>`.
    game/scenes/*.js      MORE FILES ARE FINE. Import them from main.js -- the bundler
                          follows imports and inlines them. A separate module for terrain,
                          props, audio or level data is supported and often clearer.
    game/vendor/     three.js r185, already here -- see below
    game/bundle.py   builds assets/game/gameHtml.ts from your scene
    src/host/GameHost.tsx  the React Native WebView host
    assets/game/gameHtml.ts  GENERATED -- never edit by hand

### Dependencies

`react-native-webview` may not be present -- it is missing from some baseline
installs. If an import of it fails, `npx expo install react-native-webview` is the
fix. `@react-native-async-storage/async-storage` and `expo-haptics` are normally
already there.

### three.js and cannon-es are already vendored — do not install them

`game/vendor/` holds three.js r185, its post-processing addons and cannon-es.
Every scene and core module imports three as
`import * as THREE from '../vendor/three.module.js';`. Use exactly that import.

* Do **not** `npm install three`. It is not a project dependency; adding it makes
  Metro bundle a copy the game never uses.
* But you **may** add any OTHER library the engine does not vendor — chess rules,
  pathfinding, noise, a state machine. `yarn add chess.js`, then import it by name in
  your scene: `import { Chess } from 'chess.js'`. `bundle.py` resolves it from
  `node_modules` and inlines it, so the bundle stays one self-contained file and
  nothing is fetched at runtime. A CDN `<script src>` is still forbidden and
  `bundle.py` refuses any bundle referencing an external URL. This is spelled out
  because its absence cost a build: a 3D chess game read "do not npm install, never a
  CDN", concluded no library was possible, and hand-wrote 33 KB of HTML pulling
  three.js r128 *and* chess.js off cdnjs — abandoning the engine for want of one line.
* Do **not** change the version or edit anything in `vendor/`. The engine and its
  checks are verified against r185 specifically. A previous build downgraded to
  `three@0.165` while the spec asked for r185, and lost a turn to it.
* `vendor/` ships **two** files that import each other (`three.module.js` and
  `three.core.js`). Both are required; deleting either breaks the bundle.
* If an import of three fails to resolve, the fix is the path, never the version.


## API reference — every member each module returns

This section exists because a racing build spent **15 minutes 48 seconds** in one reasoning
block hunting for a way to dismiss a shell screen, tried `shell.show(null)`, then scanned the
DOM for the overlay by its z-index, then considered synthesising pointer events at the button's
coordinates -- and settled on the DOM hack. `shell.hide()` was there the whole time, exported
on line 246. Its own note: *"I only read the first 80 lines of shell.js."*

The rest of this document explains what to do and why, with the measured failure behind each
rule. That is not the same as saying what exists. An API you cannot find is an API that gets
hand-rolled around, and reading the source in fragments is how a build burns an hour.

### createHost({canvas, onError, manageColour, antialias, captureFrames, lights})

| member | what it is |
|---|---|
| `renderer` `scene` `camera` | the three.js objects. `camera` is a PerspectiveCamera(60, …, 0.1, 2000) |
| `sun` `fill` `lamp` | the lights the rig created; `lamp` only under `lights: 'interior'` |
| `resize(w, h)` | re-fit the camera to a new canvas size. Call on orientation change |
| `fitBounds(min, max, {dir, padding})` | place the camera so an axis-aligned box fills the screen AT THE LIVE ASPECT |
| `present(scene?, camera?)` | render one frame. Call from `render()`, once |
| `endFrame()` | present WITHOUT rendering -- for a scene driving its own composer. NOT the same call as `input.endFrame()`, which clears gestures; these two share a name |
| `track(obj)` | register something for disposal; returns it, so wrap inline |
| `dispose()` | tear the whole rig down |
| `errors` `report(e)` `captureFrame()` | error list, manual report, PNG data URL |
| `pixelRatio` | the DPR actually in use (capped) |

### createLoop({mode, step, render})

| member | what it is |
|---|---|
| `start()` `stop()` | begin / end the rAF loop |
| `pause()` `resume()` | same, for an app-state change |
| `invalidate()` | in `mode: 'demand'`, mark that one more frame is needed |
| `schedule(target, props, ms, ease)` | tween on simTime, so it survives a pause |
| `simTime` `frame` `running` | read-only clock, frame count, state |
| `onFrame(fn)` | run `fn` after every rendered frame; returns an unsubscribe. Registering the same function twice is a no-op. `attachDiagnostics` subscribes itself here, which is why `diag.onFrame()` and `input.endFrame()` are no longer yours to remember |

### createInput(canvas, {onActivity})

| member | what it is |
|---|---|
| `addRegion(name, {x, y, w, h})` | declare an invisible hit area in 0..1 canvas space |
| `bindRegionToElement(name, node, {pad, managed})` | make a region BE an element: read live, so hidden means untouchable. `managed: true` is for engine-drawn controls only |
| `region(name)` | `{pressed, released, held, vec, tap, swipe, bounds}` |
| `sample(name, {radius, deadzone})` | normalised `{x, y}`, y UP-positive |
| `pinch()` | two-finger scale delta |
| `names()` | every declared region name |
| `endFrame()` `dispose()` | clear one-shot gestures; detach. **The loop already calls `endFrame()` after every frame**, so you do not need to -- and a scene that forgets it is no longer broken. Calling it yourself as well is harmless |

**The three below are the QA seam. A scene must never call them.** They exist so `check.py` can
drive the game; a game that calls them drives itself, which is the exact defect
`the game does not advance on its own` catches — a racing build travelled 6.23 m over 4 s with
nothing pressed, and every control check above it was then measured against a car that moved
regardless.

| harness only | what it is |
|---|---|
| `inject(name, {x, y, down, atPx})` | fakes a touch. Hit-tests only when `atPx` is given |
| `prioritise(name)` | marks a region drawn so it outranks invisible ones. `bindRegionToElement` already does this |
| `boundVisibility()` | per region: can a finger reach the element it is bound to right now |

### createShell(input, {fields, screens, onAction, actionRegion})

| member | what it is |
|---|---|
| `set(name, value)` | update a HUD field |
| `get(name)` | read one back |
| `show(name, over?)` | show a screen; `over` overrides `{title, hint, action}` for this call |
| **`hide()`** | **dismiss the current screen.** This is how a screen ends without a tap |
| `update()` | **the engine calls this for you** every frame: it reads the action region so the start button fires, and repairs an overlay hidden from outside. Calling it yourself is harmless |
| `report()` | merge into `getState()` -- HUD numbers and reported progress become the same numbers |
| `screen` | the current screen name, or null |
| `hud` `overlay` `button` | the elements, for restyling. Do NOT set `display` or overwrite `cssText` -- use `hide()` |
| `dispose()` | remove it all |

### attachControls(input, {stick, buttons, shelf, shelfBottom, opacity})

| member | what it is |
|---|---|
| `update()` | **the engine calls this for you** on every frame -- the knob follows the thumb and a held button lights up without the scene doing anything. Before it was automatic, no scene in this suite called it, so neither happened in any game. Calling it yourself is harmless |
| `syncRegions()` | re-point drawn controls at their hit areas. Call on resize |

**ONE JOB PER CONTROL.** A button must do something the stick cannot. `jumper.js` is stick + JUMP;
`explorer.js` is stick + BOOST + BRAKE; `circuit.js` is stick + BRAKE. Left/right arrows next to a
stick that already steers are not a second option, they are the same option drawn twice -- five
generated racing games shipped four redundant buttons that way, and the verdict on the last one was
"only joystick is enough, those 4 buttons are working but not necessary". Note the consequence for
`getState()`: a control whose entire effect is speed must PUBLISH speed, or `control 'X' does
something` fails and the next edit makes the button do something it should not.
| `layer` | the container element |
| `dispose()` | remove the controls |

### collide.js

| factory | returns |
|---|---|
| `createSolids({passes})` | `addDisc(x,z,r)` `addBox(x,z,w,d)` `blocked(x,z,r)` `resolve(pos, r, from)` `discs` `boxes` `resolves` |
| `createGround(heightAt, {radius, waterLevel})` | `at(x,z)` `place(obj, eye)` `confine(pos)` `usable(x,z)` |
| `createJump({gravity, jumpSpeed})` | `step(y, vy, groundY, dt, wantJump)` `gravity` `jumpSpeed` `apex` -- place platforms inside `apex`, do not guess |
| `createBodies({push})` | `add(obj, {radius, mass, still})` `remove(obj)` `separate()` `report()` `overlapping()` — actors that must not occupy the same space |
| `createUnstick({after, nudge, moved, input, regions})` | `step(pos, commandDir, dt)`. Pass `input` and your drive regions or the guard is defeatable |
| `createRest(...)` | settle detection for `atRest` in `getState()` |

### createContacts()

| member | what it is |
|---|---|
| `pickup(obj, {radius, onTake, group})` | a thing that disappears when touched |
| `hazard(obj, {radius, onHit, group})` | a thing that hurts when touched, and stays |
| `step(from, to, {radius})` | **EVERY FRAME**, after everything moved, with where the actor was |
| `remove(obj)` `removeGroup(group)` | stop tracking; use `group` for recycled chunks |
| `report()` | `pickupsLeft` `hazards` `collected` `hitsTaken` `contactSteps` -- merge into `getState()` |
| `reset()` `count` `steps` | clear latches; registry size; how many times it was fed |

### motion.js — what each helper RETURNS

| call | returns |
|---|---|
| `walkDirection(input, {move, look}, camera)` | a vector carrying direction AND magnitude |
| `tankDrive(input, region, yaw, {dt, turnRate, turnAtRest, camera})` | `{yaw, throttle, turn, velocity}` |
| `steer(input, {left, right}, yaw, {dt, rate, camera, scale})` | `{yaw, turning}` |
| `laneDelta(camera, dir, axis)` | which way is screen-right, for lane games |
| `faceYaw(obj, yaw)` | points a mesh (+Z) or a camera (-Z) correctly. Returns the object |
| `followCam(camera, target, yaw, {back, height, lookHeight, lookAhead, lerp, dt, minY})` | the camera. `back` is a POSITIVE distance; a non-positive one throws |

### createPicker / createBridge / attachLifecycle

| member | what it is |
|---|---|
| `pick(x, y, objects)` | what is under a screen point |
| `groundAt(x, y, plane)` | where a screen point meets a plane |
| `project(vec3)` | world -> screen px, or `null` when off screen. Publish objectives with this |
| `ready()` `save(state)` `haptic(kind)` `error(e)` | the four named bridge messages |
| `notify(type, payload)` | anything else. GameHost forwards unknown types to `onMessage` |
| `isHosted` | true inside the app. Do NOT branch the START of the game on it |
| `attachLifecycle({canvas, loop, host})` | pause on blur, resize on rotate. Returns `{dispose}` |


## Workflow

1. CHANGE the working game already in `game/scenes/main.js`, splitting into further modules under
   `game/scenes/` whenever that is clearer -- imports are followed and inlined.
2. Build the bundle -- ONE command, which writes the `.ts` the app imports:

       cd game && python3 bundle.py --scene main --ts ../assets/game/gameHtml.ts

   `--ts` emits `export const GAME_HTML = ...` for you. Do not build a `.html` and
   inline it by hand; that was the old two-step and it is not needed.
3. `app/index.tsx` renders `<GameHost html={GAME_HTML} />`.
4. Rebuild after **every** change to `game/` -- the app loads the generated string,
   not your source files. `check.py` fails with *the bundle is newer than the game
   source* when you forget, so run the command above, then check.

## What the core gives you

    createHost      renderer, colour management, error capture, frame capture, dispose
    createLoop      fixed-step ('continuous') or render-on-demand ('onDemand'), tweens
    createInput     named touch regions, multi-pointer, deadzone
    createPicker    pick (screen -> world), groundAt, project (world -> screen)
    attachLifecycle background/foreground, resize, GL context loss
    attachDiagnostics  window.__GAME__ for automated checks
    createBridge    save/restore, haptics, READY -- no-ops outside a WebView

## The control scheme your genre needs — and what the engine gives you

Look this up BEFORE writing input code. Everything here already exists; hand-rolling a
`canvas.addEventListener` instead is how a lane runner ended up with two input paths that both
fired on one swipe, moving the player two lanes.

| what the player does | how to read it | genres |
|---|---|---|
| walk with a joystick, camera-relative | `walkDirection(input, {move, look}, camera)` -> world direction, already signed and scaled | explorer, first-person, twin-stick |
| drive with one joystick (x turns, y drives) | `tankDrive(input, region, yaw, {dt, turnRate})` -> `{yaw, velocity}` | chase-camera avatar, boats, tanks, turrets |
| put the camera behind the actor | `followCam(camera, target, yaw, {back, height, lerp, dt})` | racing, third-person vehicles, platformers |
| send a message INTO the game from React Native | `<GameHost ref={host} …/>` then `host.current?.send('START_WAVE')` | difficulty from a menu, resume after a system pause |
| collect a thing / die on a thing | `createContacts()` -> `contacts.pickup(obj, {radius, onTake})`, `contacts.hazard(obj, {radius, onHit})`, `contacts.step(wasAt, pos)` | coins, gems, checkpoints, trains, spikes, walls |
| raw stick axes, if you need them | `input.sample(name, {radius, deadzone})` -> `{x, y}`, y UP-positive | anything custom |
| drag to look / orbit | a second region, same `sample()` | first-person, third-person, viewer |
| flick left/right/up/down | `reg.swipe.dir` -- `'left' \| 'right' \| 'up' \| 'down'` | endless runner, lane games |
| aim and release (slingshot) | `reg.swipe.x / .y / .dist` -- direction and strength at release | physics puzzle, archery |
| drag and drop | `reg.swipe.from` and `reg.swipe.at` -- press and release points in CSS px | board games, tower defence |
| tap to place / select | `reg.tap` -> `{x, y}` in CSS px, then `picker.pick()` | tower defence, board, builder |
| on-screen buttons | `attachControls(input, {buttons})` + `reg.held` -- it DRAWS them and owns their hit areas | racing, shooter, platformer |
| turn from two buttons | `steer(input, {left, right}, yaw, {dt, rate, camera})` -> `{yaw, turning}` -- sign comes from the camera | racing, boats, tanks |
| a ROW of choices that must fit | `attachControls(input, {shelf: [{region, label, sub}]})` -- cells share the width and shrink | tower shop, weapon picker, build menu |
| pinch to zoom | `input.pinch(name)` -> `{dist}` | tower defence, viewer, map |

**Use `core/motion.js` for movement -- do not hand-roll the trigonometry.** Every remaining
control defect came from a scene doing it itself: a minus sign on the forward axis made a maze
walk backwards when dragged back; deriving a heading from a camera-relative direction while the
camera followed that heading made an avatar spin in place instead of reversing. `steer()` exists for the same reason: a racing build routed its joystick through `tankDrive` and
hand-rolled `yaw += RATE * dt` for its buttons, so the path the checker drove was correct and the
path the player touched was mirrored -- twelve runs, 62 minutes, never converged. ONE action gets
ONE control path. `walkDirection`
and `tankDrive` return a vector that already carries direction AND magnitude, so a scene writes
`pos.addScaledVector(v, SPEED * dt)` and there is no sign to get wrong. `walkDirection` also
REFUSES quietly to be misused: it reports an error if no look region owns the camera's yaw,
because camera-relative movement without one is the loop described above.

`tap` and `swipe` are ONE-SHOT: reading consumes them, so exactly one step sees each gesture
however the frame lines up. Do not latch them yourself.

**Tilt / accelerometer is NOT supported and cannot be verified.** There is no
`devicemotion` in the engine, and a headless browser has no accelerometer, so `check.py` cannot
drive a tilt-steered game at all -- it will look like a game whose controls do nothing. Use
touch steering (a drag region, or left/right buttons). A racing brief defaulted to
"accelerometer/tilt steering" in its own design step; that is the one to override.

## The shell and collision — use these, do not hand-roll them

`core/shell.js` owns the score readout, the start / win / game-over screens and the restart.
Every genre needs them and hand-writing them produced three shipped defects: a score drawn in
React Native that stayed at 0 while the game counted correctly, a full-screen overlay with no
`pointer-events: none` that swallowed every touch so the game never started, and a win condition
compared against a hard-coded total when placement had produced fewer pickups.

    const shell = createShell(input, {
      fields: { coins: { label: '\u{1FA99}', total: () => coins.length } },   // total is a FUNCTION
      screens: { start: { title: 'ISLAND', action: 'PLAY' },
                 win:   { title: 'All collected', action: 'PLAY AGAIN' } },
      onAction: () => reset(),
    });
    shell.set('coins', collected);         // updates the HUD
    ...shell.report()                      // merge into getState(): same numbers, cannot diverge

Overlays are inert by default and the action button is registered as an INPUT REGION, so the
harness presses the same pixels a thumb does and a start screen that cannot be dismissed fails
a check instead of shipping. `report()` also publishes `phase`, so a checker can tell a game
paused behind a screen apart from one that is wedged.

`core/collide.js` owns solids, the ground and recovery:

    const solids  = createSolids();                  solids.addDisc(x, z, r)   // a tree
    const land    = createGround(heightAt, { radius: 40, waterLevel: -0.4 });
    const unstick = createUnstick();

    pos.copy(unstick.step(pos, velocity, dt));        // our own never-stuck rule, in the engine
    pos.copy(solids.resolve(pos, 0.6, previousPos));  // slides along colliders, does not stop
    pos.copy(land.place(pos, eyeHeight, previousPos));// world edge + waterline + sit on surface

**In a first-person game the CAMERA is the position you pass.** There is no separate actor to
move, and that is the case where this API gets skipped: of the builds on record, every one with a
distinct actor object called `createUnstick` (7 of 7), while only about half of the camera-driven
ones did -- four hand-rolled their own nudge instead, and one spent five check cycles tuning it.
It is the same three lines:

    camera.position.copy(unstick.step(camera.position, wishDir, dt));

`wishDir` is the direction the player is ASKING to go -- the vector you got from `walkDirection()`,
not the movement you actually achieved. That distinction is the whole point: `unstick` nudges only
while the player is commanding, so it cannot drive the game on its own. A hand-rolled version
without that guard shipped a car that completed laps with nobody touching the controls.

Pass the PREVIOUS position to both: without it the push-out is radial and cancels motion
whenever the stick points into an obstacle, which measured a 4-second stall. `solids.blocked(x, z, r)`
is how you place pickups and spawn points that are actually reachable, and `createJump().apex`
tells you how high the jump you configured can actually reach -- a generated parkour level put
its first platform 6.1 m above a 2.88 m jump and could not be played.

**Water is a boundary, not decoration.** Give `createGround` a `waterLevel` or the player walks
onto the sea; it slides along the shoreline rather than refusing the step, because refusing it
freezes the player, which was reported from a device as being unable to move there.

## What is NOT in the engine, and why

There is no helper for swimming, climbing, doors, ladders, inventories, dialogue or weapons,
and there should not be. A mechanic belongs in `core/` only when all three of these hold:

1. it has caused a defect in a **real build** — evidence, not anticipation
2. **more than one genre** needs it
3. the failure is a **convention or ownership** trap, not game design

`motion` (which axis is forward, which way is screen-right), `collide` (solids, ground, water,
recovery), `pick` (hit-testing and projection) and `shell` (score, start/win screens) all pass
comfortably. `createJump` passes narrowly — two of six generated builds implemented jumping, in
two different genres.

Everything else you change in `scenes/main.js` -- which starts as a game that already runs -- and **you verify it yourself** — drive
it with `applyInput`, read `getState`, assert what should have changed. The checks cover the
failures that have happened before; nothing can cover the mechanic you invented today. A
generated explorer's JUMP button lifted the player 0.15 m and passed 26 of 26 checks, because
every property the harness knew to test was satisfied.

## Rules that exist because breaking them cost real turns

- **Read both axes of a joystick.** Reading only `clientX` makes forward/back
  impossible. `createInput.sample()` already does this; do not hand-roll it.
- **Invert screen Y exactly once.** `sample()` returns y UP-positive. Negating it
  again gives "drag down moves forward".
- **Reset input on `pointerup` AND `pointercancel`** -- `sample()` does. A stuck
  vector is why a vehicle keeps driving with no finger on the screen.
- **Derive direction from the camera** — `camera.getWorldDirection()` plus `crossVectors`,
  never hand-rolled yaw trigonometry — **but only when the camera's yaw is an independent
  input.** Camera-relative movement plus a chase camera is a closed loop:

      moveDir = camDir * y + camRight * x     // movement follows the camera
      heading = atan2(moveDir.x, moveDir.z)   // the avatar faces its movement
      camera  = player - (sin,cos)(heading)*d // the camera follows the avatar
                                              // ...and camDir comes from the camera

  Nothing damps that. Pull back and the heading flips 180°, the camera whips round, and next
  frame the stick means the opposite — so the avatar spins in place instead of reversing.
  That shipped: on a device it read as "if i drag down, it just rotates". Every line of it
  followed this rule as it used to be written, and the forward-direction check passed
  perfectly. Pick one and do not mix them:

  * **camera-relative movement** — then a `look` region owns the camera's yaw, and the
    camera's yaw is never computed from the movement.
  * **a chase camera that follows the avatar** — then use tank controls: `x` turns,
    `y` drives. This is also the right choice for a car (steering + throttle) and the only
    one that works with a single joystick and no look control.

  `check.py` fails a scene that accumulates more than 270° of turn while the stick is held
  straight back, because prose alone did not prevent this.
- **A module you create and never feed does nothing, and `check.py` now says so.**
  `createSolids()` and `createContacts()` both need calling EVERY FRAME, after the actor has
  moved, with where it was: `solids.resolve(prev, pos, r)` and `contacts.step(wasAt, pos)`.
  Measured: a racing build called `createSolids()`, registered every building and every rival
  car, never called `resolve()` once, and passed 32 of 32 checks while the player drove through
  all of it. The modules count their own feeds, so "registered N shapes, resolved 0 times" is now
  a failure rather than a silence.
- **Pass `input` and your drive regions to `createUnstick`** --
  `createUnstick({ input, regions: ['gas', 'stick'] })`. It then reads whether a finger is
  actually on a control instead of trusting the direction you hand it. Two racing builds computed
  a forward vector every frame whether or not anything was pressed, so the nudge fired while the
  car sat still, and each spent two rounds on the same loop: add unstick, fail "the actor holds
  still when nothing is pressed", then gate the call by hand.
- **Actors that must not overlap come from `createBodies()`. `createSolids` is for the world;
  this is for the things that move.**

      const bodies = createBodies();
      bodies.add(car, { radius: 1.4 });
      for (const ai of rivals) bodies.add(ai.group, { radius: 1.4 });
      // ...once per frame, after every actor has moved:
      bodies.separate();
      // ...and in getState(): { ...bodies.report() }

  Two cars are not resolved like a wall: a wall pushes the actor out along one axis, two cars
  push BOTH apart along the line between them in proportion to mass, or the heavier one
  teleports out of the lighter one's way. Use `mass` for that and `still: true` for something
  that must never be shoved. Measured: **four racing builds in a row left rival collision out on
  purpose** — "AI cars won't use solids collision at all, they only need to follow waypoints" —
  and every one shipped a game where the player drove straight through the field. It is not a
  racing problem; any game with more than one actor has it.
- **Collecting and dying come from `core/contact.js`. Do NOT hand-roll a distance test.**
  Register once and call `contacts.step(wasAt, actor.position)` after everything has moved:

      const contacts = createContacts();
      contacts.pickup(coin,  { radius: 0.7, group: chunk, onTake: () => { coins++; shell.set('coins', coins); } });
      contacts.hazard(train, { radius: 0.9, group: chunk, onHit: () => { alive = false; shell.show('over'); } });
      // ...each frame, after the player AND the world have moved:
      contacts.step(wasAt, player.position, { radius: 0.5 }); wasAt.copy(player.position);
      // ...and in getState(): { ...contacts.report() }

  The consequence stays yours -- a runner dies, a tower defence loses a life, a racer scrapes
  the wall -- so `onHit` is a callback and this module never ends a game by itself. What it owns
  is the measurement, and three things a hand-written `if (dist < 1)` gets wrong: it sweeps the
  RELATIVE motion of actor and item, so a coin is still collected when the world moves past a
  stationary player at 34 m/s on a phone running 20 fps (1.7 m per frame -- a point test steps
  straight over it); it LATCHES, so an overlapping hazard costs one life and not sixty a second;
  and `report()` makes the verb VISIBLE to `check.py`, which otherwise cannot know what a coin
  is. Measured: a shipped endless runner hand-rolled both and reached a device with coins that
  never counted and trains you could drive through -- at 18 of 18 checks passed, because all 35
  checks measure whether a game BOOTS, RENDERS, is VISIBLE, CONTROLLABLE or GROUNDED, and none
  of them measured whether it works as a game. Use `group:` so recycled props stop being
  touchable -- `contacts.removeGroup(chunk)`.
- **Let `followCam` place the chase camera** --
  `followCam(camera, car.position, yaw, { back: 12, height: 6, lerp: 4, dt })`. It owns the
  direction, so `back` is a plain positive DISTANCE and there is no sign left to get wrong.
  Writing it by hand is where the last sign defect lived: a racing build shipped
  `const behind = -12` and then `x - Math.sin(yaw) * behind`, so the formula's minus and the
  constant's minus cancelled and the camera parked across the bonnet looking back at the
  driver. Both halves read correctly on their own -- the formula is exactly the line above, and
  a constant named `behind` invites a negative value because "behind" is a direction. Composed,
  they invert. The car drove straight along its own facing, it never spun, and every
  world-space check passed, because they all compared travel to FACING and the facing was
  right; nothing compared the camera to the actor. On a phone the player accelerated into their
  own viewpoint. `followCam` throws on a non-positive `back`, and `check.py` now measures which
  side of the actor the camera is on, during play rather than at reset -- a lerped camera is
  placed correctly at setup and only slides to the wrong side afterwards.
- **Count what EXISTS, never what you intended.** Derive the "x of N" total and the win
  condition from the objects actually created (`positions.length`), not from the constant you
  asked for. Placement legitimately fails sometimes -- rejecting spots that collide with
  scenery means a capped retry loop can place 19 of 20 -- and a HUD reading `19 / 20` with a
  win test of `collected >= 20` can never be satisfied, with nothing on screen to explain it.
  Three generated builds in a row hard-coded the total. Applies to waves, levels and enemies too.
- **Every objective must be reachable under the player's own movement limits.** The limit
  differs by genre; the arithmetic decides whether the game can be finished at all.
  Push-out collision keeps the player's CENTRE outside `propRadius + playerRadius`, so a
  pickup nearer than that to a prop can never be touched -- scatter props FIRST, then place
  pickups and the spawn point outside that distance, with a small margin and a retry cap of
  ~30 (an uncapped loop hangs on a crowded map). For jumping, compare platform height and gap
  width against the jump arc your physics actually produces. Two real failures, one principle:
  a coin spawned around a tree trunk and the counter stopped at 14 of 15, and a parkour level
  put its first platform 6.1 m above a 2.88 m jump. Not applicable to an endless runner, where
  obstacles are meant to be dodged rather than pushed against.
- **Solid scenery must stop the player.** Props get drawn and then forgotten, and the player
  walks through them -- reported from a device as "we are able to move through the trees".
  Ground collision is not enough. Either give each prop a collider, or keep a list of
  `{x, z, radius}` and push the player out along the normal when they enter one.
- **Build terrain mesh and collider from ONE height function**, and check them with
  `picker.groundAt()`. A mismatch makes the vehicle sink and resurface forever.
- **Spawn streamed chunks relative to the last live chunk**, never from an absolute
  counter -- a counter drifts by the accumulated travel distance and opens holes
  that only appear after ten seconds of play.
- **Apply colour management once.** `createHost` does it. If you add a composite
  pass that tone-maps, pass `manageColour: false`.
- **Never set `metalness` without an environment map** -- it renders near-black.
- **Brighter than a desktop scene.** A phone is held in daylight and ACESFilmic
  compresses midtones; hemisphere ~1.5 plus a key ~2.0 is a sane starting point.
- **Never disable a feature to work around an error.** Report the error instead.

## Verify it before saying it works — this is not optional

You cannot see the game. `check.py` can. It drives the game in a headless browser,
asserts the things that have actually broken before, and saves a screenshot.

It takes about two minutes, and the bash tool kills any command at 120 seconds --
passing a longer `timeout` resets that limit back to 120 rather than raising it. So run
it detached and read its log, which is two calls instead of one:

    cd game && nohup python3 check.py --scene main > /tmp/check-main.log 2>&1 &
    sleep 100; tail -80 /tmp/check-main.log          # your NEXT call

The verdict is the line `N/M checks passed` or `FAILED: ...`. `sleep 100` returns under
the ceiling; `sleep 150` is killed at 120 with the answer already in the log. A kill does
not stop the run -- the log keeps filling, so read it again rather than starting a second.

**Then open the two pictures it prints and look at them.** The checks cannot tell you the
scene looks right; several defects that reached real users were invisible to every
assertion and obvious in one frame. The command prints a short list of what to judge.

    FILMSTRIP:        game/dist/main-frame-filmstrip.png
    frame (with UI):  game/dist/main-frame.png

The filmstrip is six labelled moments of a single run in order -- loaded, after tapping
START, forward held 1s, forward held 2s, steering RIGHT, end of run. Read it as a
SEQUENCE, comparing neighbouring tiles, because that is what a still frame cannot show:
tiles 3 and 4 identical means the game is not running at all, and an actor leaning left
under the tile labelled RIGHT means the steering is mirrored. Both shipped. The filmstrip
is the GL canvas only, so judge motion by the scenery -- the touch controls are DOM and
appear only in the `frame (with UI)` shot.

Do not report a game as working until `check.py` exits 0 AND you have looked at the
filmstrip and the frame. It catches, among others, an inverted throttle (the car drives backwards at the
camera) and input that is not cleared on release (the player keeps moving after lifting
a finger) -- both of which shipped, and both of which cost multiple turns.

### HUD text and end-screen text are yours to set

A shell field's value can be a **string**, not only a number over a total — a race position, a
countdown, a wave label:

    shell.set('pos', `P${place}`);      // renders "P4"
    shell.set('time', '1:07');

And a screen's text can be decided when you show it, not only when you declare it:

    shell.show('win', { title: 'You Win!', hint: `${coins} coins in ${fmt(elapsed)}` });

Both exist because every build on record reached past the shell for exactly these two things —
a final score, a best-lap line, a menu button, a timer — and one used the shell *and* its own HUD,
leaving `LAP 0/3` and `P4` printed on top of each other on a shipped screen. If you find yourself
appending DOM to `shell.overlay`, check whether one of these does it first.

### Telling the app something: `bridge.notify()`

`createBridge()` owns every message between the game and React Native. Four of them are named
(`ready`, `save`, `haptic`, `error`); anything else your game needs the app to know goes through
one call:

    bridge.notify('RACE_COMPLETE', { position, totalMs, bestLapMs });
    bridge.notify('EXIT_TO_MENU');

`GameHost` forwards any type it does not handle itself to its `onMessage` prop, so the React
Native screen receives `{ type, payload }` and does what it likes with it. It returns `false`
when nothing is hosting, so the same bundle still runs in a browser and under `check.py`.

**Do NOT call `ReactNativeWebView.postMessage` yourself.** 33 of 60 generated builds did, having
found the four named calls covered none of what they wanted to say — one patched `GameHost.tsx`
to add a hook, another renamed its event to get past the bundler's gate and spent six bundle
cycles doing it.

What `notify()` does NOT change: **the bundle still owns start, play and end.** Telling the app a
level finished is reporting. Waiting for the app to tell you which level to load next is asking,
and that shipped twice — a runner that posted `GAME_OVER` and drew nothing itself, so the player
could not tell whether it had ended or hung; a maze that set its own `level` only from a message
coming back, so "next level" left you on level 1 for ever. Draw the ending, then say so.

### Lighting is the engine's, including indoors

`createHost()` lights the scene: a sky-tinted hemisphere plus a sun that casts shadows. That is an
OUTDOOR rig, and it is the default because a three.js scene starts pitch black.

**A game with a ceiling passes `lights: 'interior'`.** A maze, a dungeon, a corridor, anything
enclosed: the ceiling blocks the sun, so the default rig cannot light it and you would be inventing
a torch from nothing. The preset gives you a lamp on the camera, a fill that keeps surfaces
readable, and a fog tuned so the far end of a corridor still reads:

    const host = createHost({ canvas, captureFrames: true, lights: 'interior' });

Measured down a twelve-cell corridor, brightness at the far end: **9/255 with a hand-rolled torch,
61/255 with the preset.** A generated first-person maze shipped the first one -- the player could
see the walls beside them and pure black straight ahead, which makes finding an exit impossible.
Two numbers do that damage, and both look reasonable in isolation: a `PointLight` intensity sized
like a `DirectionalLight` (three.js r155+ uses physically-correct units, so `2.4` is nothing at
range), and a near-black fog colour (distance asymptotes to the fog colour, so dark fog means
distance equals darkness however bright the lamp).

`host.lamp` is the camera light, if you want to tune it. `lights: false` still gives you no lights
at all.

### The contract `check.py` reads

Report these from `attachDiagnostics({ getState })`. Each one turns on the checks it can
support; anything you omit is reported as SKIPPED, so a thin report is visible rather
than silent.

| Field | Meaning |
|---|---|
| `view` | **Declare this.** `'avatar'` (you drive a character on foot), `'firstPerson'`, `'vehicle'` (a car, boat or plane: it COASTS when you release the throttle, and it meets barriers a checker cannot steer around), `'onRails'` (carried forward, you only steer), `'placement'` (no avatar: tap to build, board games, viewers). The checks that apply depend entirely on this: a racing game that declared `'avatar'` was asked to stop dead on release and to never stall while pushed forward, failed both for 75 turns, and shipped a car that steers itself. |
| `progress` | The number that rises when the player is doing well. `score`, `distance`, `height`, `wave`, `level` and `best` are recognised too |
| `pos` | `[x, y, z]` of the player. Report it for `onRails` too: the forward motion is automatic, but there IS an actor, and without `pos` nothing can see whether it holds still |
| `facing` | `[x, y, z]` the player faces, so movement direction can be verified |
| `groundY` | Optional now, and only cross-checked. See below |
| `atRest` | **Physics games: report this.** `true` when every dynamic body has stopped. A generated puzzle balanced a target sphere on a flat crate; solver jitter rolled it off unaided, it fell past the win line and completed the level with nobody playing |

**Tap-driven games: publish where your objects are on screen.** Put the projected screen
position of anything tappable into `getState()`, using `project()` from `core/pick.js`:

```js
screen: { piece0: picker.project(piece.position), cell: picker.project(cell.position) }
```

The checker taps those coordinates and measures what changed. Without them it can only tap
blindly: nine taps spread across the screen all missed a board piece sitting at (322, 137),
so a working game was reported as one whose controls do nothing. This is what makes a
placement game checkable at all -- and it cannot be faked, because a coordinate outside the
declared region is refused and one that hits nothing produces no change.

Plus one argument that is not a field:

| Argument | Meaning |
|---|---|
| `actor` | The `Object3D` the player controls: `attachDiagnostics({ host, loop, input, actor: player, getState })`. The checker raycasts the real scene to find the ground under it, and needs this so the actor's own body is not mistaken for the ground it stands on |
| `reset` | **Report this.** A function putting the run back to its starting state: player at spawn, heading zero, velocity zero, collectibles and spawned enemies restored, run score cleared (keep saved bests). The checks before the precise ones deliberately drive the player to the boundary, and a measurement taken from there is not a measurement of the game. Measured: a car reported 30.8 m and 35.6 m of travel on its first two direction checks and then 1.0, 0.9 and 0.3 m, wedged against the barrier — so the check that catches an inverted throttle skipped itself. A generated coin game failed its progress check three times for the same reason and shipped with a counter that never moved |

### Why `groundY` stopped being the source of truth

An audit of 21 generated games found the sinking/hovering check did real work in **three**
of them. Nine reported a constant, seven reported nothing, and two computed `groundY` from
the actor's own position -- `groundY: player.position.y - 0.5` makes clearance a fixed
0.5 m that cannot fail no matter how deep the actor sinks. One of those numbers was quoted
as evidence a game worked.

So the ground is now **measured** by raycasting the scene, and `groundY` is only used to
cross-check that the game agrees with it. The principle generalises: *a check is only real
if the harness has its own source for the number.* Report what you like; it is corroborated
or it is skipped, never taken on trust.

`view` is **declared, never inferred**. A generated tower defence reported a `pos` of
`[0,0,0]` that nothing used, and four avatar checks failed a perfectly working game.
Guessing "nothing moved, so it must be a placement game" would be worse: it would pass a
genuinely broken avatar game.

`progress` is the one invariant that holds for every genre. A generated parkour level
passed every other check with its first platform 6.1 m above a 2.88 m jump -- every
control worked and the game could not be played.

`createHost({ captureFrames: true })` is required for the screenshot.

* **Never let the player get permanently stuck.** Reported from a real device: a
  vehicle wedged against scenery and only a manual reverse freed it. If the player is
  commanding movement and nothing has happened for about a second, recover
  automatically — a small nudge free, or a respawn. A dead game is worse than any
  physics inaccuracy, and `check.py` fails a long stall while input is held.

* **Hide the edge of the world.** A barrier stops the player leaving, but if they can
  SEE the terrain end -- a hard line with void beyond it -- the game reads as
  unfinished. Set fog so it reaches full density before the boundary, or extend a
  skirt of terrain past the playable area. Seen on a device: a dark slab where the
  ground simply stopped.
* **Distant scenery silhouetted against the sky reads as floating.** A small rock or
  tree whose base is hidden behind a hill crest looks unattached even when it is
  perfectly grounded. Fade distant props into the fog, or keep small ones close and
  put large ones on the horizon. Reported from a device as "all objects are floating
  in air" -- and only PART of that was missing shadows.

* **Decide the orientation, and frame the camera from the LIVE aspect ratio.** Every
  generated app starts as `orientation: "portrait"` in `app.json`. If your game is
  designed wide you must say so -- set it there, or lock it at runtime -- and either way
  the camera must fit the play area at whatever shape the screen actually is. Vertical
  field of view is fixed, so horizontal field of view SHRINKS as the screen narrows:
  what fits in landscape does not fit in portrait. A generated puzzle put its ball at
  x=-7 with a camera framed for widescreen; on a portrait phone the visible range was
  -3.8 to 4.8, so the object the player throws was off screen, while the aiming, the
  physics and the trajectory were all perfect.
  Use `host.fitBounds(min, max, { dir })` with the bounds of your play area, and call it
  again from `attachLifecycle({ onResize })`. Never hand-pick camera coordinates.

* **Skia is 2D — never use it for this game.** `@shopify/react-native-skia` ships in every
  project and looks usable, but the installed package has no `depthBuffer`, `DepthTest`,
  `Camera3D`, `PointLight`, `Material` or `Geometry`. No depth buffer means hand-sorting
  occlusion every frame. A generated puzzle drew its level in Skia, never ran `bundle.py`,
  and shipped `GAME_HTML = ""` — on a phone the HUD worked and the play area was black.
  The renderer for this game is three.js inside the WebView.

## Before saying it works

`window.__GAME__` exists so this can be checked rather than assumed:

- frame is not a flat fill (`captureFrame()`) -- catches a black screen
- with no input, state does not change -- catches stuck input
- given input, the intended thing moves in the intended direction
- after 30s of simulated play the world still has content
- `__GAME__.errors` is empty

Touch feel, sustained framerate and backgrounding differ on a real device. The APK
(Deploy → Build Mobile App) is the real test. Do not claim device verification you
have not performed.
