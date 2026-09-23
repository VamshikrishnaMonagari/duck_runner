/**
 * Game side of the host bridge. Safe to call when running in a plain browser --
 * every function degrades to a no-op, so the same bundle works in the WebView, in
 * a desktop browser and under an automated check.
 */
const post = (type, payload) => {
  try {
    if (globalThis.ReactNativeWebView) {
      globalThis.ReactNativeWebView.postMessage(JSON.stringify({ type, payload }));
      return true;
    }
  } catch (_) {}
  return false;
};

export function createBridge({ onRestore, onAppState } = {}) {
  // The host injects into this.
  globalThis.__fromHost = (msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'RESTORE') onRestore && onRestore(msg.payload);
    else if (msg.type === 'APP_STATE') onAppState && onAppState(msg.payload);
  };

  return {
    ready: () => post('READY'),
    save: (state) => post('SAVE', state),
    /** 'light' | 'medium' | 'heavy' | 'success' -- the WebView cannot do this itself. */
    haptic: (kind = 'light') => post('HAPTIC', kind),
    error: (message) => post('ERROR', String(message)),
    /** Tell the host something this game specifically needs it to know: a level cleared, a race
     *  finished, a request to leave. Returns false when nothing is hosting, so the same bundle
     *  still runs in a browser and under the checker.
     *
     *  This exists because its absence was the most-copied workaround in the corpus: 33 of 60
     *  generated builds called ReactNativeWebView.postMessage directly, having found that
     *  ready/save/haptic/error covered none of what they wanted to say. One patched GameHost to
     *  add a hook it needed; another renamed its event to slip past the static gate that exists
     *  to catch exactly this. A game with nothing sanctioned to call does not stop calling -- it
     *  goes around, and then the gate and the game fight for six bundle cycles.
     *
     *  The host sees { type, payload } like every other message, and GameHost forwards any type
     *  it does not handle itself to its onMessage prop.
     */
    notify: (type, payload) => post(String(type), payload),
    get isHosted() { return !!globalThis.ReactNativeWebView; },
  };
}
