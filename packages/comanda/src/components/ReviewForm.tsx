// Form para que el cliente deje review después de un pedido entregado.
// Aparece en TiendaConfirmacion cuando estado='entregada' o 'cobrada'.
//
// Flujo:
//   1. Cliente ve "¿Te gustó? Dejá tu opinión" + estrellas + textarea.
//   2. Submit → fn_crear_review_publica con phone+rating+comment.
//   3. Si ok: thank you + reseteo. Si ya existía: muestra la review previa.

import { useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { StarRating } from './StarRating';
import { crearReviewPublica } from '@/services/reviewsService';

interface Props {
  ventaId: number;
  telefono: string;
  email?: string | null;
}

export function ReviewForm({ ventaId, telefono, email }: Props) {
  const [rating, setRating] = useState(0);
  const [comentario, setComentario] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [enviada, setEnviada] = useState(false);
  const [reviewExistente, setReviewExistente] = useState<{ rating: number; comentario: string | null } | null>(null);

  async function enviar() {
    if (rating < 1) {
      toast.error('Elegí una calificación (1 a 5 estrellas)');
      return;
    }
    setEnviando(true);
    const { reviewId, yaExistia, error } = await crearReviewPublica({
      ventaId,
      telefono,
      rating,
      comentario: comentario.trim() || null,
      email: email || null,
    });
    setEnviando(false);
    if (error || !reviewId) {
      toast.error('No se pudo enviar tu opinión', { description: error ?? 'Error desconocido' });
      return;
    }
    if (yaExistia) {
      toast.info('Ya habías dejado una opinión sobre este pedido', {
        description: 'Te mostramos la que ya enviaste.',
      });
      setReviewExistente({ rating, comentario: comentario.trim() || null });
    } else {
      toast.success('¡Gracias por tu opinión!');
    }
    setEnviada(true);
  }

  if (enviada) {
    return (
      <div className="rounded-md border border-green-200 bg-green-50 p-5 text-center">
        <CheckCircle2 className="h-8 w-8 text-green-600 mx-auto mb-2" />
        <p className="text-sm font-medium text-green-900">
          {reviewExistente ? 'Esta es tu opinión sobre el pedido' : '¡Gracias por dejar tu opinión!'}
        </p>
        <div className="mt-3">
          <StarRating value={reviewExistente?.rating ?? rating} size="md" />
        </div>
        {(reviewExistente?.comentario ?? comentario) && (
          <p className="text-xs text-foreground/70 mt-2 italic">
            "{reviewExistente?.comentario ?? comentario}"
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-md border-2 border-dashed border-amber-200 bg-amber-50/40 p-5">
      <div className="text-sm font-medium mb-2">¿Cómo estuvo tu pedido?</div>
      <p className="text-xs text-foreground/60 mb-4">
        Tu opinión ayuda a otros clientes y al restaurante a mejorar.
      </p>
      <div className="flex justify-center mb-3">
        <StarRating value={rating} onChange={setRating} size="lg" />
      </div>
      <Textarea
        value={comentario}
        onChange={(e) => setComentario(e.target.value)}
        placeholder="¿Algo más que quieras agregar? (opcional)"
        rows={3}
        maxLength={500}
        className="mb-3 text-sm"
      />
      <Button
        onClick={enviar}
        disabled={enviando || rating < 1}
        className="w-full h-11"
      >
        {enviando ? 'Enviando…' : 'Enviar opinión'}
      </Button>
    </div>
  );
}
