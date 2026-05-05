import { useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { TiendaCtx } from './TiendaLayout';

// El cliente entró desde un link directo o quiere ver el estado de su
// pedido. Pedimos teléfono + número de pedido para reconstituir el
// permiso (la RPC fn_get_pedido_publico_comanda valida ambos).

export function TiendaSeguimiento() {
  const { local } = useOutletContext<TiendaCtx>();
  const navigate = useNavigate();
  const [tel, setTel] = useState('');
  const [num, setNum] = useState('');

  function buscar() {
    if (!num.trim() || !tel.trim()) {
      toast.error('Necesitamos número de pedido y tu teléfono');
      return;
    }
    const id = parseInt(num.trim(), 10);
    if (Number.isNaN(id)) {
      toast.error('Número de pedido inválido');
      return;
    }
    // Persistimos el teléfono igual que cuando creó el pedido, así
    // TiendaConfirmacion puede polear sin volver a preguntarlo.
    sessionStorage.setItem(`comanda-tel-${id}`, tel.trim());
    navigate(`/tienda/${local.slug}/confirmacion/${id}`);
  }

  return (
    <div className="max-w-md mx-auto p-6">
      <h1 className="text-lg font-semibold flex items-center gap-2"><Search className="h-5 w-5" /> Buscar mi pedido</h1>
      <p className="text-xs text-muted-foreground mt-1">Necesitamos tu teléfono y el número de pedido para mostrarte el estado.</p>
      <div className="space-y-3 mt-4">
        <div>
          <Label htmlFor="num">Número de pedido</Label>
          <Input id="num" inputMode="numeric" value={num} onChange={e => setNum(e.target.value)} placeholder="Ej: 1234" />
        </div>
        <div>
          <Label htmlFor="tel">Teléfono</Label>
          <Input id="tel" inputMode="tel" value={tel} onChange={e => setTel(e.target.value)} placeholder="11 1234 5678" />
        </div>
        <Button onClick={buscar} className="w-full h-11">Ver estado</Button>
      </div>
    </div>
  );
}
