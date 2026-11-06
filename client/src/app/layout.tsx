import type { Metadata } from 'next';
import { BRAND_NAME } from '@/components/branding/brandConstants';
import { ThemeProvider } from '@/theme';
import { THEME_BOOTSTRAP_SCRIPT } from '@/theme/themeScript';
import { THEME_BROWSER_COLORS } from '@/theme/themeModel';
import { bungee, spaceGrotesk } from './fonts';
import 'nes.css/css/nes.min.css';
import '@/styles/motion.css';
import '@/styles/themes.css';
import './globals.css';
import '@/styles/typography.css';

export const metadata: Metadata = {
  title: BRAND_NAME,
  description:
    'Yahoo! Security Messenger 2.0: a local messenger demo with multiple conversations, profiles, and browser-side encryption.',
  keywords: [
    'messenger',
    'browser encryption',
    'encryption',
    'Yahoo! Security Messenger 2.0',
    'retro',
    'security',
    'devops',
  ],
  authors: [{ name: 'Yahoo! Security Messenger Contributors' }],
  creator: BRAND_NAME,
  icons: {
    icon: [
      { url: '/branding/favicon.svg', type: 'image/svg+xml', sizes: 'any' },
      { url: '/branding/favicon-32.png', type: 'image/png', sizes: '32x32' },
      { url: '/branding/favicon-16.png', type: 'image/png', sizes: '16x16' },
    ],
    shortcut: '/branding/favicon-32.png',
    apple: { url: '/branding/apple-touch-icon.png', type: 'image/png', sizes: '180x180' },
  },
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: 'https://securebuzz.local',
    title: BRAND_NAME,
    description: 'A local messenger demo with Yahoo-inspired design, profiles, and browser-side encryption.',
    siteName: BRAND_NAME,
  },
  twitter: {
    card: 'summary_large_image',
    title: BRAND_NAME,
    description: 'A Yahoo-inspired messenger UI with a local browser encryption demo.',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: THEME_BROWSER_COLORS.light,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // The head bootstrap sets only this element's data-theme and color-scheme
    // before hydration. Component markup retains normal hydration checks.
    <html lang="en" className={`${bungee.variable} ${spaceGrotesk.variable}`} suppressHydrationWarning>
      <head>
        <script id="secubuzz-theme-init" dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
