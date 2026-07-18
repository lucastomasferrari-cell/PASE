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
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        admin: {
          // Base — retuneado 1:1 a los tokens de cocina.os (ver index.css :root).
          bg:           '#060912',  // --bg-command : canvas
          surface:      '#0D1425',  // --card-bg    : cards / panels
          'surface-2':  '#0F1A2E',  // chips / secciones (hover elevado)
          border:       '#162035',  // --border-dim : hairlines
          'border-strong': '#1E293B',
          text:         '#F8FAFC',  // --text-bright : primary
          muted:        '#94A3B8',  // --text-dim    : muted text

          // Acentos de marca — únicos celestes/dorados permitidos
          accent:       '#75AADB',  // --pase-celeste (IRAM 7677-2002)
          'accent-100': '#12233B',  // hover/active backgrounds (dark)
          'accent-300': '#4A6FA8',  // sparkline / mid
          gold:         '#F5C518',  // --pase-gold : SOLO System Live + logo dot

          // Estados funcionales.
          success:      '#10b981',  // --status-green
          warn:         '#FBBF24',
          danger:       '#F87171',
        },
      },
    },
  },
  plugins: [],
};

export default config;
