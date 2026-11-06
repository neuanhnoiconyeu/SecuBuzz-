import localFont from 'next/font/local';

// Unmodified, licensed Google Fonts sources are bundled so builds and browsers
// need no font-CDN access. System fonts handle scripts outside these Latin faces.
export const bungee = localFont({
  src: '../assets/fonts/bungee/Bungee-Regular.ttf',
  variable: '--font-bungee',
  weight: '400',
  style: 'normal',
  display: 'swap',
  preload: true,
  fallback: [
    'system-ui', 'Segoe UI', 'Arial', 'Noto Sans CJK SC', 'Microsoft YaHei',
    'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', 'sans-serif',
  ],
});

export const spaceGrotesk = localFont({
  src: '../assets/fonts/spacegrotesk/SpaceGrotesk-Variable.ttf',
  variable: '--font-space-grotesk',
  weight: '400 700',
  style: 'normal',
  display: 'swap',
  preload: true,
  fallback: [
    'system-ui', 'Segoe UI', 'Arial', 'Noto Sans CJK SC', 'Microsoft YaHei',
    'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', 'sans-serif',
  ],
});
