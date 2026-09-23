import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useRef } from 'react';
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

export default function GameOverScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams();
  const score = Number(params?.score ?? 0) || 0;
  const distance = Number(params?.distance ?? 0) || 0;
  const coins = Number(params?.coins ?? 0) || 0;
  const isNewHighScore = params?.isNewHighScore === 'true';
  const isNewBestDistance = params?.isNewBestDistance === 'true';

  // Stagger animations for each stat row
  const fadeAnims = useRef([0, 1, 2, 3].map(() => new Animated.Value(0))).current;
  const slideAnims = useRef([0, 1, 2, 3].map(() => new Animated.Value(20))).current;
  const titleFade = useRef(new Animated.Value(0)).current;
  const buttonsFade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Title fade in
    Animated.timing(titleFade, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    // Stagger stats
    const staggered = fadeAnims.map((anim, i) =>
      Animated.parallel([
        Animated.timing(anim, { toValue: 1, duration: 350, delay: 300 + i * 120, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(slideAnims[i]!, { toValue: 0, duration: 350, delay: 300 + i * 120, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ])
    );
    Animated.stagger(0, staggered).start();
    // Buttons fade in after stats
    Animated.timing(buttonsFade, { toValue: 1, duration: 400, delay: 900, useNativeDriver: true }).start();
  }, []);

  const handlePlayAgain = useCallback(() => {
    router.replace('/game');
  }, []);

  const handleHome = useCallback(() => {
    router.replace('/');
  }, []);

  const statRows = [
    { emoji: '🏃', label: 'Distance', value: `${distance}m`, highlight: isNewBestDistance },
    { emoji: '💰', label: 'Coins', value: String(coins), highlight: false },
    { emoji: '⭐', label: 'Score', value: score?.toLocaleString?.() ?? '0', highlight: isNewHighScore },
  ];

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.xxl, paddingBottom: insets.bottom + spacing.lg }]}>
      {/* Title */}
      <Animated.View style={{ opacity: titleFade }}>
        <Text style={styles.gameOverTitle}>GAME OVER</Text>
        <Text style={styles.duckEmoji}>🦆💀</Text>
      </Animated.View>

      {/* Stats card */}
      <View style={styles.statsCard}>
        {statRows?.map?.((row, i) => (
          <Animated.View
            key={row?.label ?? i}
            style={[
              styles.statRow,
              {
                opacity: fadeAnims?.[i] ?? 1,
                transform: [{ translateY: slideAnims?.[i] ?? 0 }],
              },
            ]}
          >
            <Text style={styles.statEmoji}>{row?.emoji}</Text>
            <Text style={styles.statLabel}>{row?.label}</Text>
            <Text style={[styles.statValue, row?.highlight && styles.statHighlight]}>
              {row?.value}
            </Text>
            {row?.highlight && (
              <View style={styles.newBadge}>
                <Text style={styles.newBadgeText}>NEW!</Text>
              </View>
            )}
          </Animated.View>
        )) ?? null}
      </View>

      {/* Buttons */}
      <Animated.View style={[styles.buttonsContainer, { opacity: buttonsFade }]}>
        <Pressable onPress={handlePlayAgain} accessibilityLabel="Play again" accessibilityRole="button">
          <LinearGradient colors={gradients.primary} style={styles.primaryButton} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
            <Ionicons name="refresh" size={22} color="#fff" style={{ marginRight: spacing.sm }} />
            <Text style={styles.primaryButtonText}>PLAY AGAIN</Text>
          </LinearGradient>
        </Pressable>

        <Pressable onPress={handleHome} style={styles.secondaryButton} accessibilityLabel="Go home" accessibilityRole="button">
          <Ionicons name="home-outline" size={20} color={colors.text} style={{ marginRight: spacing.sm }} />
          <Text style={styles.secondaryButtonText}>HOME</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'rgba(10,10,10,0.95)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  gameOverTitle: {
    fontSize: 38,
    fontWeight: '900',
    color: colors.danger,
    textAlign: 'center',
    letterSpacing: 3,
    textShadowColor: 'rgba(239,68,68,0.5)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 16,
  },
  duckEmoji: {
    fontSize: 48,
    textAlign: 'center',
    marginTop: spacing.md,
    marginBottom: spacing.xl,
  },
  statsCard: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    gap: spacing.md,
  },
  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  statEmoji: {
    fontSize: 22,
    width: 36,
  },
  statLabel: {
    fontSize: 16,
    color: colors.textMuted,
    flex: 1,
  },
  statValue: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
  },
  statHighlight: {
    color: colors.primary,
  },
  newBadge: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginLeft: spacing.sm,
  },
  newBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#fff',
  },
  buttonsContainer: {
    marginTop: spacing.xl,
    width: '100%',
    maxWidth: 340,
    gap: spacing.md,
    alignItems: 'center',
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.md,
    minWidth: 220,
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
  primaryButtonText: {
    fontSize: 18,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: 1.5,
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md - 2,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    minWidth: 220,
  },
  secondaryButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: 1,
  },
});
