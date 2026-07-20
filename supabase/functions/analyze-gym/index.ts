// IronHealth · analyze-gym Edge Function
// Modo normal: recebe 1+ prints de uma app de ginásio (Hevy, Strong, etc.),
// analisa com Gemini e grava workout_sessions + workout_session_sets na BD.
// Modo reanálise (session_id presente): repesca os prints já guardados dessa
// sessão no Storage, volta a chamar o Gemini com as observações atualizadas,
// e substitui os sets existentes pelos novos.
// Ao contrário da Nutrição, não há modo de entrada manual por texto aqui —
// séries/repetições/carga são números simples que o utilizador introduz
// diretamente no cliente, sem precisar de estimativa da IA.
// A chave Gemini vive apenas aqui (secret GEMINI_API_KEY), nunca no cliente.

import { createClient } from "jsr:@supabase/supabase-js@2";

const MAX_PHOTOS = 6;
const MAX_NOTES_LENGTH = 500;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Alias que segue sempre o modelo flash estável mais recente — evita 404s
// quando a Google descontinua modelos para contas novas (mesmo alias usado
// em analyze-meal/analyze-body).
const GEMINI_MODEL = "gemini-flash-latest";
// Tempo máximo por chamada ao Gemini antes de desistir e tentar mais uma vez.
const GEMINI_TIMEOUT_MS = 40000;
const GEMINI_RETRIES = 1;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    session_name: { type: "STRING" },
    exercises: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          sets: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                reps: { type: "NUMBER", nullable: true },
                weight: { type: "NUMBER", nullable: true },
              },
              required: ["reps", "weight"],
            },
          },
        },
        required: ["name", "sets"],
      },
    },
  },
  required: ["session_name", "exercises"],
};

function buildPrompt(notes: string | null): string {
  let prompt =
    "As imagens seguintes são capturas de ecrã (screenshots) de uma app de registo de " +
    "treino de ginásio (ex.: Hevy, Strong, ou similar), todas da MESMA sessão de treino " +
    "(possivelmente ecrãs diferentes da mesma sessão). Combina a informação de todas as " +
    "imagens e identifica cada exercício distinto, sem o repetir se aparecer em mais do " +
    "que um ecrã. Para cada exercício, extrai a lista de séries pela ordem em que aparecem, " +
    "cada uma com repetições (reps) e carga em quilogramas (weight). Se uma série não tiver " +
    "reps ou carga visíveis/registados, devolve null nesse campo (não inventes valores). " +
    "Sugere também um nome curto para a sessão (session_name) com base no tipo de treino " +
    "(ex.: \"Peito e Tríceps\", \"Pernas\", \"Full Body\"), em português de Portugal. " +
    "Usa nomes de exercícios em português de Portugal quando o exercício for conhecido " +
    "por esse nome, mantendo o nome original da app quando não houver tradução óbvia.";
  if (notes && notes.trim()) {
    prompt +=
      "\n\nO utilizador deixou esta observação sobre a sessão — usa-a como contexto " +
      `adicional: "${notes.trim()}"`;
  }
  prompt += "\n\nResponde apenas com JSON estruturado conforme o schema.";
  return prompt;
}

// Estados HTTP de sobrecarga momentânea do lado da Google (500/502/503/504) —
// vale a pena repetir estes, porque costumam resolver-se à segunda. O 429
// (limite de pedidos excedido) fica DE FORA de propósito: repetir logo a
// seguir só volta a bater no mesmo limite por minuto — e até o acelera — por
// isso passa já ao chamador com uma mensagem clara. Erros "permanentes"
// (400, 401, 403...) também passam sempre à primeira.
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

// Chunked para evitar exceder o limite de argumentos de String.fromCharCode
// com fotos grandes.
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Contagem de tokens de uma chamada ao Gemini (usageMetadata da resposta),
// usada para estimar o custo real da API — ver admin_logs/painel de custos.
type GeminiUsage = { input_tokens: number; output_tokens: number };

type GymSet = { reps: number | null; weight: number | null };
type GymExercise = { name: string; sets: GymSet[] };

// Chama o Gemini com as imagens (base64) + observações, devolve os exercícios
// já normalizados + o nome sugerido da sessão + tokens consumidos (ou lança
// um erro com uma mensagem amigável).
async function analyzeWithGemini(
  images: string[],
  mime: string,
  notes: string | null,
  geminiKey: string,
): Promise<{ sessionName: string; exercises: GymExercise[]; usage: GeminiUsage }> {
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
  let parsed: { session_name?: unknown; exercises?: unknown[] };
  try {
    parsed = JSON.parse(rawText);
  } catch {
    console.error("Gemini devolveu JSON inválido:", rawText);
    throw new Error("A análise devolveu um formato inesperado. Tenta novamente.");
  }

  const num = (v: unknown): number | null =>
    typeof v === "number" && isFinite(v) && v >= 0 ? v : null;
  const exercises: GymExercise[] = (Array.isArray(parsed.exercises) ? parsed.exercises : [])
    // deno-lint-ignore no-explicit-any
    .map((ex: any) => ({
      name: String(ex?.name ?? "").slice(0, 120) || "Exercício",
      sets: (Array.isArray(ex?.sets) ? ex.sets : [])
        // deno-lint-ignore no-explicit-any
        .map((s: any) => ({ reps: num(s?.reps), weight: num(s?.weight) })),
    }))
    .filter((ex) => ex.sets.length > 0);

  if (exercises.length === 0) {
    throw new Error("Não foi possível identificar exercícios nas imagens. Tenta outro ângulo ou mais luz.");
  }

  const sessionName = typeof parsed.session_name === "string" && parsed.session_name.trim()
    ? parsed.session_name.trim().slice(0, 80)
    : "";

  return { sessionName, exercises, usage };
}

// Achata exercícios→séries em linhas prontas para workout_session_sets
// (exercise_name + set_index sequencial por exercício).
function flattenSets(exercises: GymExercise[]): { exercise_name: string; set_index: number; reps: number | null; weight: number | null }[] {
  const rows: { exercise_name: string; set_index: number; reps: number | null; weight: number | null }[] = [];
  for (const ex of exercises) {
    ex.sets.forEach((s, i) => {
      rows.push({ exercise_name: ex.name, set_index: i, reps: s.reps, weight: s.weight });
    });
  }
  return rows;
}

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

    // ── Modo reanálise: session_id presente ───────────────────────────
    if (typeof body.session_id === "string" && body.session_id) {
      const sessionId = body.session_id;
      const { data: existing, error: fetchError } = await sb
        .from("workout_sessions")
        .select("id, photo_paths")
        .eq("id", sessionId)
        .eq("user_id", userId)
        .maybeSingle();
      if (fetchError) return jsonResponse({ error: `Falha a procurar sessão: ${fetchError.message}` }, 500);
      if (!existing) return jsonResponse({ error: "Sessão não encontrada" }, 404);

      const photoPaths: string[] = existing.photo_paths || [];
      if (photoPaths.length === 0) {
        return jsonResponse({ error: "Esta sessão não tem imagens guardadas para reanalisar" }, 400);
      }

      const images: string[] = [];
      for (const path of photoPaths) {
        const { data: fileBlob, error: downloadError } = await sb.storage.from("gym-photos").download(path);
        if (downloadError || !fileBlob) {
          return jsonResponse({ error: `Falha a obter imagem guardada: ${downloadError?.message ?? "desconhecida"}` }, 500);
        }
        images.push(bytesToBase64(new Uint8Array(await fileBlob.arrayBuffer())));
      }

      let sessionName: string, exercises: GymExercise[], usage: GeminiUsage;
      try {
        ({ sessionName, exercises, usage } = await analyzeWithGemini(images, "image/jpeg", rawNotes, geminiKey));
      } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : "Falha na reanálise." }, 502);
      }

      const { error: deleteError } = await sb.from("workout_session_sets").delete().eq("session_id", sessionId);
      if (deleteError) return jsonResponse({ error: `Falha a limpar séries antigas: ${deleteError.message}` }, 500);

      const { data: savedSets, error: setsError } = await sb
        .from("workout_session_sets")
        .insert(flattenSets(exercises).map((row) => ({ ...row, session_id: sessionId, user_id: userId })))
        .select();
      if (setsError) return jsonResponse({ error: `Falha a gravar séries: ${setsError.message}` }, 500);

      const { data: updatedSession, error: updateError } = await sb
        .from("workout_sessions")
        .update({ notes: rawNotes, ...(sessionName ? { name: sessionName } : {}) })
        .eq("id", sessionId)
        .select()
        .single();
      if (updateError) return jsonResponse({ error: `Falha a atualizar sessão: ${updateError.message}` }, 500);

      return jsonResponse({ session: updatedSession, sets: savedSets, usage });
    }

    // ── Modo normal: nova sessão a partir de imagens ──────────────────
    const { mime_type, date } = body;

    let images: string[] = [];
    if (Array.isArray(body.images)) {
      images = body.images.filter((s: unknown) => typeof s === "string" && s.length > 0);
    }

    if (images.length === 0) {
      return jsonResponse({ error: "Nenhuma imagem recebida" }, 400);
    }
    if (images.length > MAX_PHOTOS) {
      return jsonResponse({ error: `Máximo de ${MAX_PHOTOS} imagens por sessão` }, 400);
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
        .from("gym-photos")
        .upload(path, base64ToBytes(b64), { contentType: mime });
      if (uploadError) {
        if (photoPaths.length) await sb.storage.from("gym-photos").remove(photoPaths);
        return jsonResponse({ error: `Falha no upload da imagem: ${uploadError.message}` }, 500);
      }
      photoPaths.push(path);
    }

    // 2. Análise Gemini — todas as imagens numa só chamada (partes múltiplas)
    let sessionName: string, exercises: GymExercise[], usage: GeminiUsage;
    try {
      ({ sessionName, exercises, usage } = await analyzeWithGemini(images, mime, rawNotes, geminiKey));
    } catch (e) {
      await sb.storage.from("gym-photos").remove(photoPaths);
      return jsonResponse({ error: e instanceof Error ? e.message : "Falha na análise." }, 502);
    }

    // 3. Gravar sessão + séries
    const { data: session, error: sessionError } = await sb
      .from("workout_sessions")
      .insert({
        user_id: userId,
        date,
        name: sessionName || "Treino",
        photo_paths: photoPaths,
        status: "concluido",
        notes: rawNotes,
      })
      .select()
      .single();
    if (sessionError) {
      await sb.storage.from("gym-photos").remove(photoPaths);
      return jsonResponse({ error: `Falha a gravar sessão: ${sessionError.message}` }, 500);
    }

    const { data: savedSets, error: setsError } = await sb
      .from("workout_session_sets")
      .insert(flattenSets(exercises).map((row) => ({ ...row, session_id: session.id, user_id: userId })))
      .select();
    if (setsError) {
      await sb.from("workout_sessions").delete().eq("id", session.id);
      await sb.storage.from("gym-photos").remove(photoPaths);
      return jsonResponse({ error: `Falha a gravar séries: ${setsError.message}` }, 500);
    }

    return jsonResponse({ session, sets: savedSets, usage });
  } catch (e) {
    console.error("Erro inesperado:", e);
    return jsonResponse({ error: "Erro inesperado no servidor" }, 500);
  }
});
