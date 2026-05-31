/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_ANON_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Variables embebidas en build vía vite.config.ts → `define`.
// Hash corto del commit del último deploy + timestamp ISO del build.
// Usadas por src/lib/versionCheck.ts para detectar deploys nuevos.
declare const __BUILD_VERSION__: string;
declare const __BUILT_AT__: string;
