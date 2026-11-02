import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Yahoo! Security Messenger | Kiroween 2026',
  description:
    'A retro Windows XP UI messenger with end-to-end encryption and AI-powered security agents.',
  keywords: [
    'messenger',
    'e2ee',
    'encryption',
    'windows xp',
    'retro',
    'security',
    'devops',
  ],
  authors: [{ name: 'Yahoo! Security Messenger Contributors' }],
  creator: 'SecuBuzz Team',
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: 'https://securebuzz.local',
    title: 'Yahoo! Security Messenger',
    description:
      'Nostalgic 2000s messenger with modern DevSecOps security.',
    siteName: 'Yahoo! Security Messenger',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Yahoo! Security Messenger',
    description:
      'Nostalgic 2000s messenger with modern DevSecOps security.',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
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
        <meta name="theme-color" content="#0078d4" />
        <link rel="icon" href="/favicon.ico" />
      </head>
      <body>
        {children}
      </body>
    </html>
  );
}
