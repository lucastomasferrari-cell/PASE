// Pantalla admin: moderación de reseñas del marketplace.
//
// Lucas 2026-05-19: el dueño/admin ve TODAS las reseñas (publicadas +
// ocultas + reportadas) de su tenant y puede:
//   - Cambiar estado de publicada ↔ oculta (esconder ofensivas).
//   - Marcar como reportada (para revisar después).
//   - Ver el detalle del pedido asociado.

import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Eye, EyeOff, Flag, ExternalLink, Filter, RefreshCw } from 'lucide-react';
import { db } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StarRating } from '@/components/StarRating';

type Estado = 'publicada' | 'oculta' | 'reportada';

interface ReviewAdmin {
  id: string;
  tenant_id: string;
  local_id: number;
  venta_id: number;
  autor_nombre: string;
  autor_telefono: string;
  autor_email: string | null;
  rating: number;
  comentario: string | null;
  moderacion_estado: Estado;
  moderacion_motivo: string | null;
  created_at: string;
  moderado_at: string | null;
  local?: { nombre: string };
}

const ESTADOS_LABEL: Record<Estado | 'todos', string> = {
  todos: 'Todos',
  publicada: 'Publicadas',
  oculta: 'Ocultas',
  reportada: 'Reportadas',
};

export function ResenasAdmin() {
  const [reviews, setReviews] = useState<ReviewAdmin[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtroEstado, setFiltroEstado] = useState<Estado | 'todos'>('todos');

  const load = useCallback(async () => {
    setLoading(true);
    let q = db
      .from('marketplace_reviews')
      .select('*, local:locales(nombre)')
      .order('created_at', { ascending: false })
      .limit(200);
    if (filtroEstado !== 'todos') {
      q = q.eq('moderacion_estado', filtroEstado);
    }
    const { data, error } = await q;
    if (error) {
      toast.error('Error cargando reseñas: ' + error.message);
      setLoading(false);
      return;
    }
    setReviews((data as ReviewAdmin[]) ?? []);
    setLoading(false);
  }, [filtroEstado]);

  useEffect(() => { void load(); }, [load]);

  async function moderar(reviewId: string, nuevoEstado: Estado, motivo?: string) {
    const { error } = await db.rpc('fn_moderar_review', {
      p_review_id: reviewId,
      p_nuevo_estado: nuevoEstado,
      p_motivo: motivo ?? null,
    });
    if (error) {
      toast.error('Error: ' + error.message);
      return;
    }
    toast.success(
      nuevoEstado === 'publicada' ? 'Reseña publicada' :
      nuevoEstado === 'oculta' ? 'Reseña ocultada' : 'Reseña marcada como reportada',
    );
    void load();
  }

  const counts = {
    todos: reviews.length,
    publicada: reviews.filter(r => r.moderacion_estado === 'publicada').length,
    oculta: reviews.filter(r => r.moderacion_estado === 'oculta').length,
    reportada: reviews.filter(r => r.moderacion_estado === 'reportada').length,
  };

  return (
    <div className="container py-6 max-w-5xl">
      <header className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reseñas</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Opiniones de clientes que pidieron por el marketplace. Si una reseña es ofensiva,
            podés ocultarla y deja de aparecer en la tienda pública.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={filtroEstado} onValueChange={(v) => setFiltroEstado(v as Estado | 'todos')}>
            <SelectTrigger className="w-[170px] h-9">
              <Filter className="h-3.5 w-3.5 mr-1.5" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todas ({counts.todos})</SelectItem>
              <SelectItem value="publicada">Publicadas ({counts.publicada})</SelectItem>
              <SelectItem value="oculta">Ocultas ({counts.oculta})</SelectItem>
              <SelectItem value="reportada">Reportadas ({counts.reportada})</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => void load()} className="h-9">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </header>

      {loading ? (
        <div className="text-sm text-muted-foreground py-12 text-center">Cargando…</div>
      ) : reviews.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <p className="text-base font-medium">
              {filtroEstado === 'todos'
                ? 'Aún no hay reseñas'
                : `No hay reseñas en estado "${ESTADOS_LABEL[filtroEstado]}"`}
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              Cuando los clientes terminen sus pedidos y dejen opiniones, aparecen acá.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {reviews.map((r) => (
            <Card key={r.id} className={r.moderacion_estado === 'oculta' ? 'opacity-60' : ''}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{r.autor_nombre}</span>
                      <StarRating value={r.rating} size="sm" />
                      <span className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider bg-muted text-muted-foreground">
                        {ESTADOS_LABEL[r.moderacion_estado]}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {r.local?.nombre} · pedido #{r.venta_id} · {new Date(r.created_at).toLocaleString('es-AR')}
                    </div>
                  </div>
                  <Link
                    to={`/pos/venta/${r.venta_id}`}
                    className="text-xs text-primary hover:underline flex items-center gap-1 shrink-0"
                    target="_blank"
                  >
                    Ver pedido
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                </div>
                {r.comentario && (
                  <p className="text-sm text-foreground/80 italic mt-2 mb-3 leading-relaxed">
                    "{r.comentario}"
                  </p>
                )}
                <div className="text-xs text-muted-foreground mb-3">
                  📞 {r.autor_telefono}
                  {r.autor_email && <> · ✉ {r.autor_email}</>}
                </div>
                <div className="flex gap-2 flex-wrap">
                  {r.moderacion_estado !== 'publicada' && (
                    <Button size="sm" variant="outline" onClick={() => moderar(r.id, 'publicada')} className="h-8 gap-1.5">
                      <Eye className="h-3.5 w-3.5" />
                      Publicar
                    </Button>
                  )}
                  {r.moderacion_estado !== 'oculta' && (
                    <Button size="sm" variant="outline" onClick={() => {
                      const motivo = window.prompt('Motivo para ocultar (opcional, queda registrado):');
                      if (motivo === null) return;  // canceló
                      void moderar(r.id, 'oculta', motivo || undefined);
                    }} className="h-8 gap-1.5">
                      <EyeOff className="h-3.5 w-3.5" />
                      Ocultar
                    </Button>
                  )}
                  {r.moderacion_estado !== 'reportada' && (
                    <Button size="sm" variant="outline" onClick={() => moderar(r.id, 'reportada')} className="h-8 gap-1.5 text-orange-600 hover:text-orange-700">
                      <Flag className="h-3.5 w-3.5" />
                      Marcar para revisar
                    </Button>
                  )}
                </div>
                {r.moderacion_motivo && (
                  <div className="mt-2 text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1">
                    Motivo: {r.moderacion_motivo}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export default ResenasAdmin;
