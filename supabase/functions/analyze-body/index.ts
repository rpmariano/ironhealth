// IronHealth · analyze-body Edge Function
// Modo normal: recebe 1+ prints da app Renpho Health (base64) + data +
// observações opcionais, extrai as métricas de composição corporal com o
// Gemini, gera um breve resumo (comparando com o histórico se existir) e
// grava a avaliação em body_assessments.
// Modo reanálise (assessment_id presente): repesca os prints já guardados
// dessa avaliação no Storage e volta a analisar, substituindo os valores.
// A chave Gemini vive apenas aqui (secret GEMINI_API_KEY), nunca no cliente.

import { createClient } from "jsr:@supabase/supabase-js@2";

const MAX_PHOTOS = 6;
const MAX_NOTES_LENGTH = 500;
const HISTORY_FOR_CONTEXT = 5; // avaliações anteriores enviadas ao Gemini para comparação

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Alias que segue sempre o modelo flash estável mais recente — evita 404s
// quando a Google descontinua modelos para contas novas.
const GEMINI_MODEL = "gemini-flash-latest";
// Tempo máximo por chamada ao Gemini antes de desistir e tentar mais uma vez.
// A API do Gemini (sobretudo no tier gratuito) tem latência muito variável —
// isto evita que uma chamada presa arraste a função até ao limite rígido da
// plataforma (~150s), o que produz um erro genérico e ilegível no cliente.
const GEMINI_TIMEOUT_MS = 40000;
const GEMINI_RETRIES = 1; // repetições automáticas após timeout, antes de desistir de vez

// Colunas de métricas guardadas na BD e devolvidas pelo Gemini. A ordem/labels
// aqui espelham o que a app Renpho Health mostra num print típico.
// `label` = descrição curta (usada no histórico enviado ao Gemini).
// `renpho` = como o termo aparece na app Renpho Health em português (inclui a
//   grafia real da app, ex.: "Viceral"). `hint` = regra de desambiguação para
//   a extração — calibrado com screenshots reais da Renpho.
const METRIC_FIELDS: { key: string; label: string; renpho: string; hint?: string }[] = [
  { key: "weight_kg", label: "Peso (kg)", renpho: "Peso", hint: "em kg" },
  { key: "bmi", label: "IMC", renpho: "IMC", hint: "índice (ex.: 25.2)" },
  { key: "body_fat_pct", label: "Gordura corporal (%)", renpho: "Gordura corporal",
    hint: "USA A PERCENTAGEM (ex.: 26.0 %), NÃO o valor em kg que aparece no donut da Visão geral" },
  { key: "skeletal_muscle_pct", label: "Músculo esquelético (%)", renpho: "Músculo esquelético", hint: "em %" },
  { key: "muscle_mass_kg", label: "Massa muscular (kg)", renpho: "Massa Muscular",
    hint: "USA OS KG (ex.: 56.70 kg), não a % que aparece ao lado" },
  { key: "body_water_pct", label: "Água corporal (%)", renpho: "Água corporal",
    hint: "USA A PERCENTAGEM (ex.: 53.4 %), não os kg ao lado" },
  { key: "protein_pct", label: "Proteína (%)", renpho: "Proteína",
    hint: "USA A PERCENTAGEM (ex.: 16.9 %), não os kg ao lado" },
  { key: "bone_mass_kg", label: "Massa óssea (kg)", renpho: "Massa óssea",
    hint: "USA OS KG (ex.: 2.98 kg), não a % ao lado" },
  { key: "bmr_kcal", label: "Metabolismo basal (kcal)", renpho: "TMB (Taxa Metabólica Basal)",
    hint: "em kcal (ex.: 1657)" },
  { key: "visceral_fat", label: "Gordura visceral (índice)", renpho: "Gordura Visceral (por vezes escrito \"Viceral\")",
    hint: "índice inteiro (ex.: 8), não uma percentagem" },
  { key: "subcutaneous_fat_pct", label: "Gordura subcutânea (%)", renpho: "Gordura subcutânea", hint: "em %" },
  { key: "metabolic_age", label: "Idade metabólica (anos)", renpho: "Idade Metabólica", hint: "em anos (ex.: 45)" },
  { key: "lean_body_mass_kg", label: "Massa magra (kg)", renpho: "Peso corporal sem gordura (massa magra / isenta de gordura)",
    hint: "em kg (ex.: 59.68)" },
];

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    metrics: {
      type: "OBJECT",
      properties: Object.fromEntries(
        METRIC_FIELDS.map((f) => [f.key, { type: "NUMBER", nullable: true }]),
      ),
      // Obriga o Gemini a decidir explicitamente cada chave (mesmo que a
      // resposta seja null) em vez de poder simplesmente omiti-la — sem
      // isto, observámos avaliações em que o resumo em texto menciona
      // valores concretos (ex.: gordura visceral, água corporal) que nunca
      // chegam a aparecer no objeto `metrics` estruturado.
      required: METRIC_FIELDS.map((f) => f.key),
    },
    // Etiqueta de estado que a Renpho mostra ao lado de cada métrica
    // (ex.: "Média", "Alto", "Baixo", "Ligeiramente alto", "Excelente").
    classifications: {
      type: "OBJECT",
      properties: Object.fromEntries(
        METRIC_FIELDS.map((f) => [f.key, { type: "STRING", nullable: true }]),
      ),
      required: METRIC_FIELDS.map((f) => f.key),
    },
    summary: { type: "STRING" },
  },
  required: ["metrics", "summary"],
};

// Estados HTTP de sobrecarga momentânea do lado da Google (500/502/503/504) —
// vale a pena repetir estes, porque costumam resolver-se à segunda. O 429
// (limite de pedidos excedido) fica DE FORA de propósito: repetir logo a
// seguir só volta a bater no mesmo limite por minuto — e até o acelera — por
// isso passa já ao chamador com uma mensagem clara. Erros "permanentes"
// (400, 401, 403...) também passam sempre à primeira.
const GEMINI_RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);

// fetch com limite de tempo por tentativa + repetições automáticas quando a
// chamada fica presa (AbortError), falha ao nível da rede, ou o Gemini
// devolve um estado transitório (ver GEMINI_RETRYABLE_STATUSES) — por
// exemplo, confirmámos em produção uma resposta 503 (sobrecarga momentânea)
// que a app mostrava como erro imediato, mesmo sem qualquer problema de rede
// ou timeout envolvido. Ao fim das tentativas, devolve a resposta tal como
// veio (o chamador decide a mensagem) ou lança um erro claro se nem chegou
// a haver resposta.
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
// com imagens grandes.
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// deno-lint-ignore no-explicit-any
function historyContext(history: any[]): string {
  if (!history || history.length === 0) {
    return "O utilizador ainda não tem avaliações anteriores registadas.";
  }
  const lines = history.map((a) => {
    const parts = METRIC_FIELDS
      .filter((f) => a[f.key] !== null && a[f.key] !== undefined)
      .map((f) => `${f.label}: ${a[f.key]}`);
    return `- ${a.date}: ${parts.join(", ") || "sem valores"}`;
  });
  return "Histórico de avaliações anteriores (da mais recente para a mais antiga):\n" +
    lines.join("\n");
}

function buildPrompt(notes: string | null, history: unknown[]): string {
  const mapping = METRIC_FIELDS
    .map((f) => `- ${f.key} — na Renpho aparece como "${f.renpho}"${f.hint ? ` — ${f.hint}` : ""}`)
    .join("\n");

  let prompt =
    "As imagens seguintes são capturas de ecrã (screenshots) da aplicação Renpho Health, " +
    "em português, que mostram os resultados de uma pesagem de composição corporal " +
    "(ecrãs possíveis: \"Composição corporal / Comparativo\", \"Relatório de métricas / Visão geral\", ou \"Tendências\"). " +
    "Extrai o valor numérico ATUAL de cada métrica. Devolve exatamente estas chaves:\n" +
    mapping +
    "\n\nRegras de extração (importantes — calibradas com a app real):\n" +
    "- Devolve apenas o número, sem unidades nem símbolos. Usa ponto como separador decimal.\n" +
    "- Se uma métrica não aparecer em nenhuma imagem, devolve null nessa chave (não inventes).\n" +
    "- Várias métricas da Renpho mostram DOIS valores (ex.: \"56.70 kg, 70.3 %\"). Segue rigorosamente " +
    "a unidade indicada em cada chave acima (kg ou %).\n" +
    "- Muitas métricas têm ao lado uma ETIQUETA DE ESTADO (ex.: \"Média\", \"Normal\", \"Alto\", " +
    "\"Baixo\", \"Ligeiramente alto\", \"Excelente\", \"Padrão\"). Coloca essa etiqueta, tal e qual " +
    "aparece na imagem, no objeto \"classifications\" sob a MESMA chave da métrica. Se uma métrica " +
    "não tiver etiqueta visível, devolve null nessa chave de \"classifications\". A etiqueta NÃO é " +
    "um valor numérico — nunca a metas em \"metrics\".\n" +
    "- No ecrã \"Comparativo\", cada cartão mostra o valor grande (atual) e por baixo uma variação " +
    "com sinal (ex.: \"−0.40\", \"+0.1\"). Extrai SEMPRE o valor grande atual, NUNCA a variação.\n" +
    "- No ecrã \"Tendências\" (gráfico), usa o valor mais recente/último ponto, não a meta nem os extremos.\n" +
    "- Combina a informação de todas as imagens numa única leitura coerente da mesma pesagem.\n\n" +
    // deno-lint-ignore no-explicit-any
    historyContext(history as any[]) +
    "\n\nNo campo \"summary\" escreve uma breve avaliação (2 a 4 frases, em português de Portugal) " +
    "dos valores desta pesagem: o que está bom e o que merece atenção. " +
    "Se existir histórico acima, compara com a avaliação mais recente e comenta a evolução " +
    "(o que melhorou, o que piorou, ex.: peso, gordura corporal, massa muscular). " +
    "Sê direto e prático, sem alarmismos e sem dar diagnósticos médicos.";
  if (notes && notes.trim()) {
    prompt +=
      "\n\nObservação do utilizador sobre esta pesagem (usa-a como contexto): " +
      `"${notes.trim()}"`;
  }
  prompt += "\n\nResponde apenas com JSON estruturado conforme o schema.";
  return prompt;
}

// Chama o Gemini com as imagens (base64) + histórico + observações, devolve as
// métricas normalizadas e o resumo (ou lança um erro com mensagem amigável).
async function analyzeWithGemini(
  images: string[],
  mime: string,
  notes: string | null,
  history: unknown[],
  geminiKey: string,
): Promise<{ metrics: Record<string, number | null>; classifications: Record<string, string>; summary: string }> {
  const parts: unknown[] = [{ text: buildPrompt(notes, history) }];
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
  const rawText = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;
  let parsed: { metrics?: Record<string, unknown>; classifications?: Record<string, unknown>; summary?: unknown };
  try {
    parsed = JSON.parse(rawText);
  } catch {
    console.error("Gemini devolveu JSON inválido:", rawText);
    throw new Error("A análise devolveu um formato inesperado. Tenta novamente.");
  }

  // Aceita apenas números finitos e >= 0; tudo o resto vira null.
  const num = (v: unknown): number | null =>
    typeof v === "number" && isFinite(v) && v >= 0 ? v : null;
  const rawMetrics = (parsed.metrics ?? {}) as Record<string, unknown>;
  const metrics: Record<string, number | null> = {};
  for (const f of METRIC_FIELDS) metrics[f.key] = num(rawMetrics[f.key]);

  const hasAny = Object.values(metrics).some((v) => v !== null);
  if (!hasAny) {
    throw new Error(
      "Não foi possível ler valores nas imagens. Confirma que é um print da Renpho Health, com boa nitidez.",
    );
  }

  // Classificações: só guarda strings não vazias, e só para métricas com valor.
  const rawClass = (parsed.classifications ?? {}) as Record<string, unknown>;
  const classifications: Record<string, string> = {};
  for (const f of METRIC_FIELDS) {
    const label = rawClass[f.key];
    if (metrics[f.key] !== null && typeof label === "string" && label.trim()) {
      classifications[f.key] = label.trim().slice(0, 40);
    }
  }

  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  return { metrics, classifications, summary };
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

    // Cliente Supabase com o JWT do chamador: todas as escritas correm sob o RLS dele.
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

    const metricSelect =
      "id, date, " + METRIC_FIELDS.map((f) => f.key).join(", ");

    // ── Modo reanálise: assessment_id presente ────────────────────────
    if (typeof body.assessment_id === "string" && body.assessment_id) {
      const assessmentId = body.assessment_id;
      const { data: existing, error: fetchError } = await sb
        .from("body_assessments")
        .select("id, date, photo_paths")
        .eq("id", assessmentId)
        .eq("user_id", userId)
        .maybeSingle();
      if (fetchError) return jsonResponse({ error: `Falha a procurar avaliação: ${fetchError.message}` }, 500);
      if (!existing) return jsonResponse({ error: "Avaliação não encontrada" }, 404);

      const photoPaths: string[] = existing.photo_paths || [];
      if (photoPaths.length === 0) {
        return jsonResponse({ error: "Esta avaliação não tem imagens guardadas para reanalisar" }, 400);
      }

      const images: string[] = [];
      for (const path of photoPaths) {
        const { data: fileBlob, error: downloadError } = await sb.storage.from("body-photos").download(path);
        if (downloadError || !fileBlob) {
          return jsonResponse({ error: `Falha a obter imagem guardada: ${downloadError?.message ?? "desconhecida"}` }, 500);
        }
        images.push(bytesToBase64(new Uint8Array(await fileBlob.arrayBuffer())));
      }

      // Histórico = avaliações anteriores a esta (por data), para comparação.
      const { data: history } = await sb
        .from("body_assessments")
        .select(metricSelect)
        .eq("user_id", userId)
        .neq("id", assessmentId)
        .lte("date", existing.date)
        .order("date", { ascending: false })
        .limit(HISTORY_FOR_CONTEXT);

      let result;
      try {
        result = await analyzeWithGemini(images, "image/jpeg", rawNotes, history || [], geminiKey);
      } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : "Falha na reanálise." }, 502);
      }

      const { data: updated, error: updateError } = await sb
        .from("body_assessments")
        .update({ ...result.metrics, classifications: result.classifications, ai_summary: result.summary, notes: rawNotes, status: "ready" })
        .eq("id", assessmentId)
        .select()
        .single();
      if (updateError) return jsonResponse({ error: `Falha a atualizar avaliação: ${updateError.message}` }, 500);

      return jsonResponse({ assessment: updated });
    }

    // ── Modo normal: nova avaliação a partir de imagens ────────────────
    const { mime_type, date } = body;

    let images: string[] = [];
    if (Array.isArray(body.images)) {
      images = body.images.filter((s: unknown) => typeof s === "string" && s.length > 0);
    } else if (typeof body.image_base64 === "string" && body.image_base64) {
      images = [body.image_base64];
    }

    if (images.length === 0) {
      return jsonResponse({ error: "Nenhuma imagem recebida" }, 400);
    }
    if (images.length > MAX_PHOTOS) {
      return jsonResponse({ error: `Máximo de ${MAX_PHOTOS} imagens por avaliação` }, 400);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
      return jsonResponse({ error: "Data inválida (esperado YYYY-MM-DD)" }, 400);
    }
    const mime = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]
        .includes(mime_type)
      ? mime_type
      : "image/jpeg";
    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";

    // Histórico para comparação: avaliações até esta data (exclusive é tratado
    // no cliente ao ordenar; aqui usamos <= data e limitamos as mais recentes).
    const { data: history } = await sb
      .from("body_assessments")
      .select(metricSelect)
      .eq("user_id", userId)
      .lte("date", date)
      .order("date", { ascending: false })
      .limit(HISTORY_FOR_CONTEXT);

    // 1. Upload de todas as imagens para o bucket privado, pasta do próprio utilizador
    const photoPaths: string[] = [];
    for (const b64 of images) {
      const path = `${userId}/${crypto.randomUUID()}.${ext}`;
      const { error: uploadError } = await sb.storage
        .from("body-photos")
        .upload(path, base64ToBytes(b64), { contentType: mime });
      if (uploadError) {
        if (photoPaths.length) await sb.storage.from("body-photos").remove(photoPaths);
        return jsonResponse({ error: `Falha no upload da imagem: ${uploadError.message}` }, 500);
      }
      photoPaths.push(path);
    }

    // 2. Análise Gemini — todas as imagens numa só chamada (partes múltiplas)
    let result;
    try {
      result = await analyzeWithGemini(images, mime, rawNotes, history || [], geminiKey);
    } catch (e) {
      await sb.storage.from("body-photos").remove(photoPaths);
      return jsonResponse({ error: e instanceof Error ? e.message : "Falha na análise." }, 502);
    }

    // 3. Gravar avaliação
    const { data: assessment, error: insertError } = await sb
      .from("body_assessments")
      .insert({
        user_id: userId,
        date,
        photo_paths: photoPaths,
        status: "ready",
        notes: rawNotes,
        ai_summary: result.summary,
        classifications: result.classifications,
        ...result.metrics,
      })
      .select()
      .single();
    if (insertError) {
      await sb.storage.from("body-photos").remove(photoPaths);
      return jsonResponse({ error: `Falha a gravar avaliação: ${insertError.message}` }, 500);
    }

    return jsonResponse({ assessment });
  } catch (e) {
    console.error("Erro inesperado:", e);
    return jsonResponse({ error: "Erro inesperado no servidor" }, 500);
  }
});
