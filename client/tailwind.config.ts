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
        sans: ['var(--font-body)'],
        body: ['var(--font-body)'],
        display: ['var(--font-display)'],
        retro: ['var(--font-display)'],
      },
      fontSize: {
        display: ['var(--type-display-size)', { lineHeight: 'var(--type-display-line)', fontWeight: '400', letterSpacing: 'var(--type-display-tracking)' }],
        heading: ['var(--type-heading-size)', { lineHeight: 'var(--type-display-line)', fontWeight: '400', letterSpacing: 'var(--type-display-tracking)' }],
        body: ['var(--type-body-size)', { lineHeight: 'var(--type-body-line)' }],
        label: ['var(--type-label-size)', { lineHeight: 'var(--type-label-line)', fontWeight: '600' }],
        caption: ['var(--type-caption-size)', { lineHeight: 'var(--type-caption-line)' }],
        button: ['var(--type-button-size)', { lineHeight: 'var(--type-button-line)', fontWeight: '600' }],
        buzz: ['var(--type-buzz-size)', { lineHeight: 'var(--type-buzz-line)', fontWeight: '400', letterSpacing: 'var(--type-buzz-tracking)' }],
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
        entry: 'var(--motion-entry)',
        dialog: 'var(--motion-dialog)',
      },
      transitionTimingFunction: {
        'motion-out': 'var(--motion-ease-out)',
        'motion-in-out': 'var(--motion-ease-in-out)',
      },
      animation: {
        // The shared keyframe is defined once in styles/motion.css.
        'buzz-shake': 'buzz-shake var(--motion-buzz) steps(2, end)',
      },
    },
  },
  plugins: [],
}
export default config
