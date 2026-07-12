// IronHealth · coach-chat Edge Function
// Recebe uma mensagem do utilizador, constrói o contexto completo
// (role de sistema + perfil do utilizador + dados nutricionais de hoje +
// histórico de conversa) e chama o Gemini. Guarda pergunta e resposta
// na tabela coach_messages para persistência entre sessões.

import { createClient } from "jsr:@supabase/supabase-js@2";

const GEMINI_MODEL = "gemini-2.0-flash";
const MAX_HISTORY   = 30;   // mensagens mais recentes enviadas ao Gemini
const MAX_MSG_LEN   = 2000; // caracteres máximos por mensagem

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function buildSystemInstruction(
  coachContext: string | null,
  biometrics: { height_cm: number | null; weight_kg: number | null; gender: string | null },
  nutritionSummary: string,
  gymSummary: string | null,
  runningSummary: string | null,
): string {
  const today = new Date().toLocaleDateString("pt-PT", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  let sys =
    `És um coach especializado em nutrição desportiva, treino de ginásio e corrida. ` +
    `O teu objetivo é dar conselhos práticos, personalizados e baseados em ciência ao utilizador.\n\n` +
    `Responde sempre em português de Portugal. ` +
    `Sê direto e prático. Quando adequado, estrutura as respostas com listas ou secções curtas. ` +
    `Não sejas excessivamente longo — responde de forma concisa mas completa.\n\n` +
    `Data atual: ${today}.`;

  const bio: string[] = [];
  if (biometrics.gender) bio.push(`Género: ${biometrics.gender === "F" ? "feminino" : "masculino"}`);
  if (biometrics.height_cm) bio.push(`Altura: ${biometrics.height_cm} cm`);
  if (biometrics.weight_kg) bio.push(`Peso: ${biometrics.weight_kg} kg`);
  if (biometrics.height_cm && biometrics.weight_kg) {
    const h = biometrics.height_cm / 100;
    const bmi = biometrics.weight_kg / (h * h);
    bio.push(`IMC: ${bmi.toFixed(1)}`);
  }
  if (bio.length) {
    sys += `\n\nDados biométricos do utilizador:\n${bio.join("\n")}`;
  }

  if (coachContext && coachContext.trim()) {
    sys += `\n\nPerfil e objetivos do utilizador (definido pelo próprio):\n${coachContext.trim()}`;
  }

  sys += `\n\n${nutritionSummary}`;
  if (gymSummary) sys += `\n\n${gymSummary}`;
  if (runningSummary) sys += `\n\n${runningSummary}`;

  return sys;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Método não suportado" }, 405);

  try {
    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiKey) return jsonResponse({ error: "GEMINI_API_KEY não configurada" }, 500);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Sem autorização" }, 401);

    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: userData, error: userError } = await sb.auth.getUser();
    if (userError || !userData?.user) return jsonResponse({ error: "Sessão inválida" }, 401);
    const userId = userData.user.id;

    const body = await req.json();
    const message = typeof body.message === "string"
      ? body.message.slice(0, MAX_MSG_LEN).trim()
      : "";
    if (!message) return jsonResponse({ error: "Mensagem vazia" }, 400);

    // ── Perfil do utilizador (contexto + metas + biometria) ──────────────
    const { data: profile } = await sb
      .from("profiles")
      .select("coach_context, calorie_goal, protein_goal, carbs_goal, fat_goal, height_cm, weight_kg, gender")
      .eq("id", userId)
      .maybeSingle();

    // ── Dados nutricionais de hoje ───────────────────────────────────────
    const todayISO = new Date().toISOString().slice(0, 10);
    const { data: todayMeals } = await sb
      .from("meals")
      .select("meal_type, meal_items(quantity_grams, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g)")
      .eq("user_id", userId)
      .eq("date", todayISO);

    let kcal = 0, prot = 0, carbs = 0, fat = 0;
    for (const meal of (todayMeals || [])) {
      for (const it of (meal.meal_items || [])) {
        const f = (it.quantity_grams || 0) / 100;
        kcal  += (it.calories_per_100g || 0) * f;
        prot  += (it.protein_per_100g  || 0) * f;
        carbs += (it.carbs_per_100g    || 0) * f;
        fat   += (it.fat_per_100g      || 0) * f;
      }
    }

    const g = profile || {} as Record<string, unknown>;
    const nutritionSummary = (todayMeals && todayMeals.length > 0)
      ? `Dados nutricionais de hoje (${todayISO}), calculados automaticamente a partir das refeições registadas:\n` +
        `- Calorias: ${kcal.toFixed(0)} kcal (meta diária: ${g.calorie_goal ?? "–"} kcal)\n` +
        `- Proteína: ${prot.toFixed(1)} g (meta: ${g.protein_goal ?? "–"} g)\n` +
        `- Hidratos: ${carbs.toFixed(1)} g (meta: ${g.carbs_goal ?? "–"} g)\n` +
        `- Gordura: ${fat.toFixed(1)} g (meta: ${g.fat_goal ?? "–"} g)\n` +
        `- Refeições registadas: ${todayMeals.length}`
      : `Dados nutricionais de hoje (${todayISO}): sem refeições registadas ainda.`;

    // ── Histórico de conversa (últimas MAX_HISTORY mensagens) ────────────
    const { data: history } = await sb
      .from("coach_messages")
      .select("role, content")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(MAX_HISTORY);

    // ── Guardar mensagem do utilizador antes de chamar o Gemini ─────────
    const { data: userMsg, error: userMsgErr } = await sb
      .from("coach_messages")
      .insert({ user_id: userId, role: "user", content: message })
      .select()
      .single();
    if (userMsgErr) {
      return jsonResponse({ error: `Falha a guardar mensagem: ${userMsgErr.message}` }, 500);
    }

    // ── Construir pedido ao Gemini ───────────────────────────────────────
    // gymSummary/runningSummary ficam null até essas verticais terem dados
    // próprios (ainda são placeholders "Em breve" sem tabelas na BD).
    const systemInstruction = buildSystemInstruction(
      profile?.coach_context ?? null,
      {
        height_cm: (profile?.height_cm as number | null) ?? null,
        weight_kg: (profile?.weight_kg as number | null) ?? null,
        gender: (profile?.gender as string | null) ?? null,
      },
      nutritionSummary,
      null,
      null,
    );

    // deno-lint-ignore no-explicit-any
    const contents: any[] = [
      ...(history || []).map((m: { role: string; content: string }) => ({
        role: m.role,
        parts: [{ text: m.content }],
      })),
      { role: "user", parts: [{ text: message }] },
    ];

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemInstruction }] },
          contents,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1500,
          },
        }),
      },
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini error:", geminiRes.status, errText);
      return jsonResponse({ error: `Falha na resposta do coach (${geminiRes.status}). Tenta novamente.` }, 502);
    }

    const geminiJson = await geminiRes.json();
    const replyText: string | undefined =
      geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!replyText) {
      console.error("Gemini resposta vazia:", JSON.stringify(geminiJson));
      return jsonResponse({ error: "O coach não conseguiu gerar uma resposta. Tenta novamente." }, 502);
    }

    // ── Guardar resposta do modelo ───────────────────────────────────────
    const { data: modelMsg, error: modelMsgErr } = await sb
      .from("coach_messages")
      .insert({ user_id: userId, role: "model", content: replyText })
      .select()
      .single();

    if (modelMsgErr) {
      console.error("Falha a guardar resposta:", modelMsgErr);
      return jsonResponse({
        user_message: userMsg,
        model_message: { id: null, role: "model", content: replyText, created_at: new Date().toISOString() },
      });
    }

    return jsonResponse({ user_message: userMsg, model_message: modelMsg });

  } catch (e) {
    console.error("Erro inesperado:", e);
    return jsonResponse({ error: "Erro inesperado no servidor" }, 500);
  }
});
