import { cn } from '@/lib/utils';

// Coloración por canal (no para todos los datos del POS — solo para
// orígenes de pedidos online). Los slugs canónicos vienen del seed Sprint 1.
const CANAL_COLORS: Record<string, string> = {
  rappi:             'bg-red-100 text-red-900 border-red-200 dark:bg-red-900/30 dark:text-red-100 dark:border-red-800',
  'pedidos-ya':      'bg-purple-100 text-purple-900 border-purple-200 dark:bg-purple-900/30 dark:text-purple-100 dark:border-purple-800',
  whatsapp:          'bg-green-100 text-green-900 border-green-200 dark:bg-green-900/30 dark:text-green-100 dark:border-green-800',
  'tienda-propia':   'bg-orange-100 text-orange-900 border-orange-200 dark:bg-orange-900/30 dark:text-orange-100 dark:border-orange-800',
  salon:             'bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-900/30 dark:text-amber-100 dark:border-amber-800',
  mostrador:         'bg-blue-100 text-blue-900 border-blue-200 dark:bg-blue-900/30 dark:text-blue-100 dark:border-blue-800',
  'menu-qr':         'bg-pink-100 text-pink-900 border-pink-200 dark:bg-pink-900/30 dark:text-pink-100 dark:border-pink-800',
};

const FALLBACK = 'bg-muted text-muted-foreground border-border';

interface Props {
  slug: string;
  label?: string;
  emoji?: string | null;
}

export function CanalBadge({ slug, label, emoji }: Props) {
  const cls = CANAL_COLORS[slug] ?? FALLBACK;
  return (
    <span className={cn(
      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full border font-medium text-xs',
      cls,
    )}>
      {emoji && <span>{emoji}</span>}
      {label ?? slug}
    </span>
  );
}
