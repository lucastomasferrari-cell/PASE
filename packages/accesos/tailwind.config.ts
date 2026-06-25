import type { Config } from 'tailwindcss';

// Accesos — admin del dueño (personas y permisos). Paleta MORADA (admin/control),
// para diferenciarla del azul de MESA y el dorado de Habitué.
const config: Config = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1.5rem', screens: { '2xl': '1200px' } },
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['"Playfair Display"', 'Georgia', 'serif'],
      },
      colors: {
        brand: {
          50:  '#F5F3FF',
          100: '#EDE9FE',
          200: '#DDD6FE',
          300: '#C4B5FD',
          400: '#A78BFA',   // primario
          500: '#8B5CF6',   // hover
          600: '#7C3AED',
          700: '#6D28D9',
          800: '#5B21B6',
          900: '#4C1D95',
        },
        ink: { DEFAULT: '#1A3A5E', soft: '#4A6584', muted: '#7D93AB' },
        crema: '#F8F7FC',
      },
      boxShadow: { card: '0 1px 3px rgba(26,58,94,0.06), 0 8px 24px rgba(26,58,94,0.06)' },
    },
  },
  plugins: [],
};

export default config;
