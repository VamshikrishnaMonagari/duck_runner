import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, gradients, spacing, radius } from '../src/theme';
import { getGameStats, getSoundEnabled, setSoundEnabled, type GameStats } from '../src/services/storage';

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const [stats, setStats] = useState<GameStats>({ highScore: 0, bestDistance: 0, totalCoins: 0, gamesPlayed: 0 });
  const [soundOn, setSoundOn] = useState(true);
  const floatAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const buttonScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    loadData();
    // Floating duck animation
    Animated.loop(
      Animated.sequence([
        Animated.timing(floatAnim, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(floatAnim, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    ).start();
    // Pulse button animation
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.05, duration: 1000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    ).start();
  }, []);

  const loadData = useCallback(async () => {
    const [s, snd] = await Promise.all([getGameStats(), getSoundEnabled()]);
    setStats(s);
    setSoundOn(snd);
  }, []);

  // Reload stats when screen comes back into focus
  useEffect(() => {
    const unsubscribe = (router as any)?.addListener?.('focus', loadData);
    return () => unsubscribe?.();
  }, [loadData]);

  const handlePlay = useCallback(() => {
    Animated.sequence([
      Animated.timing(buttonScale, { toValue: 0.95, duration: 60, useNativeDriver: true }),
      Animated.timing(buttonScale, { toValue: 1, duration: 100, useNativeDriver: true }),
    ]).start(() => {
      router.push('/game');
    });
  }, []);

  const toggleSound = useCallback(async () => {
    const next = !soundOn;
    setSoundOn(next);
    await setSoundEnabled(next);
  }, [soundOn]);

  const floatY = floatAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -12] });

  return (
    <LinearGradient colors={gradients.background} style={styles.container}>
      <View style={[styles.content, { paddingTop: insets.top + spacing.xl }]}>
        {/* Duck icon */}
        <Animated.View style={[styles.duckContainer, { transform: [{ translateY: floatY }] }]}>
          <Text style={styles.duckEmoji}>🦆</Text>
        </Animated.View>

        {/* Title */}
        <Text style={styles.title}>DUCK RUN</Text>
        <Text style={styles.subtitle}>Temple Escape</Text>

        {/* Play button */}
        <Animated.View style={{ transform: [{ scale: Animated.multiply(pulseAnim, buttonScale) }], marginTop: spacing.xxl }}>
          <Pressable onPress={handlePlay} accessibilityLabel="Tap to play" accessibilityRole="button">
            <LinearGradient colors={gradients.primary} style={styles.playButton} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
              <Text style={styles.playText}>TAP TO PLAY</Text>
            </LinearGradient>
          </Pressable>
        </Animated.View>

        {/* Stats */}
        {stats.gamesPlayed > 0 && (
          <View style={styles.statsContainer}>
            <Text style={styles.statText}>⭐ High Score: {stats.highScore?.toLocaleString?.() ?? '0'}</Text>
            <Text style={styles.statText}>🏆 Best Distance: {stats.bestDistance ?? 0}m</Text>
          </View>
        )}

        {/* Bottom area */}
        <View style={[styles.bottomArea, { paddingBottom: insets.bottom + spacing.md }]}>
          <Pressable
            onPress={toggleSound}
            style={styles.soundButton}
            accessibilityLabel={soundOn ? 'Mute sound' : 'Unmute sound'}
            accessibilityRole="button"
          >
            <Ionicons name={soundOn ? 'volume-high' : 'volume-mute'} size={28} color={colors.text} />
          </Pressable>
        </View>
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  duckContainer: {
    marginTop: spacing.xxl,
    marginBottom: spacing.lg,
  },
  duckEmoji: {
    fontSize: 80,
    textAlign: 'center',
  },
  title: {
    fontSize: 42,
    fontWeight: '900',
    color: colors.primary,
    letterSpacing: 4,
    textAlign: 'center',
    textShadowColor: 'rgba(245,166,35,0.4)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 12,
  },
  subtitle: {
    fontSize: 16,
    color: colors.text,
    marginTop: spacing.sm,
    letterSpacing: 2,
    textAlign: 'center',
    opacity: 0.8,
  },
  playButton: {
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    minWidth: 220,
    alignItems: 'center',
    ...Platform.select({
      ios: {
        shadowColor: colors.primary,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.4,
        shadowRadius: 12,
      },
      android: { elevation: 8 },
      default: {},
    }),
  },
  playText: {
    fontSize: 22,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: 2,
  },
  statsContainer: {
    marginTop: spacing.xl,
    alignItems: 'center',
    gap: spacing.sm,
  },
  statText: {
    fontSize: 15,
    color: colors.textMuted,
    letterSpacing: 0.5,
  },
  bottomArea: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  soundButton: {
    width: 48,
    height: 48,
    borderRadius: radius.full,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
