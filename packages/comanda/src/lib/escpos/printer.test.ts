import { describe, it, expect } from 'vitest';
import { isWebUsbSupported } from './printer';

// Los tests del builder de ESC/POS son simples — verificamos que los bytes
// generados están correctos. El test real de impresión requiere hardware
// físico (no se puede mockear WebUSB de forma útil).

describe('escpos/printer', () => {
  it('isWebUsbSupported retorna false en Node (sin navigator.usb)', () => {
    // En vitest/Node típico no hay navigator. Asegurate de no crashear.
    expect(isWebUsbSupported()).toBe(false);
  });
});

// Tests del TicketBuilder (clase privada) — solo verificamos via la API
// pública construida en Printer. Para tests más exhaustivos del protocolo
// ESC/POS, agregar un test que use un mock USBDevice y verifique los
// bytes enviados a transferOut. Pendiente.
