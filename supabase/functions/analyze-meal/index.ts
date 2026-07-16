// IronHealth · analyze-meal Edge Function
// Modo normal: recebe 1+ fotos de uma refeição (base64) + data + tipo de
// refeição + observações opcionais, analisa tudo com Gemini e grava
// meals + meal_items na BD.
// Modo reanálise (meal_id presente): repesca as fotos já guardadas dessa
// refeição no Storage, volta a chamar o Gemini com as observações
// atualizadas, e substitui os meal_items existentes pelos novos.
// A chave Gemini vive apenas aqui (secret GEMINI_API_KEY), nunca no cliente.

import { createClient } from "jsr:@supabase/supabase-js@2";

const MAX_PHOTOS = 6;
const MAX_NOTES_LENGTH = 500;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MEAL_TYPES = ["pequeno-almoco", "almoco", "lanche", "jantar", "ceia"];

// Alias que segue sempre o modelo flash estável mais recente — evita 404s
// quando a Google descontinua modelos para contas novas.
const GEMINI_MODEL = "gemini-flash-latest";

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          estimated_quantity_grams: { type: "NUMBER" },
          calories_per_100g: { type: "NUMBER" },
          protein_per_100g: { type: "NUMBER" },
          carbs_per_100g: { type: "NUMBER" },
          fat_per_100g: { type: "NUMBER" },
          fiber_per_100g: { type: "NUMBER" },
          sugar_per_100g: { type: "NUMBER" },
          sodium_per_100g: { type: "NUMBER" },
          iron_mg_per_100g: { type: "NUMBER" },
          calcium_mg_per_100g: { type: "NUMBER" },
          vitamin_c_mg_per_100g: { type: "NUMBER" },
          potassium_mg_per_100g: { type: "NUMBER" },
        },
        required: [
          "name",
          "estimated_quantity_grams",
          "calories_per_100g",
          "protein_per_100g",
          "carbs_per_100g",
          "fat_per_100g",
          "fiber_per_100g",
          "sugar_per_100g",
          "sodium_per_100g",
          "iron_mg_per_100g",
          "calcium_mg_per_100g",
          "vitamin_c_mg_per_100g",
          "potassium_mg_per_100g",
        ],
      },
    },
  },
  required: ["items"],
};

function buildPrompt(notes: string | null): string {
  let prompt =
    "As fotografias seguintes mostram todas a MESMA refeição (possivelmente de " +
    "ângulos diferentes ou vários pratos/componentes). Combina a informação de todas " +
    "as fotos e identifica cada alimento distinto no conjunto, sem contar o mesmo " +
    "alimento duas vezes por aparecer em várias fotos. " +
    "Para cada item, estima a porção total visível em gramas e o seu conteúdo nutricional " +
    "POR 100 GRAMAS (não por porção), usando valores de referência de bases de dados " +
    "nutricionais padrão. O sódio é em mg por 100g. Usa nomes em português de Portugal.";
  if (notes && notes.trim()) {
    prompt +=
      "\n\nO utilizador deixou esta observação sobre a refeição — usa-a para " +
      "identificar com precisão os alimentos e os seus valores nutricionais " +
      "(ex.: um hambúrguer de uma cadeia específica tem valores muito diferentes " +
      "de um feito em casa; cozinhar com manteiga em vez de azeite muda a " +
      "gordura; a marca/tipo de um produto embalado importa). " +
      `Observação do utilizador: "${notes.trim()}"`;
  }
  prompt += "\n\nResponde apenas com JSON estruturado conforme o schema.";
  return prompt;
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

// Chama o Gemini com as imagens (base64) + observações, devolve os itens
// já normalizados (ou lança um erro com uma mensagem amigável).
async function analyzeWithGemini(
  images: string[],
  mime: string,
  notes: string | null,
  geminiKey: string,
  // deno-lint-ignore no-explicit-any
): Promise<any[]> {
  const parts: unknown[] = [{ text: buildPrompt(notes) }];
  for (const b64 of images) {
    parts.push({ inline_data: { mime_type: mime, data: b64 } });
  }
  const geminiRes = await fetch(
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
    throw new Error(`Análise falhou (Gemini ${geminiRes.status}). Tenta novamente.`);
  }

  const geminiJson = await geminiRes.json();
  const rawText = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;
  let parsed: { items?: unknown[] };
  try {
    parsed = JSON.parse(rawText);
  } catch {
    console.error("Gemini devolveu JSON inválido:", rawText);
    throw new Error("A análise devolveu um formato inesperado. Tenta novamente.");
  }

  const num = (v: unknown) => (typeof v === "number" && isFinite(v) && v >= 0 ? v : 0);
  const items = (Array.isArray(parsed.items) ? parsed.items : [])
    // deno-lint-ignore no-explicit-any
    .map((it: any) => ({
      name: String(it?.name ?? "").slice(0, 120) || "Alimento",
      quantity_grams: Math.max(1, num(it?.estimated_quantity_grams)),
      calories_per_100g: num(it?.calories_per_100g),
      protein_per_100g: num(it?.protein_per_100g),
      carbs_per_100g: num(it?.carbs_per_100g),
      fat_per_100g: num(it?.fat_per_100g),
      fiber_per_100g: num(it?.fiber_per_100g),
      sugar_per_100g: num(it?.sugar_per_100g),
      sodium_per_100g: num(it?.sodium_per_100g),
      iron_mg_per_100g: num(it?.iron_mg_per_100g),
      calcium_mg_per_100g: num(it?.calcium_mg_per_100g),
      vitamin_c_mg_per_100g: num(it?.vitamin_c_mg_per_100g),
      potassium_mg_per_100g: num(it?.potassium_mg_per_100g),
    }));

  if (items.length === 0) {
    throw new Error("Não foi possível identificar alimentos nas fotos. Tenta outro ângulo ou mais luz.");
  }
  return items;
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

    // ── Modo reanálise: meal_id presente ──────────────────────────────
    if (typeof body.meal_id === "string" && body.meal_id) {
      const mealId = body.meal_id;
      const { data: existingMeal, error: fetchError } = await sb
        .from("meals")
        .select("id, photo_paths")
        .eq("id", mealId)
        .eq("user_id", userId)
        .maybeSingle();
      if (fetchError) return jsonResponse({ error: `Falha a procurar refeição: ${fetchError.message}` }, 500);
      if (!existingMeal) return jsonResponse({ error: "Refeição não encontrada" }, 404);

      const photoPaths: string[] = existingMeal.photo_paths || [];
      if (photoPaths.length === 0) {
        return jsonResponse({ error: "Esta refeição não tem fotos guardadas para reanalisar" }, 400);
      }

      const images: string[] = [];
      for (const path of photoPaths) {
        const { data: fileBlob, error: downloadError } = await sb.storage.from("meal-photos").download(path);
        if (downloadError || !fileBlob) {
          return jsonResponse({ error: `Falha a obter foto guardada: ${downloadError?.message ?? "desconhecida"}` }, 500);
        }
        images.push(bytesToBase64(new Uint8Array(await fileBlob.arrayBuffer())));
      }

      let items;
      try {
        items = await analyzeWithGemini(images, "image/jpeg", rawNotes, geminiKey);
      } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : "Falha na reanálise." }, 502);
      }

      const { error: deleteError } = await sb.from("meal_items").delete().eq("meal_id", mealId);
      if (deleteError) return jsonResponse({ error: `Falha a limpar itens antigos: ${deleteError.message}` }, 500);

      const { data: savedItems, error: itemsError } = await sb
        .from("meal_items")
        .insert(items.map((it) => ({ ...it, meal_id: mealId, user_id: userId })))
        .select();
      if (itemsError) return jsonResponse({ error: `Falha a gravar itens: ${itemsError.message}` }, 500);

      const { data: updatedMeal, error: updateError } = await sb
        .from("meals")
        .update({ notes: rawNotes })
        .eq("id", mealId)
        .select()
        .single();
      if (updateError) return jsonResponse({ error: `Falha a atualizar refeição: ${updateError.message}` }, 500);

      return jsonResponse({ meal: updatedMeal, items: savedItems });
    }

    // ── Modo normal: nova refeição a partir de fotos ──────────────────
    const { mime_type, date, meal_type } = body;

    // Aceita `images` (array) ou `image_base64` (formato antigo, 1 foto)
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
      return jsonResponse({ error: `Máximo de ${MAX_PHOTOS} fotos por refeição` }, 400);
    }
    if (!MEAL_TYPES.includes(meal_type)) {
      return jsonResponse({ error: "Tipo de refeição inválido" }, 400);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
      return jsonResponse({ error: "Data inválida (esperado YYYY-MM-DD)" }, 400);
    }
    const mime = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]
        .includes(mime_type)
      ? mime_type
      : "image/jpeg";
    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";

    // 1. Upload de todas as fotos para o bucket privado, pasta do próprio utilizador
    const photoPaths: string[] = [];
    for (const b64 of images) {
      const path = `${userId}/${crypto.randomUUID()}.${ext}`;
      const { error: uploadError } = await sb.storage
        .from("meal-photos")
        .upload(path, base64ToBytes(b64), { contentType: mime });
      if (uploadError) {
        if (photoPaths.length) await sb.storage.from("meal-photos").remove(photoPaths);
        return jsonResponse({ error: `Falha no upload da foto: ${uploadError.message}` }, 500);
      }
      photoPaths.push(path);
    }

    // 2. Análise Gemini — todas as fotos numa só chamada (partes múltiplas)
    let items;
    try {
      items = await analyzeWithGemini(images, mime, rawNotes, geminiKey);
    } catch (e) {
      await sb.storage.from("meal-photos").remove(photoPaths);
      return jsonResponse({ error: e instanceof Error ? e.message : "Falha na análise." }, 502);
    }

    // 3. Gravar refeição + itens
    const { data: meal, error: mealError } = await sb
      .from("meals")
      .insert({ user_id: userId, date, meal_type, photo_paths: photoPaths, status: "ready", notes: rawNotes })
      .select()
      .single();
    if (mealError) {
      await sb.storage.from("meal-photos").remove(photoPaths);
      return jsonResponse({ error: `Falha a gravar refeição: ${mealError.message}` }, 500);
    }

    const { data: savedItems, error: itemsError } = await sb
      .from("meal_items")
      .insert(items.map((it) => ({ ...it, meal_id: meal.id, user_id: userId })))
      .select();
    if (itemsError) {
      await sb.from("meals").delete().eq("id", meal.id);
      await sb.storage.from("meal-photos").remove(photoPaths);
      return jsonResponse({ error: `Falha a gravar itens: ${itemsError.message}` }, 500);
    }

    return jsonResponse({ meal, items: savedItems });
  } catch (e) {
    console.error("Erro inesperado:", e);
    return jsonResponse({ error: "Erro inesperado no servidor" }, 500);
  }
});
