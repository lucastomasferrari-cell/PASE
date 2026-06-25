import type { Config } from 'tailwindcss';

// Habitué — CRM/Marketing del ecosistema Cocina. Base ink/crema compartida con
// MESA, pero primario DORADO/ámbar (fidelidad, calidez, "habitué premium") para
// diferenciar el producto. Playfair en títulos (toque hospitality).
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
          50: '#FBF6EC',
          100: '#F6E8C9',
          200: '#EFD79B',
          300: '#E5BE63',
          400: '#D9A23A',  // primario (dorado)
          500: '#C2862A',  // hover
          600: '#9E6A1E',
          700: '#7C5217',
          800: '#5E3E12',
          900: '#3D280B',
        },
        ink: {
          DEFAULT: '#1A3A5E',  // navy ancla del ecosistema
          soft: '#4A6584',
          muted: '#7D93AB',
        },
        crema: '#FAF7F1',      // crema cálida
      },
      boxShadow: {
        card: '0 1px 3px rgba(26,58,94,0.06), 0 8px 24px rgba(26,58,94,0.06)',
      },
    },
  },
  plugins: [],
};

export default config;
