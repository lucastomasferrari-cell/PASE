import { useEffect, useState } from 'react';
import { Store, Layers } from 'lucide-react';
import { listLocalesAccesibles, type LocalSimple } from '@/services/configService';
import { type CatalogoScope, useCatalogoScope } from '@/lib/catalogoScope';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface Props {
  /** Se llama cuando cambia el alcance, para que la vista recargue. */
  onChange?: (scope: CatalogoScope) => void;
  className?: string;
}

/**
 * Selector de alcance del catálogo: "Menú maestro (marca)" o una sucursal.
 * Compartido entre las pestañas de Catálogo vía localStorage (useCatalogoScope).
 */
export function CatalogoScopeSelector({ onChange, className }: Props) {
  const [scope, setScope] = useCatalogoScope();
  const [locales, setLocales] = useState<LocalSimple[]>([]);

  useEffect(() => {
    listLocalesAccesibles().then((r) => setLocales(r.data));
  }, []);

  const value = scope === 'maestro' ? 'maestro' : String(scope);

  return (
    <Select
      value={value}
      onValueChange={(v) => {
        const next: CatalogoScope = v === 'maestro' ? 'maestro' : Number(v);
        setScope(next);
        onChange?.(next);
      }}
    >
      <SelectTrigger className={className ?? 'w-[240px] h-11'}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="maestro">
          <span className="flex items-center gap-2">
            <Layers className="h-4 w-4" />
            Menú maestro (marca)
          </span>
        </SelectItem>
        {locales.map((l) => (
          <SelectItem key={l.id} value={String(l.id)}>
            <span className="flex items-center gap-2">
              <Store className="h-4 w-4" />
              {l.nombre}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
