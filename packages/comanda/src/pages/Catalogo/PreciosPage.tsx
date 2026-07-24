import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ListaPreciosTab } from './ListaPreciosTab';
import { ListasPreciosTab } from './ListasPreciosTab';
import type { Usuario } from '@/types/auth';

// Pantalla única de Precios (30-jul). Antes el sidebar tenía dos entradas
// separadas —"Planilla de precios" y "Listas de precios"— que confundían
// (tres nombres parecidos contando la del maestro). Ahora es UNA sección
// "Precios" con dos pestañas:
//   - Planilla: la grilla items × canales (ListaPreciosTab), lo del día a día.
//   - Listas:   agrupar canales que comparten precios (ListasPreciosTab).
// Las dos rutas viejas siguen funcionando; /menu/listas-precios entra
// directo a la pestaña Listas.
interface Props {
  user: Usuario;
  defaultTab?: 'planilla' | 'listas';
}

export function PreciosPage({ user, defaultTab = 'planilla' }: Props) {
  return (
    <Tabs defaultValue={defaultTab}>
      <div className="container pt-6">
        <TabsList>
          <TabsTrigger value="planilla">Planilla</TabsTrigger>
          <TabsTrigger value="listas">Listas</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="planilla" className="mt-0">
        <ListaPreciosTab user={user} />
      </TabsContent>
      <TabsContent value="listas" className="mt-0">
        <ListasPreciosTab user={user} />
      </TabsContent>
    </Tabs>
  );
}
