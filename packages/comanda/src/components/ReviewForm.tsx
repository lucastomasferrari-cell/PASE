// Form para que el cliente deje review después de un pedido entregado.
// Aparece en TiendaConfirmacion cuando estado='entregada' o 'cobrada'.
//
// Brainstorm #8 F5 Chunk C (2026-06-01) — multi-aspecto + foto opcional.
// El rating global sigue siendo obligatorio (back-compat). Los 3 ratings
// por aspecto + la foto son opcionales (sección "Opiniones detalladas").

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Camera, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { StarRating } from './StarRating';
import { crearReviewPublica, subirFotoReview } from '@/services/reviewsService';

interface Props {
  ventaId: number;
  telefono: string;
  email?: string | null;
}

export function ReviewForm({ ventaId, telefono, email }: Props) {
  const [rating, setRating] = useState(0);
  const [comentario, setComentario] = useState('');
  // Multi-aspecto opcional
  const [estrellasComida, setEstrellasComida] = useState(0);
  const [estrellasEntrega, setEstrellasEntrega] = useState(0);
  const [estrellasPresentacion, setEstrellasPresentacion] = useState(0);
  const [mostrarDetalles, setMostrarDetalles] = useState(false);
  // Foto opcional
  const [foto, setFoto] = useState<File | null>(null);
  const [fotoPreview, setFotoPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Estado
  const [enviando, setEnviando] = useState(false);
  const [enviada, setEnviada] = useState(false);
  const [reviewExistente, setReviewExistente] = useState<{ rating: number; comentario: string | null } | null>(null);

  function onFotoSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast.error('La foto pesa más de 2MB');
      return;
    }
    setFoto(file);
    // Preview local
    const reader = new FileReader();
    reader.onload = () => setFotoPreview(reader.result as string);
    reader.readAsDataURL(file);
  }

  function quitarFoto() {
    setFoto(null);
    setFotoPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function enviar() {
    if (rating < 1) {
      toast.error('Elegí una calificación (1 a 5 estrellas)');
      return;
    }
    setEnviando(true);

    // 1. Subir foto si hay
    let fotoUrl: string | null = null;
    if (foto) {
      const r = await subirFotoReview(foto, ventaId);
      if (r.error) {
        setEnviando(false);
        toast.error('No se pudo subir la foto', { description: r.error });
        return;
      }
      fotoUrl = r.url;
    }

    // 2. Crear review
    const { reviewId, yaExistia, error } = await crearReviewPublica({
      ventaId,
      telefono,
      rating,
      comentario: comentario.trim() || null,
      email: email || null,
      estrellasComida: estrellasComida || null,
      estrellasEntrega: estrellasEntrega || null,
      estrellasPresentacion: estrellasPresentacion || null,
      fotoUrl,
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

      {/* Rating global obligatorio */}
      <div className="flex justify-center mb-3">
        <StarRating value={rating} onChange={setRating} size="lg" />
      </div>

      {/* Toggle multi-aspecto opcional */}
      <button
        type="button"
        onClick={() => setMostrarDetalles(!mostrarDetalles)}
        className="text-xs text-primary underline mb-3 block mx-auto"
      >
        {mostrarDetalles ? 'Ocultar detalle' : 'Calificar por separado (opcional)'}
      </button>

      {mostrarDetalles && (
        <div className="space-y-2.5 mb-4 px-2 py-3 bg-white/60 rounded-md border border-amber-100">
          <AspectoRow label="Comida" value={estrellasComida} onChange={setEstrellasComida} />
          <AspectoRow label="Entrega" value={estrellasEntrega} onChange={setEstrellasEntrega} />
          <AspectoRow label="Presentación" value={estrellasPresentacion} onChange={setEstrellasPresentacion} />
        </div>
      )}

      <Textarea
        value={comentario}
        onChange={(e) => setComentario(e.target.value)}
        placeholder="¿Algo más que quieras agregar? (opcional)"
        rows={3}
        maxLength={500}
        className="mb-3 text-sm"
      />

      {/* Upload foto opcional */}
      {!foto ? (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="w-full mb-3 px-3 py-2 rounded-md border border-dashed border-amber-300 text-xs text-amber-800 hover:bg-amber-100/40 inline-flex items-center justify-center gap-1.5"
        >
          <Camera className="h-3.5 w-3.5" />
          Agregar foto (opcional, máx 2MB)
        </button>
      ) : (
        <div className="mb-3 relative">
          {fotoPreview && (
            <img
              src={fotoPreview}
              alt="Preview"
              className="w-full h-40 object-cover rounded-md border border-amber-200"
            />
          )}
          <button
            type="button"
            onClick={quitarFoto}
            className="absolute top-2 right-2 h-7 w-7 rounded-full bg-black/60 text-white inline-flex items-center justify-center hover:bg-black/80"
            aria-label="Quitar foto"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={onFotoSelected}
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

// Fila para rating multi-aspecto compacto.
function AspectoRow({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-foreground/70">{label}</span>
      <StarRating value={value} onChange={onChange} size="sm" />
    </div>
  );
}
