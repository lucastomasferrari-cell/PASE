// Habitué — CRM/Marketing del ecosistema Cocina. App admin-only (login propio,
// mismo Supabase Auth que PASE/COMANDA/MESA). Una sola pantalla: el panel.

import { Routes, Route } from 'react-router-dom';
import { AdminHome } from './pages/AdminHome';

export function App() {
  return (
    <Routes>
      <Route path="*" element={<AdminHome />} />
    </Routes>
  );
}
