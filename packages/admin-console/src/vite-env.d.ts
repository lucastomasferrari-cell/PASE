/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_VAPID_PUBLIC_KEY?: string;   // opcional: si falta, deshabilitamos push
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
