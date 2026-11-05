import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: 'var(--color-brand)',
          hover: 'var(--color-brand-hover)',
          pressed: 'var(--color-brand-pressed)',
          soft: 'var(--color-brand-soft)',
        },
        surface: {
          DEFAULT: 'var(--color-surface)',
          raised: 'var(--color-surface-raised)',
          muted: 'var(--color-surface-muted)',
        },
        ink: {
          DEFAULT: 'var(--color-text)',
          muted: 'var(--color-text-muted)',
          subtle: 'var(--color-text-subtle)',
        },
        border: {
          DEFAULT: 'var(--color-border)',
          strong: 'var(--color-border-strong)',
        },
        success: 'var(--color-success)',
        warning: 'var(--color-warning)',
        danger: 'var(--color-error)',
        info: 'var(--color-info)',
        'xp-blue': 'var(--color-xp-blue)',
        'xp-blue-dark': 'var(--color-xp-blue-dark)',
      },
      fontFamily: {
        sans: ['var(--font-family-base)'],
        retro: ['var(--font-family-retro)'],
      },
      spacing: {
        '18': '4.5rem',
        '22': '5.5rem',
      },
      borderRadius: {
        control: 'var(--radius-control)',
        panel: 'var(--radius-panel)',
      },
      boxShadow: {
        panel: 'var(--shadow-panel)',
        popover: 'var(--shadow-popover)',
      },
      zIndex: {
        dropdown: 'var(--z-dropdown)',
        sticky: 'var(--z-sticky)',
        dialog: 'var(--z-dialog)',
      },
      transitionDuration: {
        fast: 'var(--duration-fast)',
        normal: 'var(--duration-normal)',
      },
      animation: {
        'buzz-shake': 'buzz-shake 0.5s ease-in-out',
      },
      keyframes: {
        'buzz-shake': {
          '0%, 100%': { transform: 'translateX(0)' },
          '10%': { transform: 'translateX(-4px) rotateZ(-0.5deg)' },
          '20%': { transform: 'translateX(4px) rotateZ(0.5deg)' },
          '30%': { transform: 'translateX(-4px) rotateZ(-0.5deg)' },
          '40%': { transform: 'translateX(4px) rotateZ(0.5deg)' },
          '50%': { transform: 'translateX(-4px) rotateZ(-0.5deg)' },
          '60%': { transform: 'translateX(4px) rotateZ(0.5deg)' },
          '70%': { transform: 'translateX(-2px) rotateZ(-0.25deg)' },
          '80%': { transform: 'translateX(2px) rotateZ(0.25deg)' },
          '90%': { transform: 'translateX(-1px) rotateZ(0)' },
        },
      },
    },
  },
  plugins: [],
}
export default config
