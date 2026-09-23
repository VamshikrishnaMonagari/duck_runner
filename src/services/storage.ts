import AsyncStorage from '@react-native-async-storage/async-storage';

const KEYS = {
  HIGH_SCORE: '@duck_run_high_score',
  BEST_DISTANCE: '@duck_run_best_distance',
  TOTAL_COINS: '@duck_run_total_coins',
  SOUND_ENABLED: '@duck_run_sound',
  GAMES_PLAYED: '@duck_run_games_played',
} as const;

export interface GameStats {
  highScore: number;
  bestDistance: number;
  totalCoins: number;
  gamesPlayed: number;
}

export interface GameResult {
  score: number;
  distance: number;
  coins: number;
}

async function getNumber(key: string, fallback: number): Promise<number> {
  try {
    const val = await AsyncStorage.getItem(key);
    if (val == null) return fallback;
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

async function getBool(key: string, fallback: boolean): Promise<boolean> {
  try {
    const val = await AsyncStorage.getItem(key);
    if (val == null) return fallback;
    return val === 'true';
  } catch {
    return fallback;
  }
}

export async function getGameStats(): Promise<GameStats> {
  const [highScore, bestDistance, totalCoins, gamesPlayed] = await Promise.all([
    getNumber(KEYS.HIGH_SCORE, 0),
    getNumber(KEYS.BEST_DISTANCE, 0),
    getNumber(KEYS.TOTAL_COINS, 0),
    getNumber(KEYS.GAMES_PLAYED, 0),
  ]);
  return { highScore, bestDistance, totalCoins, gamesPlayed };
}

export async function getSoundEnabled(): Promise<boolean> {
  return getBool(KEYS.SOUND_ENABLED, true);
}

export async function setSoundEnabled(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(KEYS.SOUND_ENABLED, String(enabled));
  } catch { /* swallow */ }
}

export async function saveGameResult(result: GameResult): Promise<{ isNewHighScore: boolean; isNewBestDistance: boolean }> {
  try {
    const stats = await getGameStats();
    const isNewHighScore = (result?.score ?? 0) > stats.highScore;
    const isNewBestDistance = (result?.distance ?? 0) > stats.bestDistance;

    await AsyncStorage.multiSet([
      [KEYS.HIGH_SCORE, String(Math.max(stats.highScore, result?.score ?? 0))],
      [KEYS.BEST_DISTANCE, String(Math.max(stats.bestDistance, result?.distance ?? 0))],
      [KEYS.TOTAL_COINS, String(stats.totalCoins + (result?.coins ?? 0))],
      [KEYS.GAMES_PLAYED, String(stats.gamesPlayed + 1)],
    ]);

    return { isNewHighScore, isNewBestDistance };
  } catch {
    return { isNewHighScore: false, isNewBestDistance: false };
  }
}
