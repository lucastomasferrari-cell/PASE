import type { Config } from 'tailwindcss';

/**
 * Paleta alineada con PASE — usa el dark mode "Argentina 2006" canónico
 * (graphite-blue + celeste IRAM 7677-2002 + dorado restringido).
 * El namespace `admin-*` se mantiene para no romper las clases existentes,
 * pero los valores ahora son los de PASE.
 */
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        admin: {
          // Base — paleta "Argentina 2006" idéntica a dark mode de PASE
          bg:           '#0C1220',  // canvas
          surface:      '#1A2540',  // cards / panels
          'surface-2':  '#2A3550',  // chips / secciones
          border:       '#2A3550',  // hairlines
          'border-strong': '#3F4D6E',
          text:         '#F0F4F8',  // primary
          muted:        '#93A8C2',  // muted text

          // Acentos de marca — únicos celestes/dorados permitidos
          accent:       '#75AADB',  // pase-celeste (IRAM 7677-2002)
          'accent-100': '#1E3155',  // hover/active backgrounds (dark)
          'accent-300': '#4A6FA8',  // sparkline / mid
          gold:         '#F5C518',  // SOLO logo dot + indicador "en vivo"

          // Estados funcionales — alineados con --success/--warn/--danger de PASE
          success:      '#2C7A55',
          warn:         '#D97706',
          danger:       '#B91C1C',
        },
      },
    },
  },
  plugins: [],
};

export default config;
