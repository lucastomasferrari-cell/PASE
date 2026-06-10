import type { Config } from 'tailwindcss';

// MESA — identidad visual propia: hospitalidad cálida (referencia "Coral
// hospitalario" de las referencias visuales del ecosistema + el mix
// Blackbird/Tock/Meitre que eligió Lucas). El design system completo se
// define en el sprint visual de la página pública — esto es la base.
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
          50: '#fff5f2',
          100: '#ffe6df',
          200: '#ffc9bb',
          300: '#ffa48c',
          400: '#ff7a5c',
          500: '#f25b3f',  // coral MESA
          600: '#d9432a',
          700: '#b5331f',
          800: '#922b1d',
          900: '#78281e',
        },
        ink: {
          DEFAULT: '#1d1a17',
          soft: '#5c554e',
          muted: '#8a8178',
        },
        crema: '#faf7f3',
      },
    },
  },
  plugins: [],
};

export default config;
