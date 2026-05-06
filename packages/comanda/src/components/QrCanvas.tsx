import { useEffect, useRef } from 'react';
import QRCode from 'qrcode';

// Wrapper canvas mínimo: la librería `qrcode` genera el QR en un <canvas>.
// No usamos qrcode.react para no depender de un paquete adicional cuando la
// API base alcanza. El size es lado del canvas en px.

interface Props {
  value: string;
  size?: number;
  className?: string;
}

export function QrCanvas({ value, size = 240, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    QRCode.toCanvas(c, value, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: size,
      color: { dark: '#000000', light: '#ffffff' },
    }).catch(err => console.error('[QrCanvas]', err));
  }, [value, size]);
  return <canvas ref={canvasRef} className={className} aria-label="Código QR" />;
}
