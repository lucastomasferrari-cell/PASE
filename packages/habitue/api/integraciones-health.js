// Health check de integraciones — devuelve qué providers tienen credenciales
// en las env vars de Vercel. Lo usa la página Integraciones para mostrar
// "Conectado" sin tener que tocar la tabla `integraciones`.
//
// No expone los valores, solo si están presentes.

export default function handler(req, res) {
  const presentes = (...keys) => keys.every((k) => !!process.env[k]);

  res.status(200).json({
    ok: true,
    providers: {
      whatsapp_api:    presentes('WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'),
      email:           presentes('RESEND_API_KEY', 'RESEND_FROM'),
      meta_ads:        presentes('META_ADS_TOKEN', 'META_ADS_ACCOUNT_ID'),
      google_maps:     presentes('GOOGLE_PLACES_API_KEY'),
      google_ads:      presentes('GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID'),
      search_console:  presentes('SEARCH_CONSOLE_REFRESH_TOKEN', 'SEARCH_CONSOLE_SITE_URL'),
      instagram:       presentes('IG_ACCESS_TOKEN', 'IG_BUSINESS_ID'),
    },
  });
}
