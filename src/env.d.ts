/// <reference path="../.astro/types.d.ts" />

/** Binding e secret del Worker Cloudflare. Nessuno di questi valori sta nel repo. */
interface Env {
  /** Chiave API Resend. */
  RESEND_API_KEY?: string;
  /** Destinatario dei messaggi del form contatti. */
  CONTACT_TO_EMAIL?: string;
  /** Mittente verificato su Resend, es. `Sito X <no-reply@dominio.it>`. */
  CONTACT_FROM_EMAIL?: string;
  /** Secret key del widget Turnstile. */
  TURNSTILE_SECRET_KEY?: string;
}

type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {}
}

interface ImportMetaEnv {
  /** Site key Turnstile: pubblica, inlineata nell'HTML a build time. */
  readonly PUBLIC_TURNSTILE_SITE_KEY?: string;
  // Fallback per lo sviluppo locale via .env. In produzione i valori
  // arrivano da locals.runtime.env, non da qui.
  readonly RESEND_API_KEY?: string;
  readonly CONTACT_TO_EMAIL?: string;
  readonly CONTACT_FROM_EMAIL?: string;
  readonly TURNSTILE_SECRET_KEY?: string;
}

interface Window {
  turnstile?: {
    render: (
      container: string | HTMLElement,
      options: { sitekey: string; theme?: "auto" | "light" | "dark" },
    ) => string | undefined;
    reset: (widgetId?: string) => void;
  };
}
