import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" translucent />
      <Stack
        screenOptions={{
          headerShown: false,
          animation: Platform.OS === 'web' ? 'none' : 'fade',
          contentStyle: { backgroundColor: '#0A2A2A' },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="game" />
        <Stack.Screen name="game-over" />
      </Stack>
    </SafeAreaProvider>
  );
}
