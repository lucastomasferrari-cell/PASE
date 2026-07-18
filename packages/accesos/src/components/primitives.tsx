// Primitivos del sistema Accesos — estética Command Center.
// Se importan con `@/components/primitives`. Todo lo que no vive acá se
// construye inline en las páginas.

import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, LabelHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';

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

// ─── Card / Row ─────────────────────────────────────────────────────────────
// Refactor 17-jul: Cocina NO usa bento cards con bordes redondeados —
// usa hairlines horizontales como separador (patrón terminal listing).
// - Card contenedor: sin fondo ni border, solo un `border-t` opcional para
//   marcar el arranque de una sección.
// - Row: fila con `border-b` para el separador entre items de una lista.
// `interactive` agrega hover con tinte celeste sutil, sin cambiar el borde.
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
        'border-t border-carbon-600',
        interactive && 'transition-colors hover:bg-brand-400/[0.03] cursor-pointer',
        className,
      )}
      {...rest}
    >
      {children}
    </Component>
  );
}

export function Row({
  interactive,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cn(
        'border-b border-carbon-600 py-3.5 px-1',
        interactive && 'transition-colors hover:bg-brand-400/[0.04] cursor-pointer',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

// ─── Button ─────────────────────────────────────────────────────────────────
type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'terminal';
type BtnSize = 'sm' | 'md' | 'lg';

// Refactor 17-jul: Cocina usa botones outline (no sólidos). El fondo relleno
// sólo se justifica en el CTA supercrítico (variant `solid`, uso restringido).
// Bordes rectos con radios chicos (rounded-sm = 2px).
const BTN_VARIANT: Record<BtnVariant, string> = {
  // Outline celeste — es el CTA principal en Cocina.
  primary: 'bg-transparent text-brand-300 border-0 hover:border-brand-400 hover:bg-brand-400/10 hover:text-brand-200',
  // Neutro con border sutil.
  secondary: 'bg-transparent text-dim-100 border-b border-carbon-600 hover:border-carbon-500 hover:bg-carbon-700 hover:text-dim-50',
  // Sin borde ni fondo — solo texto.
  ghost: 'bg-transparent text-dim-200 hover:text-dim-50 hover:bg-carbon-700/60',
  // Crítica (borrar, revocar).
  danger: 'bg-transparent text-crit border-0 hover:bg-crit/10 hover:border-crit',
  // Estilo consola con label uppercase mono (para "Ejecutar ingreso"/"Ejecutar acción").
  terminal: 'bg-transparent text-brand-300 font-mono uppercase tracking-widest2 text-xs border-0 hover:border-brand-400 hover:bg-brand-400/10',
};
const BTN_SIZE: Record<BtnSize, string> = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-8 px-3 text-xs',
  lg: 'h-10 px-4 text-sm',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: BtnSize; leftIcon?: ReactNode; rightIcon?: ReactNode }
>(function Button({ variant = 'primary', size = 'md', leftIcon, rightIcon, className, children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed',
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
          'w-full h-10 px-3 rounded-md bg-carbon-900 border-b border-carbon-600 text-dim-50 placeholder:text-dim-400',
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
// Cocina.OS: pill RELLENO sutil slate, esquinas redondeadas, mono 9px. Es el
// chip de categoría de las filas (DUENO, ENCARGADO, SECURITY, ...).
type ChipTone = 'default' | 'brand' | 'live' | 'warn' | 'gold' | 'off';
const CHIP_TONE: Record<ChipTone, string> = {
  default: 'text-dim-300',
  brand:   'text-brand-300',
  live:    'text-live',
  warn:    'text-warn',
  gold:    'text-gold',
  off:     'text-dim-400',
};
export function Chip({ tone = 'default', className, children }: { tone?: ChipTone; className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-tighter bg-slate-900/50 px-2 py-0.5 rounded',
        CHIP_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ─── IconBox ──────────────────────────────────────────────────────────────────
// Cuadrado celeste tenue que encabeza una fila (o una tarjeta). Copiado de la
// `.icon-box` de cocina.os. `muted` = estado inactivo (gris + grayscale).
export function IconBox({
  children, muted, className,
}: { children: ReactNode; muted?: boolean; className?: string }) {
  return (
    <div
      className={cn(
        'w-9 h-9 flex-shrink-0 flex items-center justify-center rounded border',
        muted ? 'border-slate-700/50 grayscale text-slate-500' : 'icon-box border-brand-400/20',
        className,
      )}
    >
      {children}
    </div>
  );
}

// ─── SystemRow ────────────────────────────────────────────────────────────────
// Fila de lista — el patrón CENTRAL del look cocina.os. Estructura:
//   [icon-box] · [title + suffix / description] · [chip · status] · [kbd · chevron]
// Toda la fila es clickeable (→ abrir/editar). `actions` inserta botones extra
// (ej. toggle activo, reset) antes del chevron; se puede ocultar el chevron.
type RowStatus = { label: string; tone?: 'active' | 'inactive' };
export function SystemRow({
  icon, title, suffix, description, category, status, kbd, actions,
  muted, hideChevron, onClick, className,
}: {
  icon: ReactNode;
  title: ReactNode;
  suffix?: string;
  description?: ReactNode;
  category?: ReactNode;
  status?: RowStatus;
  kbd?: string;
  actions?: ReactNode;
  muted?: boolean;
  hideChevron?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'system-row group px-4 py-4 flex items-center gap-4 sm:gap-6',
        onClick && 'cursor-pointer',
        muted && 'opacity-50',
        className,
      )}
    >
      <IconBox muted={muted}>{icon}</IconBox>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-3">
          <h3 className="text-base font-semibold group-hover:text-brand-400 transition-colors truncate">{title}</h3>
          {suffix && <span className="font-mono text-[9px] text-dim-300 opacity-50 shrink-0">{suffix}</span>}
        </div>
        {description != null && <p className="text-xs text-dim-300 truncate">{description}</p>}
      </div>
      {(category || status) && (
        <div className="hidden md:flex items-center gap-6 shrink-0">
          {category && <div className="flex items-center gap-2">{category}</div>}
          {status && (
            <div className="flex items-center gap-2">
              <span className={status.tone === 'inactive' ? 'status-inactive' : 'status-active'} />
              <span className="font-mono text-[9px] text-dim-300">{status.label}</span>
            </div>
          )}
        </div>
      )}
      <div className="flex items-center gap-3 sm:gap-4 ml-2 sm:ml-4 shrink-0">
        {actions}
        {kbd && <span className="kbd-hint hidden sm:block">{kbd}</span>}
        {!hideChevron && (
          <ChevronRight className="h-4 w-4 text-brand-400 opacity-30 group-hover:opacity-100 transform group-hover:translate-x-1 transition-all" />
        )}
      </div>
    </div>
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

// ─── PageTitle ──────────────────────────────────────────────────────────────
// Título de página con "NN // Sección". Va DENTRO de la página (Cocina lo
// pone en el content, no en el header).
export function PageTitle({
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

// ─── SectionHeader ──────────────────────────────────────────────────────────
// Header de sección terminal-style: icono + código mono + label + count derecho
// + hairline horizontal completa. Se usa para separar bloques dentro de una
// página sin envolverlos en cajas. Ver mockup 17-jul.
export function SectionHeader({
  label,
  right,
  count,
  className,
}: {
  label: string;
  right?: ReactNode;
  count?: string | number;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-3 mb-6', className)}>
      <h2 className="font-mono text-[11px] font-semibold text-brand-400 tracking-[0.3em] uppercase whitespace-nowrap">{label}</h2>
      <div className="h-px flex-1 bg-gradient-to-r from-slate-800 to-transparent" />
      {count != null && <span className="font-mono text-[10px] text-dim-400 tracking-widest2">{String(count).padStart(2, '0')}</span>}
      {right}
    </div>
  );
}

// ─── MiniNote ───────────────────────────────────────────────────────────────
// Nota informativa con rail izquierdo celeste (o tono elegido), sin caja.
// Sustituye al patrón "info banner con fondo relleno" que se ve tipo bento.
export function MiniNote({
  tone = 'brand',
  children,
  className,
}: {
  tone?: 'brand' | 'warn' | 'live' | 'crit';
  children: ReactNode;
  className?: string;
}) {
  const rail =
    tone === 'brand' ? 'border-l-brand-400 bg-brand-400/[0.04]' :
    tone === 'warn'  ? 'border-l-warn bg-warn/[0.04]' :
    tone === 'live'  ? 'border-l-live bg-live/[0.04]' :
                       'border-l-crit bg-crit/[0.04]';
  return (
    <div className={cn(
      'flex items-start gap-3 px-3.5 py-2.5 border-l-2 text-[12.5px] text-dim-100 my-2',
      rail,
      className,
    )}>
      {children}
    </div>
  );
}
