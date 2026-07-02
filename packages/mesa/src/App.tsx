// MESA — app raíz. Tres zonas:
//   /            landing del producto (pitch para restaurantes)
//   /:slug       página pública del local (perfil + reservas + eventos +
//                giftcards — el mix Blackbird/Tock/Meitre; sprint visual)
//   /admin       panel interno (agenda, eventos, giftcards — se porta de
//                COMANDA en el próximo sprint; auth Supabase compartida)

import { Routes, Route } from 'react-router-dom';
import { LandingMesa } from './pages/LandingMesa';
import { PerfilLocal } from './pages/PerfilLocal';
import { AdminHome } from './pages/AdminHome';
import { Confirmacion } from './pages/Confirmacion';
import { CancelarReserva } from './pages/CancelarReserva';
import { DejarResena } from './pages/DejarResena';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingMesa />} />
      <Route path="/admin" element={<AdminHome />} />
      <Route path="/r/confirmacion/:tipo/:id" element={<Confirmacion />} />
      <Route path="/r/cancelar/:id" element={<CancelarReserva />} />
      <Route path="/r/resena/:id" element={<DejarResena />} />
      <Route path="/:slug" element={<PerfilLocal />} />
    </Routes>
  );
}
