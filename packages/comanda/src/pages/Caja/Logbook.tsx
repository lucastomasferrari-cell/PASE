import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { BookOpen, Check, AlertCircle, AlertTriangle, Info, Plus } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAuthPos } from '../../lib/authPos';
import { useLocalActivo } from '../../lib/localActivo';
import {
  listLogbook, crearLogbook, resolverLogbook,
  type LogbookEntry, type LogbookCategoria, type LogbookPrioridad,
} from '../../services/logbookService';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { relativoCorto } from '../../lib/format';
import { cn } from '@/lib/utils';

// Sprint 2 competitor F #7 — Manager Logbook.
// Diario digital del manager: novedades del turno. El siguiente manager
// ENTRA acá primero antes de operar, lee pendientes, resuelve los que cubre.

const CATEGORIAS: Array<{ value: LogbookCategoria; label: string; emoji: string }> = [
  { value: 'caja',      label: 'Caja',      emoji: '💰' },
  { value: 'cocina',    label: 'Cocina',    emoji: '🍳' },
  { value: 'cliente',   label: 'Cliente',   emoji: '🙋' },
  { value: 'empleado',  label: 'Empleado',  emoji: '👤' },
  { value: 'proveedor', label: 'Proveedor', emoji: '🚚' },
  { value: 'general',   label: 'General',   emoji: '📝' },
];

const PRIORIDADES: Array<{ value: LogbookPrioridad; label: string; tone: string; icon: typeof Info }> = [
  { value: 'info',     label: 'Info',     tone: 'text-muted-foreground border-border bg-muted/40', icon: Info },
  { value: 'atencion', label: 'Atención', tone: 'text-warning border-warning/40 bg-warning/10', icon: AlertCircle },
  { value: 'urgente',  label: 'Urgente',  tone: 'text-destructive border-destructive/40 bg-destructive/10', icon: AlertTriangle },
];

export function Logbook() {
  const { user } = useAuth();
  const { empleado } = useAuthPos();
  const [localId] = useLocalActivo(user);

  const [entries, setEntries] = useState<LogbookEntry[]>([]);
  const [filter, setFilter] = useState<'pendientes' | 'todas'>('pendientes');
  const [loading, setLoading] = useState(true);
  const [creando, setCreando] = useState(false);
  const [resolviendo, setResolviendo] = useState<LogbookEntry | null>(null);

  const reload = useCallback(async () => {
    if (localId === null) return;
    setLoading(true);
    const r = await listLogbook(localId, filter);
    if (r.error) toast.error(r.error);
    else setEntries(r.data);
    setLoading(false);
  }, [localId, filter]);

  useEffect(() => { reload(); }, [reload]);

  const pendientesCount = entries.filter((e) => e.pendiente).length;

  if (!empleado) {
    return <div className="p-8 text-center text-muted-foreground">Sesión POS requerida.</div>;
  }
  if (localId === null) {
    return <div className="p-8 text-center text-muted-foreground">Sin local activo.</div>;
  }

  return (
    <div className="container py-6">
      <header className="mb-5 flex items-start gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <BookOpen className="h-6 w-6" />
            Logbook del turno
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Novedades del turno que el próximo manager necesita saber.
            Marcá pendiente lo que requiera follow-up — el que cubra el turno siguiente lo resuelve.
          </p>
        </div>
        <Button onClick={() => setCreando(true)} size="lg">
          <Plus className="h-4 w-4 mr-1.5" />
          Nueva entrada
        </Button>
      </header>

      <div className="mb-4 flex items-center gap-2">
        <Button
          variant={filter === 'pendientes' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setFilter('pendientes')}
        >
          Pendientes {filter === 'pendientes' && pendientesCount > 0 && <span className="ml-1.5 text-[10px] opacity-75">({pendientesCount})</span>}
        </Button>
        <Button
          variant={filter === 'todas' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setFilter('todas')}
        >
          Todas
        </Button>
      </div>

      {loading ? (
        <div className="py-12 text-center text-muted-foreground">Cargando…</div>
      ) : entries.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <BookOpen className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p className="font-medium">
              {filter === 'pendientes' ? 'Sin pendientes' : 'Logbook vacío'}
            </p>
            <p className="text-xs mt-1">
              {filter === 'pendientes'
                ? 'No hay nada por resolver del turno actual.'
                : 'Todavía nadie escribió nada en este local.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2.5">
          {entries.map((e) => (
            <LogbookCard
              key={e.id}
              entry={e}
              onResolver={() => setResolviendo(e)}
            />
          ))}
        </div>
      )}

      {creando && (
        <CrearDialog
          localId={localId}
          empleadoId={empleado.id}
          onClose={() => setCreando(false)}
          onCreada={() => { setCreando(false); reload(); }}
        />
      )}

      {resolviendo && (
        <ResolverDialog
          entry={resolviendo}
          empleadoId={empleado.id}
          onClose={() => setResolviendo(null)}
          onResuelta={() => { setResolviendo(null); reload(); }}
        />
      )}
    </div>
  );
}

function LogbookCard({ entry, onResolver }: { entry: LogbookEntry; onResolver: () => void }) {
  const cat = CATEGORIAS.find((c) => c.value === entry.categoria) ?? CATEGORIAS[5]!;
  const pri = PRIORIDADES.find((p) => p.value === entry.prioridad) ?? PRIORIDADES[0]!;
  const PriIcon = pri.icon;

  return (
    <Card className={cn(!entry.pendiente && 'opacity-60')}>
      <CardContent className="p-3.5">
        <div className="flex items-start gap-3">
          <div className="text-2xl">{cat.emoji}</div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium uppercase', pri.tone)}>
                <PriIcon className="h-3 w-3" />
                {pri.label}
              </span>
              <span className="text-xs text-muted-foreground">{cat.label}</span>
              <span className="text-xs text-muted-foreground">·</span>
              <span className="text-xs text-muted-foreground">{relativoCorto(entry.created_at)}</span>
              {entry.autor_nombre && (
                <>
                  <span className="text-xs text-muted-foreground">·</span>
                  <span className="text-xs text-muted-foreground">por {entry.autor_nombre}</span>
                </>
              )}
              {!entry.pendiente && (
                <span className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-success/15 text-success text-[10px] font-medium">
                  <Check className="h-3 w-3" /> Resuelto
                </span>
              )}
            </div>
            <p className="text-sm whitespace-pre-wrap">{entry.texto}</p>
            {!entry.pendiente && (entry.resolucion_nota || entry.resuelto_nombre) && (
              <div className="mt-2 p-2 rounded bg-success/5 border border-success/20 text-xs">
                <div className="font-medium text-success mb-0.5">
                  Resuelto {entry.resuelto_at && relativoCorto(entry.resuelto_at)}
                  {entry.resuelto_nombre && ` por ${entry.resuelto_nombre}`}
                </div>
                {entry.resolucion_nota && <p className="text-foreground/80">{entry.resolucion_nota}</p>}
              </div>
            )}
          </div>
          {entry.pendiente && (
            <Button size="sm" variant="outline" onClick={onResolver}>
              <Check className="h-3.5 w-3.5 mr-1" />
              Resolver
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function CrearDialog({ localId, empleadoId, onClose, onCreada }: {
  localId: number; empleadoId: string; onClose: () => void; onCreada: () => void;
}) {
  const [categoria, setCategoria] = useState<LogbookCategoria>('general');
  const [prioridad, setPrioridad] = useState<LogbookPrioridad>('info');
  const [texto, setTexto] = useState('');
  const [pendiente, setPendiente] = useState(true);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!texto.trim()) { toast.error('Escribí algo'); return; }
    setSaving(true);
    const { error } = await crearLogbook({
      localId, empleadoId, categoria, prioridad, texto: texto.trim(), pendiente,
    });
    setSaving(false);
    if (error) { toast.error(error); return; }
    toast.success('Anotado en el logbook');
    onCreada();
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nueva entrada del logbook</DialogTitle>
          <DialogDescription>
            Anotá novedades del turno. El próximo manager va a leerlo.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Categoría</label>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {CATEGORIAS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setCategoria(c.value)}
                  className={cn(
                    'px-2.5 py-1 rounded-md text-xs border transition-colors',
                    categoria === c.value
                      ? 'border-primary bg-primary/10 text-primary font-medium'
                      : 'border-border hover:bg-accent',
                  )}
                >
                  {c.emoji} {c.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Prioridad</label>
            <div className="flex gap-1.5 mt-1">
              {PRIORIDADES.map((p) => {
                const Icon = p.icon;
                return (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => setPrioridad(p.value)}
                    className={cn(
                      'flex-1 px-3 py-1.5 rounded-md text-xs border transition-colors inline-flex items-center justify-center gap-1.5',
                      prioridad === p.value
                        ? p.tone + ' font-medium'
                        : 'border-border hover:bg-accent text-muted-foreground',
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Texto</label>
            <textarea
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              rows={4}
              autoFocus
              placeholder="Ej: Mesa 12 reclamó demora de 40 min con la entrada, le ofrecí postre cortesía"
              className="w-full mt-1 rounded-md border border-input bg-background p-2 text-sm resize-y"
            />
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={pendiente}
              onChange={(e) => setPendiente(e.target.checked)}
              className="h-4 w-4"
            />
            <span>Marcar como pendiente (requiere follow-up del próximo manager)</span>
          </label>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Guardando…' : 'Guardar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResolverDialog({ entry, empleadoId, onClose, onResuelta }: {
  entry: LogbookEntry; empleadoId: string; onClose: () => void; onResuelta: () => void;
}) {
  const [nota, setNota] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const { error } = await resolverLogbook(entry.id, empleadoId, nota.trim() || undefined);
    setSaving(false);
    if (error) { toast.error(error); return; }
    toast.success('Marcada como resuelta');
    onResuelta();
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Resolver entrada</DialogTitle>
          <DialogDescription className="line-clamp-3 whitespace-pre-wrap">
            {entry.texto}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Nota de resolución (opcional)
            </label>
            <textarea
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              rows={3}
              placeholder="Ej: Cliente vino al día siguiente, le dimos un café cortesía"
              className="w-full mt-1 rounded-md border border-input bg-background p-2 text-sm resize-y"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button type="submit" variant="success" disabled={saving}>
              {saving ? 'Cerrando…' : 'Marcar resuelta'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
