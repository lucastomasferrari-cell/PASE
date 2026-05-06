import { Link } from 'react-router-dom';
import { Plus, Minus, X, ShoppingBag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatARS } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { CarritoItem } from '../carritoStore';

interface Props {
  open: boolean;
  onClose: () => void;
  items: CarritoItem[];
  subtotal: number;
  costoEnvio: number;
  total: number;
  tipoEntrega: 'retiro' | 'delivery';
  direccion: string;
  slug: string;
  onCantidad: (idx: number, delta: number) => void;
  onQuitar: (idx: number) => void;
}

// Carrito unificado: bottom sheet en mobile (slide-up), sidebar fijo
// derecho en desktop. Reutiliza el mismo markup, controlado por
// breakpoints tailwind (md:).
export function CarritoSheet({
  open, onClose, items, subtotal, costoEnvio, total,
  tipoEntrega, direccion, slug, onCantidad, onQuitar,
}: Props) {
  if (!open) return null;

  const itemsCount = items.reduce((s, x) => s + x.cantidad, 0);
  const ctaDeshabilitado = items.length === 0 || (tipoEntrega === 'delivery' && !direccion.trim());

  return (
    <div
      className="fixed inset-0 z-40 bg-black/40 md:bg-black/30 flex justify-end items-end md:items-stretch"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Carrito de compras"
    >
      <div
        className={cn(
          'bg-white w-full md:max-w-md md:h-full md:shadow-xl',
          'rounded-t-2xl md:rounded-none',
          'max-h-[85vh] md:max-h-none overflow-hidden flex flex-col',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
          <h2 className="text-lg font-medium">
            Tu pedido {itemsCount > 0 && <span className="text-foreground/60">({itemsCount})</span>}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="text-foreground/60 hover:text-foreground transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {items.length === 0 ? (
            <div className="text-center py-12">
              <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-gray-100 mb-4">
                <ShoppingBag className="h-7 w-7 text-gray-400" />
              </div>
              <p className="text-sm font-medium text-foreground">Tu pedido está vacío</p>
              <p className="text-sm text-foreground/60 mt-1">Agregá algo de la carta</p>
            </div>
          ) : (
            <ul className="space-y-4">
              {items.map((it, idx) => (
                <li key={`${it.item_id}-${idx}`} className="flex gap-3">
                  <div className="h-14 w-14 flex-shrink-0 rounded-lg bg-gray-100 flex items-center justify-center text-2xl">
                    {it.emoji ?? '🍽️'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-sm font-medium leading-snug text-foreground line-clamp-2">{it.nombre}</div>
                      <button
                        type="button"
                        onClick={() => onQuitar(idx)}
                        aria-label="Quitar"
                        className="text-foreground/40 hover:text-destructive transition-colors flex-shrink-0"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    {it.modificadores.length > 0 && (
                      <div className="text-xs text-foreground/60 mt-0.5">
                        {it.modificadores.map((m) => m.nombre).join(' · ')}
                      </div>
                    )}
                    {it.notas && <div className="text-xs italic text-foreground/60 mt-0.5">"{it.notas}"</div>}
                    <div className="flex items-center justify-between mt-2">
                      <div className="inline-flex items-center gap-2">
                        <Button
                          size="icon"
                          variant="outline"
                          className="h-7 w-7 rounded-full"
                          onClick={() => onCantidad(idx, -1)}
                          aria-label="Quitar uno"
                        >
                          <Minus className="h-3 w-3" />
                        </Button>
                        <span className="w-6 text-center text-sm font-medium">{it.cantidad}</span>
                        <Button
                          size="icon"
                          variant="outline"
                          className="h-7 w-7 rounded-full"
                          onClick={() => onCantidad(idx, +1)}
                          aria-label="Agregar uno"
                        >
                          <Plus className="h-3 w-3" />
                        </Button>
                      </div>
                      <div className="text-sm font-medium">
                        {formatARS((it.precio + it.modificadores.reduce((s, m) => s + (m.precio_extra ?? 0), 0)) * it.cantidad)}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        {items.length > 0 && (
          <div className="border-t border-gray-100 p-5 space-y-4 flex-shrink-0">
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between text-foreground/70">
                <span>Subtotal</span>
                <span>{formatARS(subtotal)}</span>
              </div>
              {costoEnvio > 0 && (
                <div className="flex justify-between text-foreground/70">
                  <span>Envío</span>
                  <span>{formatARS(costoEnvio)}</span>
                </div>
              )}
              <div className="flex justify-between text-base font-medium pt-2 border-t border-gray-100">
                <span>Total</span>
                <span>{formatARS(total)}</span>
              </div>
            </div>

            <Link
              to={ctaDeshabilitado ? '#' : `/tienda/${slug}/checkout`}
              onClick={(e) => {
                if (ctaDeshabilitado) {
                  e.preventDefault();
                  return;
                }
                onClose();
              }}
              aria-disabled={ctaDeshabilitado}
              className={cn(
                'block text-center w-full h-12 rounded-md font-medium leading-[3rem] transition-colors',
                ctaDeshabilitado
                  ? 'pointer-events-none bg-gray-100 text-gray-400'
                  : 'bg-primary text-primary-foreground hover:opacity-90',
              )}
            >
              Continuar pedido
            </Link>
            {tipoEntrega === 'delivery' && !direccion.trim() && (
              <p className="text-xs text-destructive text-center">
                Cargá tu dirección antes de continuar.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
