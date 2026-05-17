/**
 * Icons.tsx — set acotado de iconos SVG line-art para empty states + headers.
 *
 * Decisión Lucas 2026-05-17: los emojis (📌📈⚖🏪) bajan el nivel visual del
 * producto — Notion-style requiere line-art sobrio. Pero algo de pictograma
 * sigue siendo útil para no caer en pantallas de puro texto.
 *
 * Reglas:
 *   - Stroke 1.4-1.6px, line-cap round, fill="none" (estilo Lucide/Heroicons).
 *   - Color por defecto: var(--pase-text-muted). El caller puede pasar tone:
 *       "muted" (default) — celeste muted suave
 *       "celeste" — celeste de marca (más presencia)
 *       "gold" — dorado de marca, RESERVADO para momentos positivos
 *         (ej. "Todo al día", "✓ Cubriste los fijos"). Es el ancla
 *         visual sutil — único otro lugar donde aparece el dorado es
 *         el punto del logo "pase." y el sol del InfoTooltip.
 *   - Tamaño default 28px (más chico que un emoji grande, suficiente
 *     presencia en una card).
 */

type IconTone = "muted" | "celeste" | "gold";

interface IconProps {
  size?: number;
  tone?: IconTone;
}

function toneToColor(tone: IconTone): string {
  switch (tone) {
    case "celeste": return "var(--pase-celeste, #4A90B8)";
    case "gold":    return "var(--pase-gold, #F5C518)";
    case "muted":
    default:        return "var(--pase-text-muted, #6B8AAA)";
  }
}

const base = (size: number, tone: IconTone) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none" as const,
  stroke: toneToColor(tone),
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

// ─── Pin / tareas / mensajes ────────────────────────────────────────────
export function PinIcon({ size = 28, tone = "muted" }: IconProps) {
  return (
    <svg {...base(size, tone)} aria-hidden>
      <path d="M12 17v5" />
      <path d="M9 10.76V4h6v6.76a2 2 0 0 0 .59 1.41l2 2A1 1 0 0 1 17 15H7a1 1 0 0 1-.59-1.83l2-2A2 2 0 0 0 9 10.76Z" />
    </svg>
  );
}

// ─── Trending up / ventas / tendencia ──────────────────────────────────
export function TrendUpIcon({ size = 28, tone = "muted" }: IconProps) {
  return (
    <svg {...base(size, tone)} aria-hidden>
      <polyline points="3 17 9 11 13 15 21 7" />
      <polyline points="14 7 21 7 21 14" />
    </svg>
  );
}

// ─── Target / objetivo ──────────────────────────────────────────────────
export function TargetIcon({ size = 28, tone = "muted" }: IconProps) {
  return (
    <svg {...base(size, tone)} aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" fill={toneToColor(tone)} />
    </svg>
  );
}

// ─── Scale / equilibrio / BEP ──────────────────────────────────────────
export function ScaleIcon({ size = 28, tone = "muted" }: IconProps) {
  return (
    <svg {...base(size, tone)} aria-hidden>
      <path d="M12 3v18" />
      <path d="M5 21h14" />
      <path d="M7 9 4 16h6Z" />
      <path d="M17 9l-3 7h6Z" />
      <path d="M5 6h14" />
    </svg>
  );
}

// ─── Storefront / sucursales ───────────────────────────────────────────
export function ShopIcon({ size = 28, tone = "muted" }: IconProps) {
  return (
    <svg {...base(size, tone)} aria-hidden>
      <path d="M3 9 4.5 4h15L21 9" />
      <path d="M3 9v11h18V9" />
      <path d="M3 9c0 1.7 1.3 3 3 3s3-1.3 3-3M9 9c0 1.7 1.3 3 3 3s3-1.3 3-3M15 9c0 1.7 1.3 3 3 3s3-1.3 3-3" />
    </svg>
  );
}

// ─── Calendar / vencimientos próximos ──────────────────────────────────
export function CalendarIcon({ size = 28, tone = "muted" }: IconProps) {
  return (
    <svg {...base(size, tone)} aria-hidden>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

// ─── Check / éxito (típicamente dorado) ────────────────────────────────
export function CheckIcon({ size = 28, tone = "gold" }: IconProps) {
  return (
    <svg {...base(size, tone)} aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <polyline points="7 13 10.5 16.5 17 9" />
    </svg>
  );
}

// ─── Receipt / facturas ────────────────────────────────────────────────
export function ReceiptIcon({ size = 28, tone = "muted" }: IconProps) {
  return (
    <svg {...base(size, tone)} aria-hidden>
      <path d="M4 3h16v18l-3-2-2 2-3-2-3 2-2-2-3 2Z" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  );
}

// ─── Wallet / saldos ───────────────────────────────────────────────────
export function WalletIcon({ size = 28, tone = "muted" }: IconProps) {
  return (
    <svg {...base(size, tone)} aria-hidden>
      <rect x="3" y="6" width="18" height="14" rx="2" />
      <path d="M3 10h18" />
      <circle cx="16.5" cy="14.5" r="1" fill={toneToColor(tone)} />
    </svg>
  );
}

// ─── Box / remitos ─────────────────────────────────────────────────────
export function BoxIcon({ size = 28, tone = "muted" }: IconProps) {
  return (
    <svg {...base(size, tone)} aria-hidden>
      <path d="M21 8 12 3 3 8v8l9 5 9-5Z" />
      <path d="M3 8l9 5 9-5M12 13v8" />
    </svg>
  );
}

// ─── Bell / alertas ────────────────────────────────────────────────────
export function BellIcon({ size = 28, tone = "muted" }: IconProps) {
  return (
    <svg {...base(size, tone)} aria-hidden>
      <path d="M18 16v-5a6 6 0 1 0-12 0v5l-2 2h16Z" />
      <path d="M10 21a2 2 0 0 0 4 0" />
    </svg>
  );
}
