// Primitivos del sistema Accesos — estética Command Center.
// Se importan con `@/components/primitives`. Todo lo que no vive acá se
// construye inline en las páginas.

import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, LabelHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';

// ─── helpers ────────────────────────────────────────────────────────────────
export function cn(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(' ');
}

// ─── StatusDot ──────────────────────────────────────────────────────────────
// Puntito con halo — semáforo del sistema. `live` es el más común (verde neón
// con pulso). Ver la barra de estado del header.
type DotTone = 'live' | 'warn' | 'crit' | 'off' | 'gold' | 'brand';
const DOT_TONE: Record<DotTone, string> = {
  live:  'bg-live shadow-live',
  warn:  'bg-warn',
  crit:  'bg-crit',
  off:   'bg-dim-400',
  gold:  'bg-gold shadow-gold',
  brand: 'bg-brand-400 shadow-glow',
};
export function StatusDot({ tone = 'live', pulse = false, className }: { tone?: DotTone; pulse?: boolean; className?: string }) {
  return (
    <span className={cn('relative inline-flex h-2 w-2 items-center justify-center', className)}>
      {pulse && tone !== 'off' && (
        <span className={cn('absolute inset-0 rounded-full opacity-60 animate-ping', DOT_TONE[tone].split(' ')[0])} />
      )}
      <span className={cn('relative h-2 w-2 rounded-full', DOT_TONE[tone])} />
    </span>
  );
}

// ─── Card ───────────────────────────────────────────────────────────────────
// Tarjeta base carbon con borde tenue. `interactive` agrega hover celeste.
export function Card({
  as: Tag = 'div',
  interactive,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLElement> & { as?: 'div' | 'section' | 'article' | 'button' | 'a'; interactive?: boolean }) {
  const Component = Tag as 'div';
  return (
    <Component
      className={cn(
        'bg-carbon-800 border border-carbon-600 rounded-lg shadow-card',
        interactive && 'transition-colors hover:border-brand-400/50 hover:bg-carbon-700 cursor-pointer',
        className,
      )}
      {...rest}
    >
      {children}
    </Component>
  );
}

// ─── Button ─────────────────────────────────────────────────────────────────
type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'terminal';
type BtnSize = 'sm' | 'md' | 'lg';

const BTN_VARIANT: Record<BtnVariant, string> = {
  primary: 'bg-brand-400 text-carbon-900 font-medium hover:bg-brand-300 shadow-glow',
  secondary: 'bg-carbon-700 text-dim-50 border border-carbon-500 hover:border-brand-400 hover:text-brand-300',
  ghost: 'bg-transparent text-dim-100 hover:text-dim-50 hover:bg-carbon-700',
  danger: 'bg-crit/20 text-crit border border-crit/40 hover:bg-crit/30',
  terminal: 'bg-carbon-800 text-brand-300 font-mono uppercase tracking-widest2 border border-brand-400/40 hover:border-brand-400 hover:bg-carbon-700',
};
const BTN_SIZE: Record<BtnSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9 px-4 text-sm',
  lg: 'h-11 px-5 text-sm',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: BtnSize; leftIcon?: ReactNode; rightIcon?: ReactNode }
>(function Button({ variant = 'primary', size = 'md', leftIcon, rightIcon, className, children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md transition-all disabled:opacity-50 disabled:cursor-not-allowed',
        BTN_VARIANT[variant],
        BTN_SIZE[size],
        className,
      )}
      {...rest}
    >
      {leftIcon}
      {children}
      {rightIcon}
    </button>
  );
});

// ─── Label + Field ──────────────────────────────────────────────────────────
export function Label({ className, children, ...rest }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={cn('label-sys block mb-1.5', className)} {...rest}>
      {children}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'w-full h-10 px-3 rounded-md bg-carbon-900 border border-carbon-500 text-dim-50 placeholder:text-dim-400',
          'font-mono text-sm',
          'transition-colors focus:outline-none focus:border-brand-400 focus:bg-carbon-800',
          className,
        )}
        {...rest}
      />
    );
  },
);

// ─── Chip / Pill ────────────────────────────────────────────────────────────
type ChipTone = 'default' | 'brand' | 'live' | 'warn' | 'gold' | 'off';
const CHIP_TONE: Record<ChipTone, string> = {
  default: 'bg-carbon-700 text-dim-100 border border-carbon-500',
  brand:   'bg-brand-400/15 text-brand-300 border border-brand-400/40',
  live:    'bg-live/15 text-live border border-live/40',
  warn:    'bg-warn/15 text-warn border border-warn/40',
  gold:    'bg-gold/15 text-gold border border-gold/40',
  off:     'bg-carbon-700 text-dim-400 border border-carbon-600',
};
export function Chip({ tone = 'default', className, children }: { tone?: ChipTone; className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 h-6 px-2 rounded-full font-mono text-[10px] uppercase tracking-widest2',
        CHIP_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ─── Divider ────────────────────────────────────────────────────────────────
export function Divider({ label, className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex items-center gap-3 my-4', className)}>
      <span className="h-px flex-1 bg-carbon-600" />
      {label && <span className="label-sys mb-0">{label}</span>}
      <span className="h-px flex-1 bg-carbon-600" />
    </div>
  );
}

// ─── SectionHeader ──────────────────────────────────────────────────────────
// Título de página / sección grande. Sigue el patrón "01 // SECCIÓN".
export function SectionHeader({
  number,
  title,
  subtitle,
  right,
}: {
  number?: string;
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div>
        <div className="flex items-baseline gap-3">
          {number && <span className="font-mono text-xs text-brand-400 tracking-widest2">{number} //</span>}
          <h1 className="text-2xl font-semibold text-dim-50 tracking-tight">{title}</h1>
        </div>
        {subtitle && <p className="text-sm text-dim-200 mt-1">{subtitle}</p>}
      </div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
}
