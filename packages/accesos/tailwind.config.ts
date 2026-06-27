import type { Config } from 'tailwindcss';

/**
 * Accesos — admin del dueño (personas y permisos).
 * Paleta alineada con PASE: celeste IRAM 7677-2002 + dorado restringido + navy.
 * (Originalmente morado/violeta — migrado para que todo el ecosistema Cocina
 * comparta la misma identidad visual.)
 */
const config: Config = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1.5rem', screens: { '2xl': '1200px' } },
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        brand: {
          50:  '#F4F9FD',  // pase-bg-soft light
          100: '#EAF3FB',  // pase-celeste-100
          200: '#D7E8F5',  // pase-celeste-200
          300: '#9DC3E2',  // pase-celeste-300
          400: '#75AADB',  // pase-celeste — primario (IRAM 7677-2002)
          500: '#5A8FC2',  // hover (más oscuro)
          600: '#4A78A6',
          700: '#3A608A',
          800: '#2A4870',
          900: '#1A3A5E',  // pase-text
        },
        ink:   { DEFAULT: '#1A3A5E', soft: '#4A6584', muted: '#7D93AB' },
        gold:  '#F5C518',  // pase-gold — uso restringido (logo dot + indicador "en vivo")
        crema: '#FAF6EC',  // pase-crema (cálido opcional)
      },
      boxShadow: { card: '0 1px 3px rgba(26,58,94,0.06), 0 8px 24px rgba(26,58,94,0.06)' },
    },
  },
  plugins: [],
};

export default config;
