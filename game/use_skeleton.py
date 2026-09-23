#!/usr/bin/env python3
"""Start this game over from a different SHAPE.

    python3 game/use_skeleton.py vehicle

`game/scenes/main.js` arrives as a complete, working game already -- whichever skeleton matched
the brief. If it is the wrong shape for what you are building, this swaps it for the right one
and rebundles, so you are still editing a game that runs rather than writing one from nothing.

The shape is about how the game is DRIVEN AND SEEN, not about its subject:

    avatar       a body you move around a world, chase camera   platformer, collect-a-thon, sandbox
    firstPerson  you are the eyes                               maze, dungeon, walking sim, shooter
    vehicle      you drive it, camera behind                    racing, boats, tanks, karts
    onRails      the world is carried past you                  endless runner, lane dodger, rhythm
    placement    a hand above a board, tap to act               tower defence, chess, builder, puzzle

Chess and tower defence are the same shape. Racing and off-road are the same shape. Pick by how
the player controls it; the subject is yours to build on top.
"""
import shutil
import subprocess
import sys
from pathlib import Path


HERE = Path(__file__).resolve().parent
VIEWS = ['avatar', 'firstPerson', 'vehicle', 'onRails', 'placement']


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in VIEWS:
        print(__doc__)
        print(f'  usage: python3 {Path(__file__).name} <{" | ".join(VIEWS)}>')
        return 2
    view = sys.argv[1]
    src = HERE / 'skeletons' / f'{view}.js'
    dst = HERE / 'scenes' / 'main.js'
    if not src.is_file():
        print(f'no skeleton for {view!r} at {src}')
        return 1
    shutil.copy2(src, dst)
    print(f'{dst.name} is now the {view} skeleton ({src.stat().st_size:,} bytes). Rebundling...')
    # Rebundle immediately. The bundle the app imports is a build product; leaving it stale makes
    # the app show the PREVIOUS game while the source says otherwise, and the staleness gate then
    # reports a problem that has nothing to do with what you changed.
    r = subprocess.run([sys.executable, str(HERE / 'bundle.py'), '--scene', 'main',
                        '--ts', '../assets/game/gameHtml.ts'], cwd=HERE)
    if r.returncode != 0:
        print('bundle failed -- the skeleton was copied but the app still imports the old bundle')
        return r.returncode
    print(f'Done. game/scenes/main.js is a working {view} game. Verify it, then change it.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
