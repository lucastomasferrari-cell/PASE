import type { Config } from 'tailwindcss';

/**
 * Bot de Instagram — web propia. Paleta alineada con el ecosistema Cocina/PASE:
 * celeste IRAM 7677-2002 + dorado restringido + navy.
 */
const config: Config = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '1.5rem',
      screens: { '2xl': '1200px' },
    },
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        brand: {
          50:  '#F4F9FD',
          100: '#EAF3FB',
          200: '#D7E8F5',
          300: '#9DC3E2',
          400: '#75AADB',
          500: '#5A8FC2',
          600: '#4A78A6',
          700: '#3A608A',
          800: '#2A4870',
          900: '#1A3A5E',
        },
        ink: {
          DEFAULT: '#1A3A5E',
          soft:    '#4A6584',
          muted:   '#7D93AB',
        },
        gold:  '#F5C518',
        crema: '#FAF6EC',
      },
      boxShadow: {
        card: '0 1px 3px rgba(26,58,94,0.06), 0 8px 24px rgba(26,58,94,0.06)',
      },
    },
  },
  plugins: [],
};

export default config;
