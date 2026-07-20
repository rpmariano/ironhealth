// IronHealth · analyze-run Edge Function
// Modo normal: recebe 1+ prints de uma app de corrida (Strava, Garmin, etc.),
// extrai distância/duração/splits com o Gemini e grava a corrida em `runs`.
// O tipo de corrida (kind/training_type/details) é sempre escolhido pelo
// utilizador no cliente — a IA só lê os números do ecrã, nunca infere o tipo.
// Modo reanálise (run_id presente): repesca os prints já guardados dessa
// corrida no Storage, volta a analisar e substitui só os campos numéricos
// (kind/training_type/details/notes mantêm-se como estavam).
// A chave Gemini vive apenas aqui (secret GEMINI_API_KEY), nunca no cliente.

import { createClient } from "jsr:@supabase/supabase-js@2";

const MAX_PHOTOS = 6;
const MAX_NOTES_LENGTH = 500;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GEMINI_MODEL = "gemini-flash-latest";
const GEMINI_TIMEOUT_MS = 40000;
const GEMINI_RETRIES = 1;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    distance_km: { type: "NUMBER", nullable: true },
    duration_seconds: { type: "NUMBER", nullable: true },
    split_5k_seconds: { type: "NUMBER", nullable: true },
    split_10k_seconds: { type: "NUMBER", nullable: true },
    split_21k_seconds: { type: "NUMBER", nullable: true },
  },
  required: ["distance_km", "duration_seconds", "split_5k_seconds", "split_10k_seconds", "split_21k_seconds"],
};

function buildPrompt(notes: string | null): string {
  let prompt =
    "As imagens seguintes são capturas de ecrã (screenshots) de uma app de registo de corrida " +
    "(ex.: Strava, Garmin Connect, Nike Run Club, ou similar), todas da MESMA corrida " +
    "(possivelmente ecrãs diferentes da mesma atividade). Extrai:\n" +
    "- distance_km: distância total percorrida, em quilómetros (ex.: 10.42).\n" +
    "- duration_seconds: duração total (tempo em movimento/total da atividade), em segundos.\n" +
    "- split_5k_seconds / split_10k_seconds / split_21k_seconds: se o ecrã mostrar o tempo " +
    "parcial até aos 5km, 10km ou 21km (splits/lap times), converte para segundos. Se a corrida " +
    "não chegar a essa distância, ou o split não estiver visível, devolve null nesse campo.\n" +
    "Não inventes valores — se algum destes dados não estiver visível em nenhuma imagem, devolve null.";
  if (notes && notes.trim()) {
    prompt +=
      "\n\nO utilizador deixou esta observação sobre a corrida — usa-a como contexto " +
      `adicional: "${notes.trim()}"`;
  }
  prompt += "\n\nResponde apenas com JSON estruturado conforme o schema.";
  return prompt;
}

const GEMINI_RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);

async function fetchGeminiWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = GEMINI_TIMEOUT_MS,
  retries = GEMINI_RETRIES,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok && GEMINI_RETRYABLE_STATUSES.has(res.status) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      if (attempt < retries) continue;
      throw new Error(
        "O Gemini demorou demasiado tempo a responder (mesmo depois de tentar de novo). Tenta outra vez daqui a pouco.",
      );
    }
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

type GeminiUsage = { input_tokens: number; output_tokens: number };
type RunFields = {
  distance_km: number | null;
  duration_seconds: number | null;
  split_5k_seconds: number | null;
  split_10k_seconds: number | null;
  split_21k_seconds: number | null;
};

async function analyzeWithGemini(
  images: string[],
  mime: string,
  notes: string | null,
  geminiKey: string,
): Promise<{ fields: RunFields; usage: GeminiUsage }> {
  const parts: unknown[] = [{ text: buildPrompt(notes) }];
  for (const b64 of images) {
    parts.push({ inline_data: { mime_type: mime, data: b64 } });
  }

  const geminiRes = await fetchGeminiWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          response_mime_type: "application/json",
          response_schema: RESPONSE_SCHEMA,
        },
      }),
    },
  );

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    console.error("Gemini error:", geminiRes.status, errText);
    if (geminiRes.status === 429) {
      throw new Error(
        "O Gemini atingiu o limite de pedidos gratuitos neste momento. Espera um pouco e tenta novamente.",
      );
    }
    throw new Error(`Análise falhou (Gemini ${geminiRes.status}). Tenta novamente.`);
  }

  const geminiJson = await geminiRes.json();
  const usage: GeminiUsage = {
    input_tokens: Number(geminiJson?.usageMetadata?.promptTokenCount) || 0,
    output_tokens: Number(geminiJson?.usageMetadata?.candidatesTokenCount) || 0,
  };
  const rawText = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    console.error("Gemini devolveu JSON inválido:", rawText);
    throw new Error("A análise devolveu um formato inesperado. Tenta novamente.");
  }

  const num = (v: unknown): number | null =>
    typeof v === "number" && isFinite(v) && v >= 0 ? v : null;

  const fields: RunFields = {
    distance_km: num(parsed.distance_km),
    duration_seconds: num(parsed.duration_seconds),
    split_5k_seconds: num(parsed.split_5k_seconds),
    split_10k_seconds: num(parsed.split_10k_seconds),
    split_21k_seconds: num(parsed.split_21k_seconds),
  };

  if (fields.distance_km === null && fields.duration_seconds === null) {
    throw new Error("Não foi possível ler a distância ou a duração nas imagens. Tenta outro ângulo ou mais luz.");
  }

  return { fields, usage };
}

const VALID_KINDS = new Set(["simples", "treino", "competicao"]);
const VALID_TRAINING_TYPES = new Set(["continuo", "longo", "tempo", "recuperacao", "intervalos", "sprints"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Método não suportado" }, 405);
  }

  try {
    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiKey) {
      return jsonResponse({ error: "GEMINI_API_KEY não configurada no servidor" }, 500);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Sem autorização" }, 401);
    }
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: userData, error: userError } = await sb.auth.getUser();
    if (userError || !userData?.user) {
      return jsonResponse({ error: "Sessão inválida" }, 401);
    }
    const userId = userData.user.id;

    const body = await req.json();
    const rawNotes = typeof body.notes === "string" ? body.notes.slice(0, MAX_NOTES_LENGTH) : null;

    // ── Modo reanálise: run_id presente ────────────────────────────────
    if (typeof body.run_id === "string" && body.run_id) {
      const runId = body.run_id;
      const { data: existing, error: fetchError } = await sb
        .from("runs")
        .select("id, photo_paths")
        .eq("id", runId)
        .eq("user_id", userId)
        .maybeSingle();
      if (fetchError) return jsonResponse({ error: `Falha a procurar corrida: ${fetchError.message}` }, 500);
      if (!existing) return jsonResponse({ error: "Corrida não encontrada" }, 404);

      const photoPaths: string[] = existing.photo_paths || [];
      if (photoPaths.length === 0) {
        return jsonResponse({ error: "Esta corrida não tem imagens guardadas para reanalisar" }, 400);
      }

      const images: string[] = [];
      for (const path of photoPaths) {
        const { data: fileBlob, error: downloadError } = await sb.storage.from("run-photos").download(path);
        if (downloadError || !fileBlob) {
          return jsonResponse({ error: `Falha a obter imagem guardada: ${downloadError?.message ?? "desconhecida"}` }, 500);
        }
        images.push(bytesToBase64(new Uint8Array(await fileBlob.arrayBuffer())));
      }

      let result;
      try {
        result = await analyzeWithGemini(images, "image/jpeg", rawNotes, geminiKey);
      } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : "Falha na reanálise." }, 502);
      }

      const { data: updated, error: updateError } = await sb
        .from("runs")
        .update({ ...result.fields, notes: rawNotes })
        .eq("id", runId)
        .select()
        .single();
      if (updateError) return jsonResponse({ error: `Falha a atualizar corrida: ${updateError.message}` }, 500);

      return jsonResponse({ run: updated, usage: result.usage });
    }

    // ── Modo normal: nova corrida a partir de imagens ─────────────────
    const { mime_type, date } = body;
    const kind = VALID_KINDS.has(body.kind) ? body.kind : "simples";
    const trainingType = kind === "treino" && VALID_TRAINING_TYPES.has(body.training_type)
      ? body.training_type
      : null;
    const details = (body.details && typeof body.details === "object") ? body.details : null;

    let images: string[] = [];
    if (Array.isArray(body.images)) {
      images = body.images.filter((s: unknown) => typeof s === "string" && s.length > 0);
    }

    if (images.length === 0) {
      return jsonResponse({ error: "Nenhuma imagem recebida" }, 400);
    }
    if (images.length > MAX_PHOTOS) {
      return jsonResponse({ error: `Máximo de ${MAX_PHOTOS} imagens por corrida` }, 400);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
      return jsonResponse({ error: "Data inválida (esperado YYYY-MM-DD)" }, 400);
    }
    const mime = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]
        .includes(mime_type)
      ? mime_type
      : "image/jpeg";
    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";

    // 1. Upload de todas as imagens para o bucket privado, pasta do próprio utilizador
    const photoPaths: string[] = [];
    for (const b64 of images) {
      const path = `${userId}/${crypto.randomUUID()}.${ext}`;
      const { error: uploadError } = await sb.storage
        .from("run-photos")
        .upload(path, base64ToBytes(b64), { contentType: mime });
      if (uploadError) {
        if (photoPaths.length) await sb.storage.from("run-photos").remove(photoPaths);
        return jsonResponse({ error: `Falha no upload da imagem: ${uploadError.message}` }, 500);
      }
      photoPaths.push(path);
    }

    // 2. Análise Gemini — todas as imagens numa só chamada (partes múltiplas)
    let result;
    try {
      result = await analyzeWithGemini(images, mime, rawNotes, geminiKey);
    } catch (e) {
      await sb.storage.from("run-photos").remove(photoPaths);
      return jsonResponse({ error: e instanceof Error ? e.message : "Falha na análise." }, 502);
    }

    // 3. Gravar corrida
    const { data: run, error: insertError } = await sb
      .from("runs")
      .insert({
        user_id: userId,
        date,
        photo_paths: photoPaths,
        kind,
        training_type: trainingType,
        details,
        notes: rawNotes,
        ...result.fields,
      })
      .select()
      .single();
    if (insertError) {
      await sb.storage.from("run-photos").remove(photoPaths);
      return jsonResponse({ error: `Falha a gravar corrida: ${insertError.message}` }, 500);
    }

    return jsonResponse({ run, usage: result.usage });
  } catch (e) {
    console.error("Erro inesperado:", e);
    return jsonResponse({ error: "Erro inesperado no servidor" }, 500);
  }
});
