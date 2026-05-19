import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Paleta sobria para panel administrativo (tonos neutros + acento celeste).
        admin: {
          bg: '#0F1419',
          surface: '#1A2027',
          border: '#2A3441',
          text: '#E6EDF3',
          muted: '#7D8590',
          accent: '#5A8FA8',
          success: '#3FB950',
          warn: '#D29922',
          danger: '#F85149',
        },
      },
    },
  },
  plugins: [],
};

export default config;
