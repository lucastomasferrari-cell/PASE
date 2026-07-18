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
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        // Fondos — tokens cocina.os (ver globals.css :root).
        carbon: {
          900: '#060912',  // --bg-command
          800: '#0D1425',  // --card-bg
          700: '#0F1A2E',  // hover elevado
          600: '#162035',  // --border-dim
          500: '#1E293B',  // slate-800 (borders/inputs)
        },
        brand: {
          50:  '#F4F9FD',
          100: '#EAF3FB',
          200: '#D7E8F5',
          300: '#9DC3E2',
          400: '#75AADB',  // --pase-celeste
          500: '#5A8FC2',
          600: '#4A78A6',
          700: '#3A608A',
          800: '#2A4870',
          900: '#1A3A5E',
        },
        // Grises slate azulados (--text-dim / --text-bright).
        dim: {
          50:  '#F8FAFC',   // --text-bright
          100: '#CBD5E1',
          200: '#94A3B8',   // --text-dim
          300: '#94A3B8',
          400: '#64748B',
          500: '#475569',
        },
        // Semánticos.
        live: '#10b981',    // --status-green
        warn: '#FBBF24',
        crit: '#F87171',
        gold:  '#F5C518',   // --pase-gold (RESTRINGIDO)
        // Alias legacy (mapeados al nuevo sistema dark por compat).
        ink:   { DEFAULT: '#F8FAFC', soft: '#94A3B8', muted: '#64748B' },
        crema: '#060912',
      },
      boxShadow: {
        card: '0 1px 0 rgba(255,255,255,0.02) inset, 0 8px 24px rgba(0,0,0,0.4)',
      },
    },
  },
  plugins: [],
};

export default config;
