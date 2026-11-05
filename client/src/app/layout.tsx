import type { Metadata } from 'next';
import 'nes.css/css/nes.min.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'SecuBuzz! | Yahoo Messenger Demo',
  description:
    'A Yahoo-inspired local messenger demo with multiple conversation views.',
  keywords: [
    'messenger',
    'browser encryption',
    'encryption',
    '8-bit',
    'retro',
    'security',
    'devops',
  ],
  authors: [{ name: 'SecuBuzz Contributors' }],
  creator: 'SecuBuzz Team',
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: 'https://securebuzz.local',
    title: 'SecuBuzz! | Yahoo Messenger Demo',
    description: 'A Yahoo-inspired local messenger demo with multiple conversation views.',
    siteName: 'SecuBuzz!',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'SecuBuzz! | Yahoo Messenger Demo',
    description: 'A Yahoo-inspired messenger UI with a local browser encryption demo.',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="theme-color" content="#f4f1f7" />
        <link rel="icon" href="/favicon.ico" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        {children}
      </body>
    </html>
  );
}
