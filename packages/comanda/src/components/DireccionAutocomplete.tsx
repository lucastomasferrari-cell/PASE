import { useEffect, useRef, useState } from 'react';
import { MapPin, Check, Loader2 } from 'lucide-react';
import { buscarDirecciones, type DireccionSugerida } from '@/services/direccionesService';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { cn } from '@/lib/utils';

interface Props {
  value: string;
  onChange: (texto: string, coords: { lat: number; lon: number } | null) => void;
  placeholder?: string;
  className?: string;
}

// Autocomplete de direcciones argentinas via GeoRef (gob.ar) — gratis sin API key.
// Mientras el cliente tipea, debounce 500ms + min 4 chars dispara búsqueda.
// Al seleccionar una sugerencia, devuelve texto + lat/lon del centroide.
//
// Si la dirección elegida tiene lat/lon, queda visualmente confirmada
// con un check verde. Si el cliente la edita manualmente después, se
// invalida (no estamos seguros de las coords).

export function DireccionAutocomplete({ value, onChange, placeholder, className }: Props) {
  const [input, setInput] = useState(value);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sugerencias, setSugerencias] = useState<DireccionSugerida[]>([]);
  const [validada, setValidada] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const debouncedInput = useDebouncedValue(input, 500);

  // Sync input con value externo (cuando se inicializa con dato guardado)
  useEffect(() => { setInput(value); }, [value]);

  // Buscar cuando cambia el input debounced
  useEffect(() => {
    if (debouncedInput.trim().length < 4) {
      setSugerencias([]);
      return;
    }
    // Si el input matchea una sugerencia ya elegida, no busques de nuevo
    if (validada && debouncedInput === value) return;

    let cancelled = false;
    setLoading(true);
    buscarDirecciones(debouncedInput).then((data) => {
      if (cancelled) return;
      setSugerencias(data);
      setLoading(false);
      if (data.length > 0) setOpen(true);
    });
    return () => { cancelled = true; };
  }, [debouncedInput, validada, value]);

  // Cerrar dropdown si click afuera
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  function elegir(sug: DireccionSugerida) {
    setInput(sug.texto);
    setOpen(false);
    setSugerencias([]);
    setValidada(true);
    const coords = sug.lat != null && sug.lon != null ? { lat: sug.lat, lon: sug.lon } : null;
    onChange(sug.texto, coords);
  }

  function handleInputChange(v: string) {
    setInput(v);
    setValidada(false);
    // Notificar al padre con el texto pero sin coords (todavía no confirmada)
    onChange(v, null);
  }

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <div className="relative">
        <MapPin className={cn(
          'absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 pointer-events-none',
          validada ? 'text-success' : 'text-muted-foreground',
        )} />
        <input
          type="text"
          value={input}
          onChange={(e) => handleInputChange(e.target.value)}
          onFocus={() => { if (sugerencias.length > 0) setOpen(true); }}
          placeholder={placeholder ?? 'Calle y altura, ej: Av. Corrientes 1234, CABA'}
          className={cn(
            'w-full h-11 pl-10 pr-10 rounded-md border bg-white text-sm',
            'focus:outline-none focus:border-gray-400',
            validada ? 'border-success/40' : 'border-gray-200',
          )}
          autoComplete="off"
        />
        {loading && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" />
        )}
        {!loading && validada && (
          <Check className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-success" />
        )}
      </div>

      {open && sugerencias.length > 0 && (
        <div className="absolute z-10 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-md shadow-lg max-h-64 overflow-y-auto">
          {sugerencias.map((sug) => (
            <button
              key={sug.id}
              type="button"
              onClick={() => elegir(sug)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 flex items-start gap-2 border-b border-gray-100 last:border-b-0"
            >
              <MapPin className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{sug.calle} {sug.altura ?? ''}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {sug.localidad}{sug.provincia ? `, ${sug.provincia}` : ''}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {validada && (
        <p className="text-[10px] text-success mt-1 flex items-center gap-1">
          <Check className="h-3 w-3" />
          Dirección validada — el repartidor sabe dónde es.
        </p>
      )}
    </div>
  );
}
