import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { DoorOpen } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAuthPos } from '../../lib/authPos';
import { useLocalActivo } from '../../lib/localActivo';
import { abrirTurno, getTurnoAbierto } from '../../services/turnosCajaService';
import { MoneyInput } from '../../components/MoneyInput';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export function CajaAbrir() {
  const { user } = useAuth();
  const { empleado } = useAuthPos();
  const [localId] = useLocalActivo(user);
  const navigate = useNavigate();

  const [montoInicial, setMontoInicial] = useState(0);
  const [notas, setNotas] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [chequeando, setChequeando] = useState(true);

  useEffect(() => {
    if (localId === null) return;
    getTurnoAbierto(localId).then((res) => {
      if (res.data) navigate('/caja', { replace: true });
      setChequeando(false);
    });
  }, [localId, navigate]);

  if (chequeando) return <CenteredCard>Verificando turno…</CenteredCard>;
  if (!empleado) return <CenteredCard>Necesitás iniciar sesión POS primero.</CenteredCard>;
  if (localId === null) return <CenteredCard>Sin local activo.</CenteredCard>;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!empleado || localId === null) return;
    setSaving(true);
    setError(null);
    const { turnoId, error: err } = await abrirTurno(
      localId, empleado.id, montoInicial, notas.trim() || null,
    );
    setSaving(false);
    if (err || !turnoId) {
      setError(err ?? 'Error desconocido');
      return;
    }
    navigate('/caja', { replace: true });
  }

  return (
    <div className="container max-w-md py-8">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-success/10 flex-shrink-0">
              <DoorOpen className="h-5 w-5 text-success" />
            </div>
            <div>
              <CardTitle>Abrir caja</CardTitle>
              <CardDescription>Cajero: {empleado.nombre}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>Monto inicial (efectivo en caja)</Label>
              <MoneyInput value={montoInicial} onChange={setMontoInicial} autoFocus />
            </div>

            <div className="space-y-2">
              <Label htmlFor="notas">Notas (opcional)</Label>
              <Textarea
                id="notas"
                value={notas}
                onChange={(e) => setNotas(e.target.value)}
                rows={3}
                placeholder="Cambio inicial, observaciones del turno…"
              />
            </div>

            {error && (
              <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                {error}
              </div>
            )}

            <Button
              type="submit"
              disabled={saving}
              variant="success"
              size="lg"
              className="w-full"
            >
              {saving ? 'Abriendo…' : 'Abrir caja'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="container max-w-md py-8">
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          {children}
        </CardContent>
      </Card>
    </div>
  );
}
