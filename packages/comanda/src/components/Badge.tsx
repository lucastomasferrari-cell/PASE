import type { ReactNode } from 'react';

type Variant = 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'violet';

const COLORS: Record<Variant, { bg: string; fg: string; border: string }> = {
  gray:   { bg: '#F3F4F6', fg: '#374151', border: '#D1D5DB' },
  green:  { bg: '#D1FAE5', fg: '#065F46', border: '#6EE7B7' },
  red:    { bg: '#FEE2E2', fg: '#991B1B', border: '#FCA5A5' },
  amber:  { bg: '#FEF3C7', fg: '#92400E', border: '#FCD34D' },
  blue:   { bg: '#DBEAFE', fg: '#1E40AF', border: '#93C5FD' },
  violet: { bg: '#EDE9FE', fg: '#5B21B6', border: '#C4B5FD' },
};

export interface BadgeProps {
  children: ReactNode;
  variant?: Variant;
  title?: string;
}

export function Badge({ children, variant = 'gray', title }: BadgeProps) {
  const c = COLORS[variant];
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 500,
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.border}`,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}
