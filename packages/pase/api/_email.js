// _email.js — abstracción de envío de email. Hoy usa Resend; si Lucas
// quiere cambiar a Brevo / SMTP propio / lo que sea, se cambia SOLO acá.
//
// Env vars requeridas:
//   RESEND_API_KEY  — key de resend.com (gratis 100/día). Generar en
//                     resend.com/api-keys.
//   RESEND_FROM     — email "from" verificado. Ej: "Neko <pedidos@neko.com.ar>".
//                     Antes de mandar a producción real, validar dominio en
//                     resend.com/domains (DKIM + SPF). Mientras tanto se
//                     puede usar onboarding@resend.dev (solo para testing).
//
// Si las env vars NO están seteadas, sendEmail() devuelve { skipped: true }
// sin tirar error — útil en desarrollo local sin credenciales.

const RESEND_API_URL = 'https://api.resend.com/emails';

/**
 * Envía un email. Devuelve { ok, id?, skipped?, error? }. No tira excepción.
 *
 * @param {object} args
 * @param {string|string[]} args.to     destinatario(s)
 * @param {string} args.subject         asunto
 * @param {string} args.html            cuerpo HTML
 * @param {string} [args.text]          cuerpo plain text (fallback)
 * @param {string} [args.replyTo]       reply-to
 */
export async function sendEmail({ to, subject, html, text, replyTo }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;

  if (!apiKey || !from) {
    console.warn('[email] RESEND_API_KEY o RESEND_FROM no configurado — email NO enviado');
    return { ok: false, skipped: true, error: 'EMAIL_NOT_CONFIGURED' };
  }
  if (!to || !subject || !html) {
    return { ok: false, error: 'MISSING_REQUIRED_FIELDS' };
  }

  try {
    const resp = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        text,
        reply_to: replyTo,
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      console.error('[email] Resend rejected:', resp.status, detail);
      return { ok: false, error: `RESEND_HTTP_${resp.status}`, detail };
    }

    const data = await resp.json();
    return { ok: true, id: data.id };
  } catch (err) {
    console.error('[email] fetch threw:', err.message);
    return { ok: false, error: 'FETCH_FAILED', detail: err.message };
  }
}

/**
 * Construye el HTML de "Recibimos tu pedido". Sobrio + responsive. Incluye:
 *   - Greeting con nombre del cliente
 *   - Nro pedido + total + tipo entrega
 *   - CTA al link de seguimiento
 *   - Footer con razón social del local
 */
export function htmlPedidoConfirmado({ localNombre, clienteNombre, ventaNumero, total, tipoEntrega, tiempoEstimado, seguimientoUrl, telefono }) {
  const tipoLabel = tipoEntrega === 'delivery' ? 'Envío' : 'Retiro en el local';
  const totalFmt = `$${Number(total).toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
  return `
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pedido confirmado</title>
</head>
<body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111">
<div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7">
  <div style="padding:24px 28px;border-bottom:1px solid #e4e4e7">
    <div style="font-size:13px;color:#71717a;letter-spacing:.08em;text-transform:uppercase">${escapeHtml(localNombre)}</div>
    <h1 style="margin:8px 0 0;font-size:22px">¡Recibimos tu pedido, ${escapeHtml(clienteNombre)}!</h1>
  </div>
  <div style="padding:24px 28px">
    <p style="margin:0 0 16px;font-size:14px;color:#3f3f46;line-height:1.5">
      Tu pedido <strong>#${ventaNumero}</strong> ya está en la cola del local.
      Te avisamos por este mismo medio cuando esté listo.
    </p>
    <table cellpadding="0" cellspacing="0" style="width:100%;font-size:14px;margin:16px 0">
      <tr>
        <td style="padding:8px 0;color:#71717a;width:140px">Total</td>
        <td style="padding:8px 0;text-align:right;font-weight:600">${totalFmt}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#71717a">Modalidad</td>
        <td style="padding:8px 0;text-align:right">${tipoLabel}</td>
      </tr>
      ${tiempoEstimado ? `<tr>
        <td style="padding:8px 0;color:#71717a">Tiempo estimado</td>
        <td style="padding:8px 0;text-align:right">~${tiempoEstimado} min</td>
      </tr>` : ''}
    </table>
    <div style="margin:24px 0">
      <a href="${seguimientoUrl}" style="display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:500;font-size:14px">
        Ver estado del pedido
      </a>
    </div>
    ${telefono ? `<p style="margin:16px 0 0;font-size:12px;color:#71717a">
      Si necesitás cambiar algo, llamá al ${escapeHtml(telefono)}.
    </p>` : ''}
  </div>
  <div style="padding:16px 28px;background:#fafafa;border-top:1px solid #e4e4e7;font-size:11px;color:#a1a1aa;text-align:center">
    Este email fue enviado por ${escapeHtml(localNombre)} via COMANDA.
  </div>
</div>
</body>
</html>
  `.trim();
}

// Email "pedido rechazado / cancelado": cuando el comerciante anula el pedido
// (ej. está cerrado, falta producto, fuera de zona). Le avisamos al cliente
// con el motivo para que no espere indefinidamente.
export function htmlPedidoRechazado({ localNombre, clienteNombre, ventaNumero, motivo, telefono }) {
  return `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111">
<div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7">
  <div style="padding:24px 28px;border-bottom:1px solid #e4e4e7;background:#fef2f2">
    <div style="font-size:13px;color:#7f1d1d;letter-spacing:.08em;text-transform:uppercase">${escapeHtml(localNombre)}</div>
    <h1 style="margin:8px 0 0;font-size:22px;color:#991b1b">No pudimos tomar tu pedido</h1>
  </div>
  <div style="padding:24px 28px">
    <p style="margin:0 0 12px;font-size:14px;color:#3f3f46;line-height:1.5">
      ${escapeHtml(clienteNombre)}, tu pedido <strong>#${ventaNumero}</strong> fue cancelado.
    </p>
    ${motivo ? `<div style="background:#fef2f2;border-left:3px solid #dc2626;padding:12px 16px;margin:12px 0;font-size:13px;color:#3f3f46;line-height:1.5;border-radius:0 6px 6px 0">
      <strong>Motivo:</strong> ${escapeHtml(motivo)}
    </div>` : ''}
    <p style="margin:16px 0 0;font-size:13px;color:#3f3f46;line-height:1.5">
      No se realizó ningún cargo. Si pagaste online, se devuelve automáticamente.
    </p>
    ${telefono ? `<p style="margin:16px 0 0;font-size:12px;color:#71717a">
      Cualquier consulta: ${escapeHtml(telefono)}.
    </p>` : ''}
  </div>
</div>
</body>
</html>
  `.trim();
}

// Email "pedido entregado / calificá tu experiencia": invitación a dejar
// review post-delivery. Linkea al seguimiento donde aparece el form de review.
export function htmlPedidoEntregado({ localNombre, clienteNombre, ventaNumero, calificarUrl }) {
  return `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111">
<div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7">
  <div style="padding:24px 28px;border-bottom:1px solid #e4e4e7">
    <div style="font-size:13px;color:#71717a;letter-spacing:.08em;text-transform:uppercase">${escapeHtml(localNombre)}</div>
    <h1 style="margin:8px 0 0;font-size:22px">¡Gracias por tu pedido, ${escapeHtml(clienteNombre)}!</h1>
  </div>
  <div style="padding:24px 28px">
    <p style="margin:0 0 16px;font-size:14px;color:#3f3f46;line-height:1.5">
      Tu pedido <strong>#${ventaNumero}</strong> fue entregado. Esperamos que lo hayas disfrutado.
    </p>
    <p style="margin:0 0 20px;font-size:14px;color:#3f3f46;line-height:1.5">
      ¿Nos contás cómo estuvo? Tu opinión ayuda a otros clientes y al restaurante a mejorar.
    </p>
    <div style="margin:24px 0">
      <a href="${calificarUrl}" style="display:inline-block;background:#f59e0b;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:500;font-size:14px">
        ⭐ Calificar mi pedido
      </a>
    </div>
    <p style="margin:24px 0 0;font-size:12px;color:#a1a1aa;line-height:1.5">
      Tarda menos de 1 minuto. Solo se muestra tu primer nombre, es semi-anónimo.
    </p>
  </div>
</div>
</body>
</html>
  `.trim();
}

export function htmlPedidoListo({ localNombre, clienteNombre, ventaNumero, tipoEntrega, direccionLocal, telefono }) {
  const subjectAction = tipoEntrega === 'delivery'
    ? 'Salió tu pedido'
    : 'Tu pedido está listo para retirar';
  return `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111">
<div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7">
  <div style="padding:24px 28px;border-bottom:1px solid #e4e4e7">
    <div style="font-size:13px;color:#71717a;letter-spacing:.08em;text-transform:uppercase">${escapeHtml(localNombre)}</div>
    <h1 style="margin:8px 0 0;font-size:22px">${subjectAction}, ${escapeHtml(clienteNombre)}!</h1>
  </div>
  <div style="padding:24px 28px">
    <p style="margin:0 0 16px;font-size:14px;color:#3f3f46;line-height:1.5">
      Tu pedido <strong>#${ventaNumero}</strong> ${tipoEntrega === 'delivery'
        ? 'salió hace un momento y va camino a tu dirección.'
        : `te está esperando${direccionLocal ? ` en ${escapeHtml(direccionLocal)}` : ' en el local'}.`}
    </p>
    ${telefono ? `<p style="margin:16px 0 0;font-size:12px;color:#71717a">
      Cualquier cosa: ${escapeHtml(telefono)}.
    </p>` : ''}
  </div>
</div>
</body>
</html>
  `.trim();
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
