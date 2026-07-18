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
        // Fondo del sistema — retuneado 1:1 a los tokens de cocina.os
        // (--bg-command / --card-bg / --border-dim). Ver globals.css :root.
        carbon: {
          900: '#060912',  // --bg-command : fondo raíz (app shell)
          800: '#0D1425',  // --card-bg    : paneles (status bar, dropdowns)
          700: '#0F1A2E',  // hover elevado
          600: '#162035',  // --border-dim : hairlines / borders sutiles
          500: '#1E293B',  // slate-800    : borders visibles + inputs
        },
        // Celeste PASE (--pase-celeste = #75AADB).
        brand: {
          50:  '#F4F9FD',
          100: '#EAF3FB',
          200: '#D7E8F5',
          300: '#9DC3E2',
          400: '#75AADB',  // primario (--pase-celeste)
          500: '#5A8FC2',
          600: '#4A78A6',
          700: '#3A608A',
          800: '#2A4870',
          900: '#1A3A5E',
        },
        // Dorado — uso RESTRINGIDO (System Live, cursor, punto del logo).
        gold: {
          DEFAULT: '#F5C518',  // --pase-gold
          soft:    '#FBE8A0',
          dim:     '#B08A00',
        },
        // Grises slate azulados (--text-dim / --text-bright).
        dim: {
          50:  '#F8FAFC',   // --text-bright : texto principal
          100: '#CBD5E1',   // slate-300
          200: '#94A3B8',   // --text-dim    : texto secundario
          300: '#94A3B8',   // --text-dim    : labels / meta
          400: '#64748B',   // slate-500     : texto apagado
          500: '#475569',   // slate-600     : bordes / disabled
        },
        // Semánticos.
        live: '#10b981',    // --status-green : estado operativo (ACTIVE/ONLINE)
        warn: '#FBBF24',    // ámbar
        crit: '#F87171',    // rojo suave
        // Alias legacy.
        ink:   { DEFAULT: '#F8FAFC', soft: '#94A3B8', muted: '#64748B' },
        crema: '#0D1425',
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
