/**
 * React Native side of a 3D game: hosts the bundled web game in a WebView and
 * owns everything native around it. The game itself never touches React Native.
 *
 * Harvested from a build that reached 91 FPS on device, plus the error handling
 * that build did NOT have -- which cost three turns of blind guessing, because a
 * blank screen with no message is unfalsifiable from the outside.
 *
 * Usage:
 *   import { GameHost } from './host/GameHost';
 *   import { GAME_HTML } from './assets/game/gameHtml';
 *   export default function App() { return <GameHost html={GAME_HTML} title="MY GAME" />; }
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Platform, StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

type Props = {
  /** The whole game as one inlined HTML string (see bundle.py). */
  html: string;
  title?: string;
  /** Key under which the game's saved state is persisted. */
  storageKey?: string;
  /** Called for any message the game posts that this host does not handle. */
  onMessage?: (msg: { type: string; payload?: unknown }) => void;
};

/** What a ref on <GameHost> gives you. */
export type GameHostHandle = {
  /** Push a message INTO the game. Arrives as `__fromHost({ type, payload })`, which
   *  createBridge() routes to the scene. */
  send: (type: string, payload?: unknown) => void;
};

/** RN -> GAME was missing, and its absence cost a real build a whole subtask.
 *
 *  A tower defence put its turret shop in React Native (its spec told it to), so it needed to
 *  tell the game which turret was selected and when to start a wave. GameHost could only
 *  receive. Editing GameHost is forbidden. So the build wrote its own WebView -- and a build
 *  validator then failed it with "Nothing in this app renders GameHost", costing a second
 *  subtask to hybridise the two. We forbade the edit, required the component, and gave it no
 *  way to do the one thing a placement game needs.
 *
 *    const host = useRef<GameHostHandle>(null);
 *    <GameHost ref={host} html={GAME_HTML} />
 *    host.current?.send('START_WAVE');
 *
 *  Note this does not make React Native the right home for gameplay UI -- a control drawn on
 *  the RN side is invisible to check.py, which loads the bundle alone. Use it for what the app
 *  legitimately owns: difficulty chosen on a menu screen, a resume after a system pause. */
export const GameHost = React.forwardRef<GameHostHandle, Props>(function GameHost(
  { html, title = 'LOADING', storageKey = 'game_state', onMessage }: Props, ref,
) {
  const webRef = useRef<WebView>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);

  /** Push a value into the game. */
  const inject = useCallback((type: string, payload: unknown) => {
    const msg = JSON.stringify({ type, payload });
    if (Platform.OS === 'web') {
      // Same door on web. The tower defence reached for document.querySelector('iframe')
      // because this was not here.
      const w = frameRef.current?.contentWindow as unknown as { __fromHost?: (m: unknown) => void };
      try { w?.__fromHost?.(JSON.parse(msg)); } catch (e) {}
      return;
    }
    webRef.current?.injectJavaScript(`window.__fromHost && window.__fromHost(${msg}); true;`);
  }, []);

  useImperativeHandle(ref, () => ({ send: (type: string, payload?: unknown) => inject(type, payload) }), [inject]);

  // Restore saved state and hand it to the game once it says it is ready.
  const sendSavedState = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(storageKey);
      inject('RESTORE', raw ? JSON.parse(raw) : null);
    } catch (e) {
      inject('RESTORE', null);
    }
  }, [inject, storageKey]);

  const handleMessage = useCallback(async (event: WebViewMessageEvent) => {
    let msg: { type: string; payload?: unknown };
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'READY':
        setLoading(false);
        await sendSavedState();
        break;
      case 'SAVE':
        try { await AsyncStorage.setItem(storageKey, JSON.stringify(msg.payload ?? null)); } catch {}
        break;
      case 'HAPTIC': {
        // The WebView cannot call native haptics, so the game asks the host to.
        const kind = String((msg.payload as string) ?? 'light');
        try {
          if (kind === 'heavy') await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
          else if (kind === 'medium') await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          else if (kind === 'success') await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          else await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        } catch {}
        break;
      }
      case 'ERROR':
        // The game already draws this on its own canvas; surface it natively too so
        // it is visible even if the WebView itself is the thing that failed.
        setFatal(String(msg.payload ?? 'unknown error'));
        setLoading(false);
        break;
      default:
        onMessage?.(msg);
    }
  }, [onMessage, sendSavedState, storageKey]);

  // Pause the game when the app backgrounds: without this the game keeps
  // simulating, and on resume a multi-second delta arrives and the world jumps.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      inject('APP_STATE', state);
    });
    return () => sub.remove();
  }, [inject]);

  // A boot that never posts READY would otherwise sit on the loading overlay
  // forever, hiding whatever went wrong underneath it.
  useEffect(() => {
    const t = setTimeout(() => setLoading(false), 8000);
    return () => clearTimeout(t);
  }, []);

  // The preview runs as web, and react-native-webview renders nothing there -- so a
  // WebView-only host makes the app look broken in the very first place anyone looks,
  // before an APK exists. An iframe with srcDoc reproduces the null-origin condition
  // the native WebView creates, so the same bundle is exercised either way.
  if (Platform.OS === 'web') {
    return (
      <View style={styles.root}>
        {React.createElement('iframe', {
          ref: frameRef,
          srcDoc: html,
          style: { width: '100%', height: '100%', border: 'none', display: 'block' },
          allow: 'accelerometer; gyroscope; autoplay',
          title,
        })}
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <WebView
        ref={webRef}
        source={{ html }}
        style={styles.web}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        setSupportMultipleWindows={false}
        androidLayerType={Platform.OS === 'android' ? 'hardware' : undefined}
        onMessage={handleMessage}
        // Never let a failure present as a blank screen.
        onError={(e) => setFatal('WebView error: ' + JSON.stringify(e.nativeEvent))}
        onHttpError={(e) => setFatal('WebView HTTP error: ' + JSON.stringify(e.nativeEvent))}
        onRenderProcessGone={() => setFatal('The game process was terminated (likely out of memory).')}
        onContentProcessDidTerminate={() => setFatal('The game process was terminated (likely out of memory).')}
      />

      {loading && !fatal && (
        <View style={styles.overlay} pointerEvents="none">
          <Text style={styles.title}>{title}</Text>
          <ActivityIndicator size="large" color="#6fe0c8" style={{ marginTop: 18 }} />
        </View>
      )}

      {fatal && (
        <View style={styles.errorBox}>
          <Text style={styles.errorTitle}>The game failed to start</Text>
          <Text style={styles.errorText}>{fatal}</Text>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  web: { flex: 1, backgroundColor: '#000' },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0b0d13' },
  title: { color: '#e8ecff', fontSize: 26, letterSpacing: 4, fontWeight: '700' },
  errorBox: { ...StyleSheet.absoluteFillObject, padding: 20, backgroundColor: '#101014' },
  errorTitle: { color: '#ff8080', fontSize: 16, fontWeight: '700', marginBottom: 10 },
  errorText: { color: '#ff8080', fontSize: 12, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) },
});
