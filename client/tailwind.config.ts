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
        // Windows XP colors
        'xp-blue': '#0078d4',
        'xp-gray': '#ece9d8',
        'xp-silver': '#dfddce',
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
