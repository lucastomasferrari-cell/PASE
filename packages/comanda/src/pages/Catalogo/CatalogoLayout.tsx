import { useState } from 'react';
import { ClipboardList, FolderClosed, ShoppingBag, DollarSign, Settings2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ItemsTab } from './ItemsTab';
import { GruposTab } from './GruposTab';
import { CanalesTab } from './CanalesTab';
import { ListaPreciosTab } from './ListaPreciosTab';
import { ModificadoresTab } from './ModificadoresTab';

const TABS = [
  { key: 'items',         label: 'Items',            Icon: ClipboardList },
  { key: 'grupos',        label: 'Grupos',           Icon: FolderClosed },
  { key: 'canales',       label: 'Canales',          Icon: ShoppingBag },
  { key: 'precios',       label: 'Lista de precios', Icon: DollarSign },
  { key: 'modificadores', label: 'Modificadores',    Icon: Settings2 },
] as const;

type TabKey = typeof TABS[number]['key'];

export function CatalogoLayout() {
  const { user } = useAuth();
  const [tab, setTab] = useState<TabKey>('items');

  if (!user) return null;

  return (
    <div className="container py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Catálogo</h1>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList className="bg-transparent border-b border-border w-full justify-start rounded-none h-auto p-0 mb-6">
          {TABS.map((t) => (
            <TabsTrigger
              key={t.key}
              value={t.key}
              className="data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none rounded-none border-b-2 border-transparent px-4 py-3 gap-2"
            >
              <t.Icon className="h-4 w-4" />
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="items">
          <ItemsTab user={user} />
        </TabsContent>
        <TabsContent value="grupos">
          <GruposTab user={user} />
        </TabsContent>
        <TabsContent value="canales">
          <CanalesTab user={user} />
        </TabsContent>
        <TabsContent value="precios">
          <ListaPreciosTab user={user} />
        </TabsContent>
        <TabsContent value="modificadores">
          <ModificadoresTab user={user} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
