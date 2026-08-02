import type { APIRoute } from "astro";
import { z } from "astro:schema";

// Unica rotta renderizzata on-demand: tutto il resto del sito resta statico.
export const prerender = false;

/** Oltre questa soglia scartiamo la richiesta senza leggere il corpo. */
const MAX_BODY_BYTES = 16_384;

/** Compilare l'intero form in meno di così è comportamento da bot. */
const MIN_FILL_MS = 3_000;

const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const RESEND_ENDPOINT = "https://api.resend.com/emails";

const schema = z.object({
  nome: z
    .string()
    .trim()
    .min(2, "Inserisci il tuo nome.")
    .max(100, "Il nome è troppo lungo."),
  email: z
    .string()
    .trim()
    .max(254, "L'indirizzo email è troppo lungo.")
    .email("Controlla l'indirizzo email."),
  messaggio: z
    .string()
    .trim()
    .min(10, "Scrivi un messaggio un po' più esteso.")
    .max(5_000, "Il messaggio supera i 5000 caratteri."),
  consenso: z.literal("on", {
    message: "Devi accettare l'informativa privacy per inviare il messaggio.",
  }),
  // Honeypot: invisibile agli utenti, i bot lo compilano.
  sito: z.string().max(0),
  // Millisecondi tra il caricamento della pagina e il submit.
  elapsed: z.coerce.number().int().min(MIN_FILL_MS),
  "cf-turnstile-response": z
    .string()
    .min(1, "Completa la verifica antispam.")
    .max(2_048),
});

/** Rimuove CR/LF: impedisce di iniettare header nell'email. */
const stripCRLF = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

/**
 * In produzione i valori arrivano dai secret del Worker (`locals.runtime.env`).
 * `import.meta.env` serve solo come fallback per lo sviluppo locale via .env:
 * su Cloudflare i secret non esistono a build time, quindi lì è sempre vuoto.
 */
const readEnv = (locals: App.Locals) => {
  const runtime = locals.runtime?.env;
  return {
    resendApiKey: runtime?.RESEND_API_KEY ?? import.meta.env.RESEND_API_KEY,
    to: runtime?.CONTACT_TO_EMAIL ?? import.meta.env.CONTACT_TO_EMAIL,
    from: runtime?.CONTACT_FROM_EMAIL ?? import.meta.env.CONTACT_FROM_EMAIL,
    turnstileSecret:
      runtime?.TURNSTILE_SECRET_KEY ?? import.meta.env.TURNSTILE_SECRET_KEY,
  };
};

export const POST: APIRoute = async ({ request, locals }) => {
  // Il form è servito dallo stesso host: le POST cross-origin non ci interessano.
  const origin = request.headers.get("origin");
  if (origin !== null) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (originHost !== new URL(request.url).host) {
      return json(403, { error: "Richiesta non consentita." });
    }
  }

  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return json(413, { error: "Il messaggio è troppo lungo." });
  }

  const { resendApiKey, to, from, turnstileSecret } = readEnv(locals);
  // Fail closed: senza configurazione completa non inviamo nulla e, soprattutto,
  // non lasciamo passare richieste non verificate.
  if (!resendApiKey || !to || !from || !turnstileSecret) {
    console.error(
      "[contact] configurazione incompleta: il form è disabilitato. Controlla RESEND_API_KEY, CONTACT_TO_EMAIL, CONTACT_FROM_EMAIL, TURNSTILE_SECRET_KEY.",
    );
    return json(500, {
      error: "Il modulo non è configurato correttamente. Riprova più tardi.",
    });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(400, { error: "Richiesta non valida." });
  }

  const parsed = schema.safeParse(Object.fromEntries(form));
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors;
    // Honeypot e timing non meritano spiegazioni: chi li innesca non è un utente.
    if (fieldErrors.sito || fieldErrors.elapsed) {
      return json(400, { error: "Invio non riuscito. Riprova." });
    }
    // Il token non ha un campo visibile a cui agganciare l'errore: messaggio dedicato.
    if (fieldErrors["cf-turnstile-response"]) {
      return json(400, {
        error: "Completa la verifica antispam e riprova.",
      });
    }
    return json(422, {
      error: "Controlla i campi segnalati.",
      fields: fieldErrors,
    });
  }
  const data = parsed.data;

  // Il token del client da solo non vale nulla: va verificato server-side.
  const verifyBody = new FormData();
  verifyBody.append("secret", turnstileSecret);
  verifyBody.append("response", data["cf-turnstile-response"]);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) verifyBody.append("remoteip", ip);

  try {
    const verifyResponse = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      body: verifyBody,
    });
    const outcome = (await verifyResponse.json()) as {
      success?: boolean;
      "error-codes"?: string[];
    };
    if (outcome.success !== true) {
      console.warn("[contact] Turnstile ha respinto il token:", outcome["error-codes"]);
      return json(400, { error: "Verifica antispam non superata. Riprova." });
    }
  } catch (error) {
    console.error("[contact] verifica Turnstile non riuscita:", error);
    return json(502, { error: "Verifica antispam non disponibile. Riprova." });
  }

  const nome = stripCRLF(data.nome);
  const email = stripCRLF(data.email);

  const payload = {
    // From sul nostro dominio, così SPF e DKIM restano validi.
    from,
    to: [to],
    // Reply-To senza display name: l'indirizzo nudo non richiede quoting.
    reply_to: email,
    subject: `Nuovo messaggio dal sito — ${nome}`,
    // Solo testo: nessun HTML da sanificare, nessun rischio di injection.
    text: [`Nome: ${nome}`, `Email: ${email}`, "", "Messaggio:", data.messaggio].join(
      "\n",
    ),
  };

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${resendApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      // Il dettaglio resta nei log: al client non diciamo nulla del provider.
      console.error(
        "[contact] Resend ha risposto",
        response.status,
        await response.text(),
      );
      return json(502, { error: "Invio non riuscito. Riprova più tardi." });
    }
  } catch (error) {
    console.error("[contact] chiamata a Resend non riuscita:", error);
    return json(502, { error: "Invio non riuscito. Riprova più tardi." });
  }

  return json(200, { ok: true });
};

/** Qualsiasi metodo diverso da POST non è previsto su questa rotta. */
export const ALL: APIRoute = () =>
  json(405, { error: "Metodo non consentito." });
