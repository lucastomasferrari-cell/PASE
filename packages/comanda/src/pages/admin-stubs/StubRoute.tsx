import { useLocation } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { StubPantalla } from '@/components/admin/StubPantalla';
import { STUBS_COPY } from '@/lib/stubsCopy';

// Componente único que renderiza un stub según el pathname actual.
// Lookea STUBS_COPY[pathname] y delega a StubPantalla.
//
// Ventaja: una sola entrada en App.tsx por ruta stub (solo cambia el
// path) en vez de un archivo por ruta. Si una entrada falta en
// STUBS_COPY, fallback genérico.
export function StubRoute() {
  const { pathname } = useLocation();
  const copy = STUBS_COPY[pathname];

  if (!copy) {
    return (
      <StubPantalla
        titulo="Próximamente"
        descripcion="Esta funcionalidad va a llegar en futuros sprints."
        icono={Sparkles}
      />
    );
  }

  return (
    <StubPantalla
      titulo={copy.titulo}
      descripcion={copy.descripcion}
      icono={copy.icono}
      features={copy.features}
    />
  );
}
