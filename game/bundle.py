#!/usr/bin/env python3
"""Emit one self-contained HTML file for a scene.

Why this exists: `source={{ html }}` in react-native-webview has origin `null`, and
Chromium refuses ES module imports from a null origin -- so a modular game cannot
load in a WebView at all. Everything must end up in a single inline script.

Why esbuild rather than a hand-rolled concatenation: three.js ships its build split
across `three.module.js` and `three.core.js`, compiled as separate modules with
independent internal temporaries (both declare `_m1$1`). Flattening them into one
scope is a name collision, so correct bundling needs real scope hoisting with
renaming. Doing that by hand hit three separate failure modes -- the split build,
the `export { ... } from` re-export form, and finally the collision -- which is the
point at which a hand-rolled bundler stops being worth it.

esbuild runs via npx at build time (build machine only, never at runtime) and is
pinned below so output stays reproducible.

Usage:
  python3 bundle.py --scene first-person [--out dist/first-person.html] [--no-minify]
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).parent
ESBUILD = 'esbuild@0.25.0'

BOOT = """import {{ start }} from '{scene}';

(function boot() {{
  try {{
    const canvas = document.getElementById('c');
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    start(canvas);
    window.__READY__ = true;
    try {{
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
        JSON.stringify({{ type: 'READY' }}));
    }} catch (e) {{}}
  }} catch (e) {{
    window.__showError('BOOT FAILED: ' + (e && e.stack ? e.stack : e));
  }}
}})();
"""

HTML = """<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no,viewport-fit=cover">
<title>{title}</title>
<style>
html,body{{margin:0;height:100%;overflow:hidden;background:#000;overscroll-behavior:none}}
#c{{display:block;width:100vw;height:100vh;touch-action:none}}
/* Never a blank screen: anything thrown lands here, readable, on the device. */
#err{{position:fixed;inset:0;display:none;padding:16px;color:#ff8080;background:#101014;
font:13px/1.45 ui-monospace,monospace;white-space:pre-wrap;overflow:auto;z-index:99}}
</style></head>
<body><canvas id="c"></canvas><div id="err"></div>
<script>
(function () {{
  var box = document.getElementById('err');
  window.__showError = function (m) {{
    box.style.display = 'block';
    box.textContent += m + '\\n\\n';
    try {{ window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
      JSON.stringify({{ type: 'ERROR', payload: String(m) }})); }} catch (e) {{}}
  }};
  window.addEventListener('error', function (e) {{
    __showError('ERROR: ' + ((e.error && e.error.stack) || e.message)); }});
  window.addEventListener('unhandledrejection', function (e) {{
    __showError('REJECTION: ' + ((e.reason && e.reason.stack) || e.reason)); }});
}})();
</script>
<script>
{bundle}
</script>
</body></html>
"""


def check_self_contained(js: str) -> list[str]:
    """The whole point of bundling is that nothing is fetched at runtime, because a
    WebView loading from a null origin cannot fetch anything. Verify that."""
    problems = []
    if re.search(r'^\s*(?:import|export)\b', js, re.M):
        problems.append('bundle still contains import/export statements')
    for m in re.finditer(r"""['"](https?://[^'"]+)['"]""", js):
        url = m.group(1)
        if 'threejs.org' in url or 'w3.org' in url:
            continue  # spec/doc links inside three's own strings, never fetched
        problems.append(f'external URL referenced at runtime: {url}')
    if 'importScripts(' in js:
        problems.append('bundle uses importScripts()')
    return problems


_ENGINE_IMPORT = re.compile(r"""from\s+['"]\.\./(?:core/host\.js|vendor/three\.module\.js)['"]""")
_OWN_GAME_OBJECT = re.compile(r"""(?:window|globalThis|self)\s*(?:\.\s*__GAME__|\[\s*['"]__GAME__['"]\s*\])\s*=""")


def check_scene_uses_engine(src: str) -> list[str]:
    """Refuse to bundle a scene that is not an engine game, BEFORE anything is built.

    This costs one file read and two regexes, and it runs before esbuild, before a bundle
    exists and before any app screen is written -- the cheapest point at which a wrong
    architecture can be caught. Everything downstream is more expensive: the wiring gate
    only compares bytes (a 2D game bundled correctly matches its own rebuild perfectly),
    and check.py asks the game about itself through `window.__GAME__`, so a game that
    writes that object supplies its own verdict. A generated maze did exactly that --
    hand-rolled `__GAME__` reporting phase/pos/facing/progress -- and was caught only
    because it also skipped this script.
    """
    problems = []
    if not _ENGINE_IMPORT.search(src):
        problems.append(
            "it imports neither '../core/host.js' nor '../vendor/three.module.js', so it cannot be "
            'rendering in 3D. Real-time 3D here is three.js through createHost(); a canvas 2D or '
            'SVG/raycaster game is not a substitute and will not be accepted downstream. Write the '
            'game in this file using the core modules -- see game/README.md.')
    if _OWN_GAME_OBJECT.search(src):
        problems.append(
            'it assigns window.__GAME__ itself. That object is the contract check.py reads to test '
            'the game, and it is built by attachDiagnostics() from the real host and renderer. A '
            'scene that writes it is authoring its own test results. Call attachDiagnostics({host, '
            'loop, input, getState, actor, reset}) instead and let the engine expose it.')
    return problems


_VIEW = re.compile(r"""view\s*:\s*['"](\w+)['"]""")
_PROGRESS = re.compile(r"""\b(?:progress|score|distance|height|wave|level|laps?)\s*:""")
_STAGE = re.compile(r"""\b(wave|level|round|stage)\s*:\s*([A-Za-z_$][\w$]*)""")
_SCREEN = re.compile(r"""\bscreen\s*:""")
# Gameplay handed to the host. Not "any postMessage" -- persisting a high score outward is fine.
# These particular verbs mean the bundle is asking the app to decide what happens next.
_GAMEPLAY_VERB = (r"""GAME_?OVER|LEVEL_?COMPLETE|LEVEL_?DONE|SET_?LEVEL|NEXT_?LEVEL|"""
                  r"""LEVEL_?UP|RESTART|GAME_?START|START_?GAME|PLAY_?AGAIN""")
# Two shapes, because one level of indirection defeated the first. The original pattern matched
# only `type: 'GAME_OVER'` as a key/value pair. A generated endless runner wrote a helper --
# `const notifyHost = (type, payload) => postMessage(JSON.stringify({ type, payload }))` -- and
# then called `notifyHost('GAME_OVER', {...})`, so the verb was an ARGUMENT and never appeared
# beside a `type` key. It slipped straight through, two minutes after this rule went live, and
# the agent's own reasoning shows it read the guideline and routed around it deliberately.
# A bundle that declares a win/game-over screen, or shows one, is drawing its own ending.
_OWN_END_SCREENS = r'screens\s*:\s*\{.{0,600}?\b(win|over|gameover|lose|complete|victory|defeat)\b'
_OWN_END_SHOW = r"shell\.show\(\s*['\"](win|over|gameover|lose|victory|complete|defeat)"
# ...and the two-thirds of generated games that never call createShell still draw endings --
# with their own overlay DOM and their own phase variable. Keying the exemption to the shell
# alone would have exempted none of the builds that actually churned against this gate, which
# is the same shell-shaped blind spot that produced three earlier bugs: 20 of 60 builds use
# createShell, 30 of 60 build their own full-screen overlay.
_OWN_END_DOM = (r"""(showGameOver|showWin|showVictory|showDefeat|gameOverEl|winEl|overlayEl)"""
                r"""|(phase|state|gameState)\s*=\s*['\"](gameover|game_over|won|win|lost|lose|defeat)"""
                r"""|['\">](GAME OVER|YOU WIN|YOU LOSE|VICTORY|DEFEAT|TIME'?S UP)""")
_HOSTGATE = re.compile(
    r"""(?:['"]?type['"]?\s*[:=]=?\s*['"](?P<kv>""" + _GAMEPLAY_VERB + r""")['"]"""
    r"""|['"](?P<arg>""" + _GAMEPLAY_VERB + r""")['"]\s*,)""", re.I)


def check_scene_contract(src: str) -> tuple[list[str], list[str]]:
    """Static checks on what the scene PUBLISHES, before anything is built.

    Everything here was caught at runtime by check.py, two minutes and four turns later, or
    not caught at all. A grep is the cheaper place. Each rule below is a defect that actually
    shipped:

      * no `view`            -> a racing game declared none, so a car was judged by the rules
                                written for a person on foot: "stop within 8 s of release",
                                "never stall while pushing forward". 75 turns, never green.
      * no progress number   -> the same racing game reported `progress: 0 -> 0` for seven
                                check cycles because it never published one.
      * a stage counter that -> a tower defence published `wave: currentWave + 1` and never
        is never incremented    incremented `currentWave`. Every wave was wave 1, victory was
                                unreachable, and it passed 11/11 because the progress check
                                skips for a placement view. Unwinnable, and shipped.

    Returns (fatal, warnings). Only high-confidence cases are fatal: the stage rule fires
    only for a simple `let` local, because a counter held on an object or behind a setter
    cannot be judged by grep, and a false refusal here blocks a working game.
    """
    fatal, warn = [], []
    if 'attachDiagnostics' not in src:
        return fatal, warn        # not a diagnosable game scene (engine self-tests)

    m = _VIEW.search(src)
    view = m.group(1) if m else None
    if not view:
        fatal.append(
            "getState() does not declare `view`. Say which shape of game this is -- 'avatar', "
            "'firstPerson', 'onRails', 'vehicle' or 'placement' -- because the checks that apply "
            'depend on it entirely: a car must not be asked to stop dead when you release the '
            'throttle, and a board game has no avatar to walk anywhere.')
    if view and view != 'placement' and not _PROGRESS.search(src):
        fatal.append(
            'getState() publishes no progress number. Report one of progress / score / distance / '
            'height / wave / level, rising as the player advances. Without it nothing can tell a '
            'playable game from one that renders correctly and cannot be advanced at all -- which '
            'is the single failure that every passing control check still allows.\n'
            'Every game has one, including a sandbox, an endless explorer or a puzzle with no '
            'score: distance travelled from the spawn point, or seconds survived. Both are '
            'already in the scene -- `progress: +actor.position.distanceTo(spawn).toFixed(2)` or '
            'an elapsed accumulated from the `dt` your step function is handed. Pick whichever '
            'the player is actually trying to increase; the number does not have to be shown to '
            'them, it only has to move when they play well.')

    for field, ident in _STAGE.findall(src):
        if not re.search(rf'\blet\s+{re.escape(ident)}\b', src):
            continue              # not a simple local: grep cannot judge it, so do not refuse
        if re.search(rf'\b{re.escape(ident)}\s*(?:\+\+|\+=)', src):
            continue
        if re.search(rf'\b{re.escape(ident)}\s*=\s*[^=;\n]*\b{re.escape(ident)}\b', src):
            continue
        # ...or advanced arithmetically and passed on, e.g. `startLevel(currentLevel + 1)` with the
        # assignment happening inside from a parameter. Measured across 65 generated builds: this
        # rule fired on 3, and 2 of those 3 were wrong -- the level genuinely advanced. One of them
        # spent a scene rewrite adding a "direct increment pattern" purely to satisfy this grep,
        # which is the same deformation the host-message gate produced twice.
        if re.search(rf'\b{re.escape(ident)}\s*[+-]\s*1\b', src):
            continue
        fatal.append(
            f'getState() publishes `{field}` from `{ident}`, but `{ident}` is never incremented '
            f'anywhere in this file -- so every {field} is the first one and the game cannot be '
            f'finished. Advance it when the {field} completes.')

    # DOES THE BUNDLE DRAW ITS OWN ENDING? If it does, telling the app afterwards is reporting,
    # not asking, and the rule below does not apply. Matching gameplay VOCABULARY was defeated by
    # a rename twice: one maze ran `sed -i 's/levelComplete/mazeCompleted/g'`, another added a
    # "direct increment pattern" for the analyser and then deleted its bridge.save calls. Between
    # them that cost 24 scene rewrites and 6 bundle cycles -- on games whose endings were drawn
    # locally the whole time, i.e. games this rule was never meant to stop.
    draws_own_end = bool(
        re.search(_OWN_END_SCREENS, src, re.I | re.S)
        or re.search(_OWN_END_SHOW, src, re.I)
        or re.search(_OWN_END_DOM, src, re.I))
    m = None if draws_own_end else _HOSTGATE.search(src)
    if m:
        fatal.append(
            f"""this scene sends or waits on '{m.group('kv') or m.group('arg')}'. The BUNDLE owns """
            'start, play and end -- a '
            'host message may CONFIGURE (difficulty, which level) or PERSIST (a high score), never '
            'GATE or ADVANCE the game. Two device builds prove why. An endless runner posted '
            'GAME_OVER to React Native and drew nothing itself, so on the third death it froze with '
            'no message and the player could not tell whether it had ended or hung. A maze posted '
            'LEVEL_COMPLETE and set its own `level` ONLY from a SET_LEVEL message coming back, so '
            'finishing level 1 and tapping "next level" left the player on level 1 for ever. Both '
            'passed every runtime check, because both are correct right up to the boundary.\n'
            'Draw the end and the next level INSIDE the bundle: createShell(input, {screens, '
            'onAction}) owns the win, game-over and restart screens and works with no app attached. '
            'Tell the app afterwards if it is useful -- bridge.save({best}) to persist, or '
            'bridge.notify(type, payload) for anything else it needs to know -- but never wait '
            'to be told what to do next. This check does not fire at all once the bundle draws '
            'its own win/game-over screen, because then you are reporting, not asking.')

    if _PROGRESS.search(src) and not _SCREEN.search(src) and view != 'placement':
        warn.append(
            'this scene publishes progress but no `screen:` positions, so the checker can only '
            'drive in one direction and hope. Report where the objectives are -- '
            'screen: { coin0: project(coin.position) } using project() from core/pick.js -- and '
            'it will steer at them. Of six generated games, the one that published these was the '
            'only one to pass every check.')
    return fatal, warn


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--scene', required=True, help='scene name under scenes/, e.g. first-person')
    ap.add_argument('--out', default=None)
    ap.add_argument('--no-minify', action='store_true')
    ap.add_argument('--ts', default=None, metavar='PATH',
                    help='also write a TS module exporting the HTML, e.g. '
                         '../assets/game/gameHtml.ts (this is what the app imports)')
    args = ap.parse_args()

    scene = ROOT / 'scenes' / f'{args.scene}.js'
    if not scene.exists():
        raise SystemExit(f'no such scene: {scene}')
    scene_src = scene.read_text(encoding='utf8')
    engine_problems = check_scene_uses_engine(scene_src)
    if engine_problems:
        raise SystemExit(f'{scene} does not use the engine:\n  - ' + '\n  - '.join(engine_problems))
    contract_fatal, contract_warn = check_scene_contract(scene_src)
    for w in contract_warn:
        print(f'WARNING: {w}', flush=True)
    if contract_fatal:
        raise SystemExit(f'{scene} does not satisfy the diagnostics contract:\n  - '
                         + '\n  - '.join(contract_fatal))
    if not shutil.which('npx'):
        raise SystemExit('npx not found; esbuild is required to bundle')

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        entry = tmp / 'entry.js'
        entry.write_text(BOOT.format(scene=scene.resolve().as_posix()), encoding='utf8')
        out_js = tmp / 'bundle.js'

        # three's own addons (EffectComposer, UnrealBloomPass, ...) import bare 'three'.
        # Aliasing it to the vendored build means one copy of three ends up in the
        # bundle, shared by the scene and the addons -- without the alias, esbuild
        # cannot resolve them at all, which is what made post-processing look
        # impossible here. The addons are vendored beside three so their relative
        # imports resolve on their own.
        three = (ROOT / 'vendor' / 'three.module.js').resolve()
        cmd = ['npx', '--yes', ESBUILD, str(entry), '--bundle', '--format=iife',
               '--target=es2019', '--platform=browser', f'--alias:three={three}',
               f'--outfile={out_js}']
        if not args.no_minify:
            cmd.append('--minify')
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise SystemExit('esbuild failed:\n' + (proc.stderr or proc.stdout))
        bundle = out_js.read_text(encoding='utf8')

    problems = check_self_contained(bundle)
    if problems:
        raise SystemExit('bundle is not self-contained:\n  - ' + '\n  - '.join(problems))

    html = HTML.format(title=args.scene, bundle=bundle)
    out = Path(args.out) if args.out else ROOT / 'dist' / f'{args.scene}.html'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding='utf8')

    print(f'{out}  ({len(html) / 1024:.0f} KB)')
    print('  self-contained: no imports, no runtime fetches -- loads from a null origin')

    if args.ts:
        # json.dumps gives a correctly escaped JS string literal, so the HTML can
        # contain any quote, backslash or newline without hand-escaping.
        ts = Path(args.ts)
        ts.parent.mkdir(parents=True, exist_ok=True)
        ts.write_text('// GENERATED by game/bundle.py -- do not edit by hand.\n'
                      '// Rebuild after every change under game/.\n'
                      f'export const GAME_HTML = {json.dumps(html)};\n', encoding='utf8')
        print(f'{ts}  ({ts.stat().st_size / 1024:.0f} KB)  <- the app imports this')


if __name__ == '__main__':
    main()
