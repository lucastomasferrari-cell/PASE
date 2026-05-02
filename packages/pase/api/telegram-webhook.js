// Webhook de Telegram para Caja Efectivo.
// Comandos: /ingreso, /egreso, /saldo, /movimientos
//
// ─── Multitenant & seguridad ─────────────────────────────────────────────────
// Este endpoint usa SUPABASE_SERVICE_KEY (bypassa RLS) porque actúa como
// "operador automatizado" sin sesión de Auth. El service_role sólo es seguro
// porque ANTES de cualquier query validamos:
//   1. chat_id ∈ env TELEGRAM_CHAT_USERS  → resuelve a usuarios.id
//   2. usuarios.activo = true             → usuario habilitado
//   3. local.tenant_id === usuario.tenant_id en cada operación con local
// Si alguna validación falla → 403 al usuario, sin tocar DB.
//
// Mapping de chat_ids: env var TELEGRAM_CHAT_USERS con formato
//   "chatIdA:userIdA,chatIdB:userIdB"
// donde chatId es numérico de Telegram (string) y userId es usuarios.id (int).
// Para agregar un usuario nuevo:
//   1. Crear el usuario en PASE (módulo Usuarios) bajo el tenant correcto.
//   2. Pedirle al usuario que envíe /start al bot y copiar su chat_id.
//   3. Agregar "chatId:userId" al env TELEGRAM_CHAT_USERS en Vercel.
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(200).send('ok');

    const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

    if (!TOKEN || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: 'Missing env vars' });
    }

    const chatUsers = parseChatUsersEnv(process.env.TELEGRAM_CHAT_USERS);

    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const msg = req.body?.message;
    if (!msg?.text) return res.status(200).send('ok');

    const chatId = String(msg.chat.id);
    const text = msg.text.trim();
    const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '');

    // ─── Auth: chat_id → user_id → usuarios.tenant_id ──────────────────────
    const userId = chatUsers.get(chatId);
    if (userId == null) {
      log({ chat_id: chatId, cmd, result: 'unauthorized_unknown_chat' });
      await send(TOKEN, chatId, '⛔ No autorizado. Tu chat ID: ' + chatId);
      return res.status(200).send('ok');
    }

    const { data: usuario, error: usuarioErr } = await db.from('usuarios')
      .select('id, nombre, tenant_id, activo')
      .eq('id', userId)
      .maybeSingle();

    if (usuarioErr || !usuario) {
      log({ chat_id: chatId, user_id: userId, cmd, result: 'user_not_found' });
      await send(TOKEN, chatId, '⛔ Usuario no encontrado en PASE. Avisá al administrador.');
      return res.status(200).send('ok');
    }
    if (!usuario.activo) {
      log({ chat_id: chatId, user_id: userId, cmd, result: 'user_inactive' });
      await send(TOKEN, chatId, '⛔ Tu usuario está inactivo. Avisá al administrador.');
      return res.status(200).send('ok');
    }
    if (!usuario.tenant_id) {
      log({ chat_id: chatId, user_id: userId, cmd, result: 'user_no_tenant' });
      await send(TOKEN, chatId, '⛔ Tu usuario no tiene tenant asignado. Avisá al administrador.');
      return res.status(200).send('ok');
    }

    // Locales del tenant del usuario (filtro defense-in-depth).
    const { data: locales } = await db.from('locales')
      .select('*')
      .eq('tenant_id', usuario.tenant_id)
      .order('id');
    const localesList = locales || [];

    const ctx = {
      db,
      token: TOKEN,
      chatId,
      usuario,
      locales: localesList,
    };

    if (cmd === '/ingreso' || cmd === '/egreso') {
      await handleMovimiento(ctx, text, cmd);
    } else if (cmd === '/saldo') {
      await handleSaldo(ctx);
    } else if (cmd === '/movimientos') {
      await handleMovimientos(ctx);
    } else if (cmd === '/start' || cmd === '/help') {
      log({ chat_id: chatId, user_id: usuario.id, tenant_id: usuario.tenant_id, cmd, result: 'ok' });
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
      log({ chat_id: chatId, user_id: usuario.id, tenant_id: usuario.tenant_id, cmd, result: 'unknown_command' });
      await send(TOKEN, chatId, 'Comando no reconocido. Enviá /help');
    }

    return res.status(200).send('ok');
  } catch (err) {
    console.error('telegram-webhook error:', err);
    return res.status(200).send('ok');
  }
}

// ─── /ingreso & /egreso ───────────────────────────────────────────────────────
async function handleMovimiento(ctx, text, cmd) {
  const { db, token, chatId, usuario, locales } = ctx;
  // Formato: /ingreso|egreso MONTO DESCRIPCION LOCAL
  const parts = text.split(/\s+/).slice(1);
  if (parts.length < 3) {
    log({ chat_id: chatId, user_id: usuario.id, tenant_id: usuario.tenant_id, cmd, result: 'bad_format' });
    return send(token, chatId, '❌ Formato: `' + cmd + ' MONTO DESCRIPCION LOCAL`\nEj: `' + cmd + ' 5000 Venta del día Florida`');
  }

  const montoStr = parts[0];
  const monto = parseMonto(montoStr);
  if (!Number.isFinite(monto) || monto <= 0) {
    log({ chat_id: chatId, user_id: usuario.id, tenant_id: usuario.tenant_id, cmd, result: 'bad_monto' });
    return send(token, chatId, '❌ Monto inválido: ' + montoStr);
  }

  const rest = parts.slice(1).join(' ');
  const { local, descripcion } = matchLocal(rest, locales);

  if (!local) {
    const nombres = locales.map(l => '`' + l.nombre + '`').join(', ');
    log({ chat_id: chatId, user_id: usuario.id, tenant_id: usuario.tenant_id, cmd, result: 'local_not_found' });
    return send(token, chatId, '❌ No encontré el local. Locales disponibles: ' + nombres);
  }

  // Defense-in-depth: el local ya viene del SELECT filtrado por tenant del
  // usuario, pero chequeamos explícitamente. Si esta validación falla es un
  // bug grave y conviene cortar.
  if (local.tenant_id !== usuario.tenant_id) {
    log({ chat_id: chatId, user_id: usuario.id, tenant_id: usuario.tenant_id, cmd, local_id: local.id, result: 'local_cross_tenant' });
    return send(token, chatId, '❌ No tenés permiso sobre ese local.');
  }

  if (!descripcion.trim()) {
    log({ chat_id: chatId, user_id: usuario.id, tenant_id: usuario.tenant_id, cmd, result: 'no_description' });
    return send(token, chatId, '❌ Falta la descripción.');
  }

  const signo = cmd === '/ingreso' ? 1 : -1;

  const { error } = await db.from('caja_efectivo').insert([{
    fecha: new Date().toISOString().split('T')[0],
    descripcion: descripcion.trim(),
    monto: monto * signo,
    local_id: local.id,
    tenant_id: usuario.tenant_id,
    creado_por: usuario.nombre + ' (Telegram)',
  }]);

  if (error) {
    log({ chat_id: chatId, user_id: usuario.id, tenant_id: usuario.tenant_id, cmd, local_id: local.id, result: 'db_error' });
    return send(token, chatId, '❌ Error al guardar: ' + error.message);
  }

  log({ chat_id: chatId, user_id: usuario.id, tenant_id: usuario.tenant_id, cmd, local_id: local.id, result: 'ok' });

  const emoji = cmd === '/ingreso' ? '✅' : '🔴';
  const tipo = cmd === '/ingreso' ? 'Ingreso' : 'Egreso';
  await send(token, chatId, [
    emoji + ' *' + tipo + ' registrado*',
    '',
    '💰 Monto: $' + fmt(monto),
    '📝 ' + descripcion.trim(),
    '📍 ' + local.nombre,
    '👤 ' + usuario.nombre,
  ].join('\n'));
}

// ─── /saldo ───────────────────────────────────────────────────────────────────
async function handleSaldo(ctx) {
  const { db, token, chatId, usuario, locales } = ctx;
  const { data } = await db.from('caja_efectivo')
    .select('local_id, monto')
    .eq('tenant_id', usuario.tenant_id);
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

  log({ chat_id: chatId, user_id: usuario.id, tenant_id: usuario.tenant_id, cmd: '/saldo', result: 'ok' });
  await send(token, chatId, lines.join('\n'));
}

// ─── /movimientos ─────────────────────────────────────────────────────────────
async function handleMovimientos(ctx) {
  const { db, token, chatId, usuario, locales } = ctx;
  const { data } = await db.from('caja_efectivo')
    .select('*')
    .eq('tenant_id', usuario.tenant_id)
    .order('fecha', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(10);

  const movs = data || [];
  if (!movs.length) {
    log({ chat_id: chatId, user_id: usuario.id, tenant_id: usuario.tenant_id, cmd: '/movimientos', result: 'empty' });
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

  log({ chat_id: chatId, user_id: usuario.id, tenant_id: usuario.tenant_id, cmd: '/movimientos', result: 'ok' });
  await send(token, chatId, lines.join('\n'));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Parsea TELEGRAM_CHAT_USERS="chatId:userId,chatId:userId" → Map<string, number>.
function parseChatUsersEnv(raw) {
  const map = new Map();
  if (!raw) return map;
  for (const pair of raw.split(',')) {
    const [chatId, userIdStr] = pair.split(':').map(s => s.trim());
    if (!chatId || !userIdStr) continue;
    const userId = parseInt(userIdStr, 10);
    if (!Number.isFinite(userId)) continue;
    map.set(chatId, userId);
  }
  return map;
}

// Parser de monto tolerante al formato es-AR. Equivalente a
// src/lib/utils.ts → parseMonto, replicado acá porque api/ es plain JS.
//   "25.140.377,14" → 25140377.14
//   "25.140"        → 25140    (3 dígitos detrás → miles)
//   "25.14"         → 25.14    (2 dígitos detrás → decimal)
//   "1,234.56"      → 1234.56
function parseMonto(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v).trim();
  if (!s) return 0;

  const dots = (s.match(/\./g) || []).length;
  const commas = (s.match(/,/g) || []).length;

  let normalized;
  if (dots === 0 && commas === 0) {
    normalized = s;
  } else if (dots > 0 && commas > 0) {
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > lastDot) {
      normalized = s.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = s.replace(/,/g, '');
    }
  } else {
    const sep = dots > 0 ? '.' : ',';
    const count = dots > 0 ? dots : commas;
    if (count > 1) {
      normalized = s.split(sep).join('');
    } else {
      const idx = s.lastIndexOf(sep);
      const after = s.length - idx - 1;
      if (after === 3) {
        normalized = s.split(sep).join('');
      } else {
        normalized = sep === ',' ? s.replace(',', '.') : s;
      }
    }
  }

  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

function matchLocal(text, locales) {
  const words = text.split(/\s+/);
  for (let i = words.length - 1; i >= 1; i--) {
    const candidate = words.slice(i).join(' ').toLowerCase();
    const found = locales.find(l => l.nombre.toLowerCase() === candidate);
    if (found) return { local: found, descripcion: words.slice(0, i).join(' ') };
  }
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

// Log estructurado: solo metadata (no montos/descripciones/datos personales).
function log(obj) {
  console.log('[telegram-webhook]', JSON.stringify(obj));
}
