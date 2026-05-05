import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  desdeIso: string;
  // Umbrales (minutos). Default 10/20 para pedidos online.
  warningAt?: number;
  dangerAt?: number;
  className?: string;
}

// Timer dinámico MM:SS con semáforo color. Refresca cada segundo.
// Sub 10 min = success, 10-20 min = warning, > 20 min = danger.
export function UrgencyTimer({ desdeIso, warningAt = 10, dangerAt = 20, className }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const desde = new Date(desdeIso).getTime();
  const elapsedMs = Math.max(0, now - desde);
  const totalSec = Math.floor(elapsedMs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  const text = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;

  const tone = min >= dangerAt ? 'danger' : min >= warningAt ? 'warning' : 'success';
  const tones: Record<typeof tone, string> = {
    success: 'text-success',
    warning: 'text-warning',
    danger:  'text-destructive',
  };

  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium tabular-nums', tones[tone], className)}>
      <Clock className="h-3 w-3" />
      {text}
    </span>
  );
}
