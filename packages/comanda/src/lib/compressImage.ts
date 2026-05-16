// Compresión client-side de imágenes antes de subir a Supabase Storage.
// Reduce drasticamente el egress: una foto del celular típica de 800KB-3MB
// queda en ~100-250KB con quality OK para mostrar 16:10 cards.
//
// Uso canvas API nativa (sin libs externas). Soporta JPG/PNG/WEBP.
// Output siempre JPEG porque comprime mejor para fotos reales.

export interface CompressOptions {
  /** Máximo ancho en píxeles (alto se ajusta proporcional). Default 1200. */
  maxWidth?: number;
  /** Calidad JPEG 0-1. Default 0.8. */
  quality?: number;
  /** MIME output. Default image/jpeg. */
  mimeType?: 'image/jpeg' | 'image/webp';
}

export async function compressImage(
  file: File,
  options: CompressOptions = {},
): Promise<File> {
  const { maxWidth = 1200, quality = 0.8, mimeType = 'image/jpeg' } = options;

  // PNG con transparencia conviene mantener — si lo convertimos a JPEG
  // pierde alpha y queda con fondo negro. Si el file es PNG y tiene
  // transparencia, no lo tocamos (mejor un poco más egress que romper la
  // imagen).
  if (file.type === 'image/png') {
    const hasAlpha = await pngTieneAlpha(file);
    if (hasAlpha) return file;
  }

  // Si el archivo es chico, no vale la pena comprimir
  if (file.size < 100 * 1024) return file;

  const img = await loadImage(file);
  const ratio = img.width > maxWidth ? maxWidth / img.width : 1;
  const targetW = Math.round(img.width * ratio);
  const targetH = Math.round(img.height * ratio);

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(img, 0, 0, targetW, targetH);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), mimeType, quality);
  });
  if (!blob) return file;

  // Si el resultado es MÁS GRANDE que el original (raro pero posible
  // con imágenes muy ya optimizadas), devolver el original.
  if (blob.size >= file.size) return file;

  const newName = file.name.replace(/\.[^.]+$/, '') + (mimeType === 'image/webp' ? '.webp' : '.jpg');
  return new File([blob], newName, { type: mimeType, lastModified: Date.now() });
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// Detecta si un PNG tiene canal alpha leyendo el byte 25 del header.
// PNG IHDR byte 25 = color_type. Bit 2 (valor 4) indica alpha.
// Sin alpha → bajar a JPEG es seguro.
async function pngTieneAlpha(file: File): Promise<boolean> {
  try {
    const buf = await file.slice(0, 30).arrayBuffer();
    const bytes = new Uint8Array(buf);
    // Color type byte está en offset 25 (después de PNG signature 8 + IHDR 4 length + 4 name + 13 data)
    const colorType = bytes[25];
    if (colorType === undefined) return true;
    return (colorType & 4) !== 0;  // bit 2 = alpha
  } catch {
    return true;  // si falla la lectura, mejor no riesgar
  }
}
