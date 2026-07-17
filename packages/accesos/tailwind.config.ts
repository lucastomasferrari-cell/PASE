import type { Config } from 'tailwindcss';

/**
 * Accesos — panel del dueño (personas y permisos del ecosistema).
 *
 * Paleta "Command Center" (17-jul-2026) — misma familia que Cocina.
 *  - `carbon` = fondos oscuros (casi negros, con matiz frío).
 *  - `brand` = celeste PASE (IRAM 7677-2002) — acento primario, botones, links.
 *  - `gold`  = dorado — uso restringido (LIVE dot, destaque puntual).
 *  - `dim`   = escala de grises fríos para texto/borders sobre carbon.
 *
 * Antes (crema+celeste) → ahora (carbon+celeste) para alinearse con Cocina
 * y dar la impresión de "consola" técnica. Ver
 * [[project_accesos_rediseno_10_jul]].
 */
const config: Config = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1.5rem', screens: { '2xl': '1200px' } },
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        // Fondo del sistema — de más oscuro a "elevado".
        carbon: {
          900: '#060912',  // fondo raíz (app shell)
          800: '#0B1220',  // paneles (tarjetas grandes)
          700: '#131A2A',  // tarjetas / hover
          600: '#1B2338',  // borders sutiles + row hover
          500: '#242D45',  // borders visibles + inputs
        },
        // Celeste PASE — mismo del ecosistema.
        brand: {
          50:  '#F4F9FD',
          100: '#EAF3FB',
          200: '#D7E8F5',
          300: '#9DC3E2',
          400: '#75AADB',  // primario
          500: '#5A8FC2',
          600: '#4A78A6',
          700: '#3A608A',
          800: '#2A4870',
          900: '#1A3A5E',
        },
        // Dorado — uso RESTRINGIDO (logo dot, LIVE indicator, destacado puntual).
        gold: {
          DEFAULT: '#F5C518',
          soft:    '#FBE8A0',
          dim:     '#B08A00',
        },
        // Grises fríos — para labels, texto secundario, borders.
        dim: {
          50:  '#E6ECF5',   // texto principal sobre carbon
          100: '#C3CCDE',
          200: '#9AA5BF',
          300: '#7683A0',
          400: '#5B6884',
          500: '#3F4A63',
        },
        // Semánticos.
        live: '#4ADE80',    // verde neón: LIVE, activo, healthy
        warn: '#FBBF24',    // ámbar
        crit: '#F87171',    // rojo suave (no chillón sobre carbon)
        // Alias legacy (algunos componentes viejos referencian estos —
        // los mapeamos al nuevo sistema para no romper mientras migramos).
        ink:   { DEFAULT: '#E6ECF5', soft: '#9AA5BF', muted: '#5B6884' },
        crema: '#0B1220',
      },
      boxShadow: {
        // Sombras con matiz frío (halo celeste sutil sobre fondo oscuro).
        card:  '0 1px 0 rgba(255,255,255,0.02) inset, 0 8px 24px rgba(0,0,0,0.4)',
        glow:  '0 0 0 1px rgba(117,170,219,0.25), 0 0 24px rgba(117,170,219,0.12)',
        gold:  '0 0 12px rgba(245,197,24,0.35)',
        live:  '0 0 12px rgba(74,222,128,0.55)',
      },
      letterSpacing: {
        widest2: '0.2em',
      },
    },
  },
  plugins: [],
};

export default config;
