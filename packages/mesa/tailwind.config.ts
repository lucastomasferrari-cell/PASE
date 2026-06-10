import type { Config } from 'tailwindcss';

// MESA — alineado a la paleta del ecosistema PASE/COMANDA (pedido Lucas
// 10-jun): navy #1A3A5E como tinta, celeste sobrio como primario, fondos
// celeste muy claro (#F4F9FD = --pase-bg-soft). Playfair Display se mantiene
// para los títulos (toque hospitality premium sobre la marca del ecosistema).
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
        display: ['"Playfair Display"', 'Georgia', 'serif'],
      },
      colors: {
        brand: {
          50: '#F4F9FD',   // --pase-bg-soft
          100: '#E3F0FA',
          200: '#C5E0F4',
          300: '#9CCAEA',
          400: '#7EB3DD',  // --pase-celeste (primary del ecosistema)
          500: '#5E9FD1',  // primary-hover
          600: '#4486BC',
          700: '#356C99',
          800: '#2C5878',
          900: '#1A3A5E',  // --pase-text (navy ancla de marca)
        },
        ink: {
          DEFAULT: '#1A3A5E',  // navy PASE
          soft: '#4A6584',
          muted: '#7D93AB',
        },
        crema: '#F7FAFD',      // fondo general, celeste casi blanco
      },
      boxShadow: {
        card: '0 1px 3px rgba(26,58,94,0.06), 0 8px 24px rgba(26,58,94,0.06)',
      },
    },
  },
  plugins: [],
};

export default config;
