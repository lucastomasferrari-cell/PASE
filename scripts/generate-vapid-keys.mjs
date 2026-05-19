// Genera un par de VAPID keys (public + private) para Web Push.
// Correr 1 sola vez. Lucas guarda:
//   - VAPID_PUBLIC_KEY  → como env var pública (también va al frontend).
//   - VAPID_PRIVATE_KEY → como GitHub secret + Supabase Vault.
//
// Uso:
//   node scripts/generate-vapid-keys.mjs

import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
console.log('\n🔑 VAPID KEYS GENERADAS\n');
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
console.log('\n📝 Configurá estos secrets:\n');
console.log('GitHub repo → Settings → Secrets:');
console.log('  - VAPID_PUBLIC_KEY  =', keys.publicKey);
console.log('  - VAPID_PRIVATE_KEY =', keys.privateKey);
console.log('  - VAPID_SUBJECT     = mailto:lucastomasferrari@gmail.com');
console.log('\nVercel → admin-console project → Environment Variables:');
console.log('  - VITE_VAPID_PUBLIC_KEY =', keys.publicKey);
console.log('\nLuego correr la migration 202605201700_admin_push_subscriptions.sql.');
