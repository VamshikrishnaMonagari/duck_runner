import { Platform } from 'react-native';

export const colors = {
  primary: '#F5A623',
  accent: '#E8891C',
  bgDark: '#0A2A2A',
  bgJungle: '#0B3D2E',
  danger: '#EF4444',
  text: '#E8E0D0',
  textMuted: '#C4B998',
  gold: '#FFD700',
  card: 'rgba(255,255,255,0.08)',
  cardBorder: 'rgba(255,255,255,0.12)',
  overlay: 'rgba(10,10,10,0.92)',
} as const;

export const gradients = {
  primary: ['#F5A623', '#E8891C'] as const,
  background: ['#0B3D2E', '#0A2A2A'] as const,
} as const;

export const fonts = {
  display: Platform.select({ ios: 'System', android: 'Roboto', default: 'Arial, sans-serif' }) ?? 'System',
  body: Platform.select({ ios: 'System', android: 'Roboto', default: 'Arial, sans-serif' }) ?? 'System',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  full: 9999,
} as const;
