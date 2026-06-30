import { useState, useEffect, type ReactNode } from 'react';
import { Sun, Moon } from 'lucide-react';

// ── Login unificado del ecosistema Cocina ───────────────────────────────────
// Mismo patrón visual en PASE / COMANDA / MESA / Habitué: celeste PASE,
// tamaños/márgenes/tipografía idénticos, toggle dark/light. Cada app solo
// cambia el nombre y el subtítulo. Self-contained (valores hex explícitos)
// para verse igual sin depender de los tokens de Tailwind de cada paquete.

const THEME_KEY = 'cocina_theme';

function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState<boolean>(() => {
    try {
      const s = localStorage.getItem(THEME_KEY);
      if (s === 'dark') return true;
      if (s === 'light') return false;
    } catch { /* private mode */ }
    return typeof window !== 'undefined'
      && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  });
  useEffect(() => {
    const root = document.documentElement;
    if (dark) root.classList.add('dark'); else root.classList.remove('dark');
    try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch { /* idem */ }
  }, [dark]);
  return [dark, () => setDark((d) => !d)];
}

// Clases compartidas — exportadas para que el form de cada app las reuse.
export const loginLabelCls =
  'block text-sm font-medium text-[#1A3A5E] dark:text-[#F0F4F8] mb-1.5';
export const loginInputCls =
  'w-full h-11 rounded-lg border border-[#D0DCEA] dark:border-[#3F4D6E] '
  + 'bg-white dark:bg-[#0C1220] px-3.5 text-sm text-[#1A3A5E] dark:text-[#F0F4F8] '
  + 'placeholder:text-[#9DB2CC] dark:placeholder:text-[#6E8CAB] outline-none '
  + 'focus:border-[#75AADB] focus:ring-2 focus:ring-[#75AADB]/25 transition';
export const loginBtnCls =
  'w-full h-11 rounded-lg bg-[#75AADB] hover:bg-[#5f97cc] active:bg-[#5589bd] '
  + 'text-white text-sm font-medium transition-colors disabled:opacity-60 '
  + 'disabled:cursor-not-allowed';

interface Props {
  appName: string;
  subtitle: string;
  children: ReactNode;
}

export function LoginCard({ appName, subtitle, children }: Props) {
  const [dark, toggle] = useTheme();
  return (
    <div className="min-h-screen grid place-items-center px-4 bg-[#EFF3F8] dark:bg-[#0C1220]">
      <div className="relative w-full max-w-[400px] rounded-2xl border border-[#E0EAF4] dark:border-[#2A3550] bg-white dark:bg-[#1A2540] shadow-[0_2px_4px_rgba(26,58,94,0.04),0_4px_16px_rgba(26,58,94,0.08)] p-8">
        <button
          type="button"
          onClick={toggle}
          aria-label={dark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
          className="absolute top-4 right-4 grid place-items-center h-8 w-8 rounded-lg text-[#6E8CAB] dark:text-[#93A8C2] hover:bg-[#EAF3FB] dark:hover:bg-[#1E3155] transition-colors"
        >
          {dark ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
        </button>
        <div className="mb-6">
          <div className="text-[26px] leading-none font-medium tracking-tight text-[#1A3A5E] dark:text-[#F0F4F8]">
            {appName}<span className="text-[#F5C518]">.</span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-[#6E8CAB] dark:text-[#93A8C2]">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  );
}
