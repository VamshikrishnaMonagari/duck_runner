# 🦆 Duck Run

A 3D endless runner mobile game inspired by Temple Run — but starring a cute, waddling duck. Dodge obstacles, collect coins, grab power-ups, and run as far as you can through an ancient jungle temple.

Built with **React Native + Expo** and a **three.js** 3D engine rendered inside a WebView, so it runs on iOS and Android without any native build tooling.

---

## 🎮 How to Play

The duck runs forward automatically. Your job is to survive.

| Action | Control |
|--------|---------|
| Move left / right (change lane) | **Swipe left / right** |
| Jump (over logs, fire rings) | **Swipe up** |
| Slide / duck (under branches) | **Swipe down** |
| Pause | Tap the **pause** button |

### Goal
- Run as far as possible — your **distance** is your score.
- Collect **golden coins** for bonus points.
- Grab **power-ups** to gain an edge:
  - 🧲 **Magnet** — pulls nearby coins toward you
  - 🛡️ **Shield** — absorbs one hit
  - ⚡ **Speed Boost** — go faster with a score multiplier
- Avoid **obstacles**: logs (jump), low branches (slide), stone walls (dodge), and fire rings (jump).
- The game speeds up the longer you run. Your **high score** is saved between sessions.

---

## 🚀 Running the Game

### Prerequisites
- [Node.js](https://nodejs.org/) (LTS recommended)
- [Yarn](https://yarnpkg.com/) or npm
- The **Expo Go** app on your phone (from the App Store / Play Store) — optional, for on-device testing

### Setup

```bash
# 1. Install dependencies
yarn install

# 2. Start the development server
npx expo start
```

Then:
- **On your phone:** open **Expo Go** and scan the QR code shown in the terminal.
- **In your browser:** press `w` to open the web preview.

---

## 🗂️ Project Structure

```
react_native_space/
├── app/                    # Screens (expo-router file-based routing)
│   ├── _layout.tsx         # Root navigation layout
│   ├── index.tsx           # Home / start screen (shows high score)
│   ├── game.tsx            # Gameplay screen (hosts the 3D WebView)
│   ├── game-over.tsx       # Game-over screen (score breakdown + retry)
│   └── +not-found.tsx      # Fallback route
│
├── game/                   # The 3D game engine (three.js)
│   ├── scenes/main.js      # Main game logic — the duck runner scene
│   ├── core/               # Engine modules (render loop, input, physics, bridge)
│   ├── vendor/             # Bundled three.js + cannon-es
│   ├── bundle.py           # Bundles the scene into assets/game/gameHtml.ts
│   └── check.py            # Headless verification harness
│
├── src/
│   ├── host/GameHost.tsx   # React Native <-> WebView bridge host
│   ├── services/storage.ts # High score / preferences persistence (AsyncStorage)
│   └── theme.ts            # Colors, spacing, typography
│
├── assets/                 # Icons, splash screen, bundled game HTML
├── app.json                # Expo configuration
├── package.json            # Dependencies & scripts
└── metro.config.js         # Metro bundler config
```

---

## 🛠️ Modifying the 3D Game

The 3D world lives in `game/scenes/main.js`. The React Native app loads a **bundled** version of it from `assets/game/gameHtml.ts` — so after editing the scene you must re-bundle:

```bash
cd game
python3 bundle.py --scene main --ts ../assets/game/gameHtml.ts
```

The engine core (`game/core/`) handles the render loop, multi-touch input, collision, and the native bridge — you generally only edit `scenes/main.js`.

---

## 🧩 Tech Stack

- **React Native** + **Expo** (SDK 54) — app shell & navigation
- **expo-router** — file-based navigation
- **three.js** — 3D rendering (inside a WebView)
- **cannon-es** — physics
- **AsyncStorage** — local high-score persistence
- **expo-haptics** — collision feedback
- **Web Audio API** — synthesized sound effects (no audio files needed)

---

## 📄 License

See [LICENSE](./LICENSE).

---

Made with 🦆 and three.js.
