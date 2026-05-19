// Helper invocado por el workflow auto-fix-bug.yml para marcar un ticket
// como resuelto o como "PR pendiente de approval".
//
// Args:
//   1. ticket_id
//   2. commit_sha o pr_url
//   3. mode: 'commit' | 'pr'
//   4. pr_number (solo si mode='pr')
//
// Env:
//   - SUPABASE_URL
//   - SUPABASE_SERVICE_KEY

import { createClient } from '@supabase/supabase-js';

const [ticketId, ref, mode, prNumber] = process.argv.slice(2);
if (!ticketId || !ref || !mode) {
  console.error('Usage: node auto-fix-mark-resolved.mjs <ticket_id> <ref> <commit|pr> [pr_number]');
  process.exit(1);
}

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// Append comentario al ticket (no usamos RPC porque requiere JWT humano).
async function addComment(texto) {
  const { data: cur } = await sb.from('tickets_soporte').select('comentarios').eq('id', ticketId).single();
  const actuales = Array.isArray(cur?.comentarios) ? cur.comentarios : [];
  await sb.from('tickets_soporte')
    .update({
      comentarios: [
        ...actuales,
        { autor_user_id: null, autor_rol: 'agent_bot', texto, created_at: new Date().toISOString() },
      ],
    })
    .eq('id', ticketId);
}

if (mode === 'commit') {
  const url = `https://github.com/${process.env.GITHUB_REPOSITORY}/commit/${ref}`;
  await sb.rpc('agent_update_ticket', {
    p_ticket_id: ticketId,
    p_status: 'resolved',
    p_log_entry: { event: 'auto_merged', commit: ref },
    p_diff_summary: `Commit directo: ${ref.slice(0, 8)}`,
  });
  await addComment(`✓ Resuelto automáticamente.\n\nCommit: ${url}\n\nProbá refrescar la pantalla y reintentá la operación. Si sigue fallando, abrime otro ticket.`);
  // También marcamos estado='cerrado' en el ticket principal.
  await sb.from('tickets_soporte').update({ estado: 'cerrado', resuelto_at: new Date().toISOString() }).eq('id', ticketId);
} else if (mode === 'pr') {
  await sb.rpc('agent_update_ticket', {
    p_ticket_id: ticketId,
    p_status: 'pr_opened',
    p_pr_url: ref,
    p_pr_number: prNumber ? parseInt(prNumber) : null,
    p_log_entry: { event: 'pr_opened', url: ref },
    p_diff_summary: 'Cambio grande (>50 líneas o >5 archivos), requiere aprobación humana',
  });
  await addComment(`🔍 Propuesta de fix lista, pero el cambio es grande así que Lucas tiene que revisarlo antes de mergear.\n\nPR: ${ref}\n\nApenas lo apruebe y se deploye, refrescá y probá de nuevo.`);
} else {
  console.error('Unknown mode:', mode);
  process.exit(1);
}

console.log('Ticket actualizado:', ticketId);
