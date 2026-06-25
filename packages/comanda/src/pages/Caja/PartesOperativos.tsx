import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ClipboardList, AlertCircle, Clock, MessageSquare, FileText } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { listPartesOperativos, type ParteOperativo } from '@/services/parteOperativoService';
import { listEmpleadosLocal } from '@/services/empleadosService';
import type { EmpleadoPos } from '@/types/database';
import { formatFechaAR, formatHoraAR } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/Badge';
import { cn } from '@/lib/utils';

export function PartesOperativos() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const navigate = useNavigate();

  const [partes, setPartes] = useState<ParteOperativo[]>([]);
  const [empleados, setEmpleados] = useState<EmpleadoPos[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (localId === null) return;
    setLoading(true);
    const [partesRes, emplRes] = await Promise.all([
      listPartesOperativos(localId, 60),
      listEmpleadosLocal(localId),
    ]);
    if (partesRes.error) setError(partesRes.error);
    setPartes(partesRes.data);
    setEmpleados(emplRes.data);
    setLoading(false);
  }, [localId]);

  useEffect(() => { reload(); }, [reload]);

  function nombreEmpleado(id: string): string {
    const e = empleados.find((e) => e.id === id);
    if (!e) return id.slice(0, 8) + '…';
    return `${e.apellido}, ${e.nombre}`;
  }

  const sinNovedades = partes.filter(
    (p) => p.empleados_falta.length === 0 && p.empleados_tarde.length === 0 && !p.reclamos && !p.comentario,
  );
  const conNovedades = partes.filter(
    (p) => p.empleados_falta.length > 0 || p.empleados_tarde.length > 0 || p.reclamos || p.comentario,
  );

  return (
    <div className="container py-6 max-w-3xl">
      <header className="flex items-center gap-3 mb-6 flex-wrap">
        <Button variant="ghost" size="sm" onClick={() => navigate('/caja')}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Volver
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">Partes de turno</h1>
        {!loading && (
          <span className="text-sm text-muted-foreground">
            {partes.length} partes — {conNovedades.length} con novedades
          </span>
        )}
      </header>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
      )}

      {loading ? (
        <Card><CardContent className="py-16 text-center text-muted-foreground">Cargando…</CardContent></Card>
      ) : partes.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-muted mb-4">
              <ClipboardList className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium mb-1">Sin partes registrados</h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              Cuando un encargado cierre un turno y complete el parte, aparecerá acá.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {partes.map((p, idx) => (
            <ParteCard
              key={p.id}
              parte={p}
              nombreEmpleado={nombreEmpleado}
              destacado={idx === 0}
            />
          ))}
          {sinNovedades.length > 0 && (
            <p className="text-xs text-center text-muted-foreground pt-2">
              {sinNovedades.length} turno{sinNovedades.length !== 1 ? 's' : ''} cerrado{sinNovedades.length !== 1 ? 's' : ''} sin novedades no mostrado{sinNovedades.length !== 1 ? 's' : ''}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ParteCard({
  parte,
  nombreEmpleado,
  destacado,
}: {
  parte: ParteOperativo;
  nombreEmpleado: (id: string) => string;
  destacado: boolean;
}) {
  const tieneNovedades =
    parte.empleados_falta.length > 0 ||
    parte.empleados_tarde.length > 0 ||
    parte.reclamos ||
    parte.comentario;

  if (!tieneNovedades) return null;

  return (
    <Card className={cn(destacado && 'ring-1 ring-primary/20')}>
      <CardContent className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-semibold text-sm">{formatFechaAR(parte.created_at)}</div>
            <div className="text-xs text-muted-foreground">{formatHoraAR(parte.created_at)}</div>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {parte.empleados_falta.length > 0 && (
              <Badge variant="red">
                <AlertCircle className="h-3 w-3 mr-1" />
                {parte.empleados_falta.length} falta{parte.empleados_falta.length !== 1 ? 's' : ''}
              </Badge>
            )}
            {parte.empleados_tarde.length > 0 && (
              <Badge variant="amber">
                <Clock className="h-3 w-3 mr-1" />
                {parte.empleados_tarde.length} tarde{parte.empleados_tarde.length !== 1 ? 's' : ''}
              </Badge>
            )}
          </div>
        </div>

        {/* Faltas */}
        {parte.empleados_falta.length > 0 && (
          <div>
            <div className="text-xs font-medium text-destructive mb-1.5 uppercase tracking-wide">Faltas</div>
            <div className="flex flex-wrap gap-1.5">
              {parte.empleados_falta.map((id) => (
                <span key={id} className="text-xs bg-red-50 border border-red-200 text-red-800 rounded px-2 py-0.5">
                  {nombreEmpleado(id)}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Llegadas tarde */}
        {parte.empleados_tarde.length > 0 && (
          <div>
            <div className="text-xs font-medium text-amber-700 mb-1.5 uppercase tracking-wide">Llegadas tarde</div>
            <div className="flex flex-wrap gap-1.5">
              {parte.empleados_tarde.map((id) => (
                <span key={id} className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded px-2 py-0.5">
                  {nombreEmpleado(id)}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Reclamos */}
        {parte.reclamos && (
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-1 uppercase tracking-wide flex items-center gap-1">
              <MessageSquare className="h-3 w-3" /> Reclamos
            </div>
            <p className="text-sm bg-muted/50 rounded p-2 whitespace-pre-wrap">{parte.reclamos}</p>
          </div>
        )}

        {/* Comentario */}
        {parte.comentario && (
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-1 uppercase tracking-wide flex items-center gap-1">
              <FileText className="h-3 w-3" /> Comentario
            </div>
            <p className="text-sm bg-muted/50 rounded p-2 whitespace-pre-wrap">{parte.comentario}</p>
          </div>
        )}

        {/* Footer */}
        {parte.cerrado_por && (
          <div className="text-xs text-muted-foreground pt-1 border-t">
            Cerrado por {nombreEmpleado(parte.cerrado_por)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
