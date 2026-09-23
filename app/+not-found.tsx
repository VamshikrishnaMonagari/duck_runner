import { router } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../src/theme';

export default function NotFoundScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.emoji}>🦆❓</Text>
      <Text style={styles.title}>Page Not Found</Text>
      <Pressable onPress={() => router.replace('/')} style={styles.button}>
        <Text style={styles.buttonText}>Go Home</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A2A2A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: {
    fontSize: 64,
    marginBottom: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 24,
  },
  button: {
    paddingHorizontal: 32,
    paddingVertical: 12,
    backgroundColor: colors.primary,
    borderRadius: 12,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
});
