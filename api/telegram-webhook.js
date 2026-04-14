// Webhook de Telegram para Caja Efectivo.
// Comandos: /ingreso, /egreso, /saldo, /movimientos
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(200).send('ok');

    const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const ALLOWED = (process.env.TELEGRAM_ALLOWED_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

    if (!TOKEN || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: 'Missing env vars' });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const msg = req.body?.message;
    if (!msg?.text) return res.status(200).send('ok');

    const chatId = String(msg.chat.id);
    const userName = msg.from?.first_name || 'Telegram';

    // Verificar autorización
    if (!ALLOWED.includes(chatId)) {
      await send(TOKEN, chatId, '⛔ No autorizado. Tu chat ID: ' + chatId);
      return res.status(200).send('ok');
    }

    // Cargar locales para resolver nombres
    const { data: locales } = await db.from('locales').select('*').order('id');
    const localesList = locales || [];

    const text = msg.text.trim();
    const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '');

    if (cmd === '/ingreso' || cmd === '/egreso') {
      await handleMovimiento(db, TOKEN, chatId, text, cmd, localesList, userName);
    } else if (cmd === '/saldo') {
      await handleSaldo(db, TOKEN, chatId, localesList);
    } else if (cmd === '/movimientos') {
      await handleMovimientos(db, TOKEN, chatId, localesList);
    } else if (cmd === '/start' || cmd === '/help') {
      await send(TOKEN, chatId, [
        '💵 *Caja Efectivo Bot*',
        '',
        '`/ingreso MONTO DESCRIPCION LOCAL`',
        '`/egreso MONTO DESCRIPCION LOCAL`',
        '`/saldo` — total y saldo por local',
        '`/movimientos` — últimos 10',
        '',
        '_LOCAL = nombre del local (parcial ok)_',
        '_Ejemplo: /ingreso 5000 Venta del día Florida_',
      ].join('\n'));
    } else {
      await send(TOKEN, chatId, 'Comando no reconocido. Enviá /help');
    }

    return res.status(200).send('ok');
  } catch (err) {
    console.error('telegram-webhook error:', err);
    return res.status(200).send('ok');
  }
}

// ─── /ingreso & /egreso ───────────────────────────────────────────────────────
async function handleMovimiento(db, token, chatId, text, cmd, locales, userName) {
  // Formato: /ingreso|egreso MONTO DESCRIPCION LOCAL
  // Parseamos: primer token = monto, último token(s) = local, medio = descripción
  const parts = text.split(/\s+/).slice(1); // quitar el comando
  if (parts.length < 3) {
    return send(token, chatId, '❌ Formato: `' + cmd + ' MONTO DESCRIPCION LOCAL`\nEj: `' + cmd + ' 5000 Venta del día Florida`');
  }

  const montoStr = parts[0];
  const monto = parseFloat(montoStr);
  if (isNaN(monto) || monto <= 0) {
    return send(token, chatId, '❌ Monto inválido: ' + montoStr);
  }

  // Intentar matchear local con las últimas palabras
  const rest = parts.slice(1).join(' ');
  const { local, descripcion } = matchLocal(rest, locales);

  if (!local) {
    const nombres = locales.map(l => '`' + l.nombre + '`').join(', ');
    return send(token, chatId, '❌ No encontré el local. Locales disponibles: ' + nombres);
  }

  if (!descripcion.trim()) {
    return send(token, chatId, '❌ Falta la descripción.');
  }

  const signo = cmd === '/ingreso' ? 1 : -1;

  const { error } = await db.from('caja_efectivo').insert([{
    fecha: new Date().toISOString().split('T')[0],
    descripcion: descripcion.trim(),
    monto: monto * signo,
    local_id: local.id,
    creado_por: userName + ' (Telegram)',
  }]);

  if (error) {
    return send(token, chatId, '❌ Error al guardar: ' + error.message);
  }

  const emoji = cmd === '/ingreso' ? '✅' : '🔴';
  const tipo = cmd === '/ingreso' ? 'Ingreso' : 'Egreso';
  await send(token, chatId, [
    emoji + ' *' + tipo + ' registrado*',
    '',
    '💰 Monto: $' + fmt(monto),
    '📝 ' + descripcion.trim(),
    '📍 ' + local.nombre,
    '👤 ' + userName,
  ].join('\n'));
}

// ─── /saldo ───────────────────────────────────────────────────────────────────
async function handleSaldo(db, token, chatId, locales) {
  const { data } = await db.from('caja_efectivo').select('local_id, monto');
  const movs = data || [];

  const total = movs.reduce((s, m) => s + Number(m.monto), 0);
  const porLocal = {};
  movs.forEach(m => {
    porLocal[m.local_id] = (porLocal[m.local_id] || 0) + Number(m.monto);
  });

  const lines = ['💵 *CAJA EFECTIVO*', '', '*Total: $' + fmt(total) + '*', ''];
  locales.forEach(l => {
    const s = porLocal[l.id] || 0;
    const icon = s < 0 ? '🔴' : s > 0 ? '🟢' : '⚪';
    lines.push(icon + ' ' + l.nombre + ': $' + fmt(s));
  });

  await send(token, chatId, lines.join('\n'));
}

// ─── /movimientos ─────────────────────────────────────────────────────────────
async function handleMovimientos(db, token, chatId, locales) {
  const { data } = await db.from('caja_efectivo')
    .select('*')
    .order('fecha', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(10);

  const movs = data || [];
  if (!movs.length) {
    return send(token, chatId, 'Sin movimientos registrados.');
  }

  const lines = ['📋 *Últimos 10 movimientos*', ''];
  movs.forEach(m => {
    const localName = locales.find(l => l.id === m.local_id)?.nombre || '?';
    const signo = Number(m.monto) >= 0 ? '+' : '';
    const fecha = m.fecha.split('-').reverse().join('/');
    lines.push(
      '`' + fecha + '` ' + localName + '\n' +
      '  ' + m.descripcion + ' *' + signo + '$' + fmt(Number(m.monto)) + '*'
    );
  });

  await send(token, chatId, lines.join('\n'));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function matchLocal(text, locales) {
  // Intenta matchear el nombre del local al final del texto.
  // Probamos de mayor a menor cantidad de palabras al final.
  const words = text.split(/\s+/);
  for (let i = words.length - 1; i >= 1; i--) {
    const candidate = words.slice(i).join(' ').toLowerCase();
    const found = locales.find(l => l.nombre.toLowerCase() === candidate);
    if (found) return { local: found, descripcion: words.slice(0, i).join(' ') };
  }
  // Intento parcial: última palabra matchea inicio del nombre
  const last = words[words.length - 1].toLowerCase();
  const partial = locales.find(l => l.nombre.toLowerCase().startsWith(last));
  if (partial && words.length >= 2) {
    return { local: partial, descripcion: words.slice(0, -1).join(' ') };
  }
  return { local: null, descripcion: text };
}

function fmt(n) {
  return Math.abs(n).toLocaleString('es-AR', { maximumFractionDigits: 0 });
}

async function send(token, chatId, text) {
  await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    }),
  });
}
