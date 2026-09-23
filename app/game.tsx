import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { GameHost, type GameHostHandle } from '../src/host/GameHost';
import { GAME_HTML } from '../assets/game/gameHtml';
import { getSoundEnabled, saveGameResult, getGameStats } from '../src/services/storage';

export default function GameScreen() {
  const hostRef = useRef<GameHostHandle>(null);
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [soundEnabled, stats] = await Promise.all([getSoundEnabled(), getGameStats()]);
      if (cancelled) return;
      const config = JSON.stringify({
        soundEnabled,
        highScore: stats?.highScore ?? 0,
        bestDistance: stats?.bestDistance ?? 0,
      });
      // Inject config before </head>
      const injected = GAME_HTML?.replace?.(
        '</head>',
        `<script>window.__GAME_CONFIG__=${config};</script></head>`
      ) ?? GAME_HTML;
      setHtml(injected);
    })();
    return () => { cancelled = true; };
  }, []);

  const handleMessage = useCallback(async (msg: { type: string; payload?: unknown }) => {
    if (msg?.type === 'GAME_OVER') {
      const payload = (msg?.payload ?? {}) as { score?: number; distance?: number; coins?: number };
      const score = payload?.score ?? 0;
      const distance = payload?.distance ?? 0;
      const coins = payload?.coins ?? 0;
      const result = await saveGameResult({ score, distance, coins });
      router.replace({
        pathname: '/game-over',
        params: {
          score: String(score),
          distance: String(distance),
          coins: String(coins),
          isNewHighScore: String(result?.isNewHighScore ?? false),
          isNewBestDistance: String(result?.isNewBestDistance ?? false),
        },
      });
    }
  }, []);

  if (!html) {
    return <View style={styles.container} />;
  }

  return (
    <View style={styles.container}>
      <GameHost
        ref={hostRef}
        html={html}
        title="Duck Run"
        storageKey="@duck_run_save"
        onMessage={handleMessage}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A2A2A',
  },
});
