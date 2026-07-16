import { useEffect, useState } from 'react';
import { Store, Layers } from 'lucide-react';
import { listLocalesAccesibles, type LocalSimple } from '@/services/configService';
import { type CatalogoScope, useCatalogoScope } from '@/lib/catalogoScope';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface Props {
  /** Se llama cuando cambia el alcance, para que la vista recargue. */
  onChange?: (scope: CatalogoScope) => void;
  className?: string;
  /**
   * Si true, oculta la opción "Menú maestro (marca)" del dropdown. Se usa en
   * las páginas de sucursal (/menu/items etc) — el maestro solo se edita
   * desde /menu/maestro/* (permiso dueño), no desde acá. Y si el scope
   * activo era 'maestro' al entrar, lo cambia automáticamente a la primera
   * sucursal disponible.
   */
  hideMaestro?: boolean;
}

/**
 * Selector de alcance del catálogo: "Menú maestro (marca)" o una sucursal.
 * Compartido entre las pestañas de Catálogo vía localStorage (useCatalogoScope).
 */
export function CatalogoScopeSelector({ onChange, className, hideMaestro }: Props) {
  const [scope, setScope] = useCatalogoScope();
  const [locales, setLocales] = useState<LocalSimple[]>([]);

  useEffect(() => {
    listLocalesAccesibles().then((r) => setLocales(r.data));
  }, []);

  // Con hideMaestro (páginas de sucursal): si el scope actual era 'maestro',
  // lo movemos al primer local disponible para que la UI no quede huérfana.
  useEffect(() => {
    if (hideMaestro && scope === 'maestro' && locales.length > 0) {
      const first = locales[0]!.id;
      setScope(first);
      onChange?.(first);
    }
  }, [hideMaestro, scope, locales, setScope, onChange]);

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
        {!hideMaestro && (
          <SelectItem value="maestro">
            <span className="flex items-center gap-2">
              <Layers className="h-4 w-4" />
              Menú maestro (marca)
            </span>
          </SelectItem>
        )}
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
