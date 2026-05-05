import type { ReactNode } from 'react';
import { Badge as ShadcnBadge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

// Badge legacy (Sprint 1) — mantiene API con variant string color para evitar
// migrar todos los call sites. Mapea cada variant al token semántico
// equivalente para que respete light/dark.

type Variant = 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'violet';

const VARIANT_CLASSES: Record<Variant, string> = {
  gray:   'bg-muted text-muted-foreground border-border',
  green:  'bg-success/10 text-success border-success/20',
  red:    'bg-destructive/10 text-destructive border-destructive/20',
  amber:  'bg-warning/10 text-warning border-warning/30',
  blue:   'bg-primary/10 text-primary border-primary/20',
  violet: 'bg-accent text-accent-foreground border-border',
};

export interface BadgeProps {
  children: ReactNode;
  variant?: Variant;
  title?: string;
}

export function Badge({ children, variant = 'gray', title }: BadgeProps) {
  return (
    <ShadcnBadge
      variant="outline"
      title={title}
      className={cn('font-medium', VARIANT_CLASSES[variant])}
    >
      {children}
    </ShadcnBadge>
  );
}
