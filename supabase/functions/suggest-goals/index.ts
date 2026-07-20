// IronHealth · suggest-goals Edge Function
// Pedido não-conversacional (botão no Perfil, não o chat): o Coach analisa
// todo o histórico disponível (avaliações de Corpo, nutrição, corridas,
// treinos de ginásio) e as próximas provas agendadas, e sugere objetivos
// tanto de Corpo (goal_*) como de Nutrição (calorie_goal/protein_goal/
// carbs_goal/fat_goal). Os objetivos sugeridos são gravados diretamente em
// profiles — só os campos que o Gemini decidir sugerir (os restantes ficam
// como estavam, nunca apagados por omissão).
// A chave Gemini vive apenas aqui (secret GEMINI_API_KEY), nunca no cliente.

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GEMINI_MODEL = "gemini-flash-latest";
const GEMINI_TIMEOUT_MS = 40000;
const GEMINI_RETRIES = 1;

// Mesma lista de métricas do Corpo usada no cliente (BODY_METRICS) — mantida
// em sincronia manualmente, tal como METRIC_FIELDS em analyze-body.
const BODY_METRICS: { key: string; label: string; unit: string; good: "up" | "down" | null }[] = [
  { key: "weight_kg", label: "Peso", unit: "kg", good: null },
  { key: "bmi", label: "IMC", unit: "", good: "down" },
  { key: "body_fat_pct", label: "Gordura corporal", unit: "%", good: "down" },
  { key: "skeletal_muscle_pct", label: "Músculo esquelético", unit: "%", good: "up" },
  { key: "muscle_mass_kg", label: "Massa muscular", unit: "kg", good: "up" },
  { key: "body_water_pct", label: "Água corporal", unit: "%", good: "up" },
  { key: "protein_pct", label: "Proteína", unit: "%", good: "up" },
  { key: "bone_mass_kg", label: "Massa óssea", unit: "kg", good: null },
  { key: "bmr_kcal", label: "Metabolismo basal", unit: "kcal", good: "up" },
  { key: "visceral_fat", label: "Gordura visceral", unit: "", good: "down" },
  { key: "subcutaneous_fat_pct", label: "Gordura subcutânea", unit: "%", good: "down" },
  { key: "metabolic_age", label: "Idade metabólica", unit: "anos", good: "down" },
  { key: "lean_body_mass_kg", label: "Massa magra", unit: "kg", good: "up" },
];
const BODY_GOAL_KEYS = BODY_METRICS.map((m) => "goal_" + m.key);

// Objetivos diários de nutrição — mesmas colunas usadas em saveProfileFromForm.
const NUTRITION_GOALS: { key: string; label: string; unit: string }[] = [
  { key: "calorie_goal", label: "Calorias", unit: "kcal/dia" },
  { key: "protein_goal", label: "Proteína", unit: "g/dia" },
  { key: "carbs_goal", label: "Hidratos de carbono", unit: "g/dia" },
  { key: "fat_goal", label: "Gordura", unit: "g/dia" },
];
const NUTRITION_GOAL_KEYS = NUTRITION_GOALS.map((n) => n.key);

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    goals: {
      type: "OBJECT",
      properties: Object.fromEntries(
        [...BODY_GOAL_KEYS, ...NUTRITION_GOAL_KEYS].map((k) => [k, { type: "NUMBER", nullable: true }]),
      ),
      // Obriga o Gemini a decidir explicitamente cada objetivo (mesmo que
      // devolva null) — evita sugestões vagas mencionadas só no texto.
      required: [...BODY_GOAL_KEYS, ...NUTRITION_GOAL_KEYS],
    },
    rationale: { type: "STRING" },
  },
  required: ["goals", "rationale"],
};

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

const RACE_TYPE_LABELS: Record<string, string> = {
  estrada: "Estrada", trail: "Trail", ultra: "Ultra", "5k": "5 km", "10k": "10 km",
  "21k": "Meia maratona", "42k": "Maratona", outro: "Outro",
};

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.round(totalSeconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

type DayTotals = { kcal: number; prot: number; carbs: number; fat: number; meals: number };
// deno-lint-ignore no-explicit-any
function aggregateMealsByDate(meals: any[]): Record<string, DayTotals> {
  const byDate: Record<string, DayTotals> = {};
  for (const meal of meals) {
    if (!byDate[meal.date]) byDate[meal.date] = { kcal: 0, prot: 0, carbs: 0, fat: 0, meals: 0 };
    const d = byDate[meal.date];
    d.meals += 1;
    for (const it of (meal.meal_items || [])) {
      const f = (it.quantity_grams || 0) / 100;
      d.kcal += (it.calories_per_100g || 0) * f;
      d.prot += (it.protein_per_100g || 0) * f;
      d.carbs += (it.carbs_per_100g || 0) * f;
      d.fat += (it.fat_per_100g || 0) * f;
    }
  }
  return byDate;
}

function buildPrompt(
  // deno-lint-ignore no-explicit-any
  profile: any,
  // deno-lint-ignore no-explicit-any
  assessments: any[],
  // deno-lint-ignore no-explicit-any
  raceEvents: any[],
  // deno-lint-ignore no-explicit-any
  runs: any[],
  // deno-lint-ignore no-explicit-any
  gymSessions: any[],
  // deno-lint-ignore no-explicit-any
  meals: any[],
  todayISO: string,
): string {
  const bodyMetricLines = BODY_METRICS
    .map((m) => `- goal_${m.key} — "${m.label}"${m.unit ? ` (${m.unit})` : ""}${m.good ? `, idealmente deve ${m.good === "up" ? "subir" : "descer"}` : ""}`)
    .join("\n");
  const nutritionGoalLines = NUTRITION_GOALS
    .map((n) => `- ${n.key} — "${n.label}" (${n.unit})`)
    .join("\n");

  const currentBodyGoals = BODY_METRICS
    .map((m) => {
      const v = profile?.["goal_" + m.key];
      return v !== null && v !== undefined ? `- ${m.label}: ${v}${m.unit ? ` ${m.unit}` : ""}` : null;
    })
    .filter(Boolean)
    .join("\n") || "Sem objetivos de Corpo definidos atualmente.";

  const currentNutritionGoals = NUTRITION_GOALS
    .map((n) => {
      const v = profile?.[n.key];
      return v !== null && v !== undefined ? `- ${n.label}: ${v} ${n.unit}` : null;
    })
    .filter(Boolean)
    .join("\n") || "Sem objetivos de Nutrição definidos atualmente.";

  const assessmentLines = assessments.length === 0
    ? "Sem avaliações de corpo registadas."
    : assessments.map((a) => {
      const vals = BODY_METRICS
        .filter((m) => a[m.key] !== null && a[m.key] !== undefined)
        .map((m) => `${m.label}: ${a[m.key]}${m.unit ? ` ${m.unit}` : ""}`);
      return `- ${a.date}: ${vals.join(", ") || "sem valores"}`;
    }).join("\n");

  const today = new Date(todayISO + "T00:00:00Z");
  const raceLines = raceEvents.length === 0
    ? "Sem provas agendadas."
    : raceEvents.map((e) => {
      const eventDate = new Date(e.date + "T00:00:00Z");
      const daysUntil = Math.round((eventDate.getTime() - today.getTime()) / 86400000);
      const typeLabel = RACE_TYPE_LABELS[e.race_type] || e.race_type;
      return `- ${e.date} (daqui a ${daysUntil} dia(s)): ${e.name} — ${typeLabel}${e.target_time ? `, tempo-alvo ${e.target_time}` : ""}`;
    }).join("\n");

  const runLines = runs.length === 0
    ? "Sem corridas recentes."
    : runs.map((r) => {
      const parts = [
        r.distance_km != null ? `${Number(r.distance_km).toFixed(2)} km` : null,
        r.duration_seconds != null ? formatDuration(r.duration_seconds) : null,
      ].filter(Boolean);
      return `- ${r.date}: ${r.kind}${r.training_type ? ` (${r.training_type})` : ""}${parts.length ? ` — ${parts.join(", ")}` : ""}`;
    }).join("\n");

  const gymLines = gymSessions.length === 0
    ? "Sem treinos de ginásio recentes."
    : gymSessions.map((s) => {
      let volume = 0;
      for (const st of (s.workout_session_sets || [])) {
        if (st.reps != null && st.weight != null) volume += st.reps * st.weight;
      }
      return `- ${s.date}: ${s.name || "Treino"} — ${Math.round(volume)} kg de volume`;
    }).join("\n");

  const byDate = aggregateMealsByDate(meals);
  const nutritionDays = Object.keys(byDate).sort().reverse();
  const nutritionLines = nutritionDays.length === 0
    ? "Sem refeições registadas recentemente."
    : nutritionDays.map((d) => {
      const day = byDate[d];
      return `- ${d}: ${day.kcal.toFixed(0)} kcal, ${day.prot.toFixed(0)}g proteína, ${day.carbs.toFixed(0)}g hidratos, ${day.fat.toFixed(0)}g gordura (${day.meals} refeições)`;
    }).join("\n");

  const bio: string[] = [];
  if (profile?.gender) bio.push(`Género: ${profile.gender === "F" ? "feminino" : "masculino"}`);
  if (profile?.height_cm) bio.push(`Altura: ${profile.height_cm} cm`);
  if (profile?.weight_kg) bio.push(`Peso atual: ${profile.weight_kg} kg`);

  return (
    `És um coach de nutrição desportiva, treino de ginásio e corrida. A tua tarefa AGORA não é responder ` +
    `a uma pergunta — é sugerir objetivos (metas) de Corpo e de Nutrição para o utilizador, tendo em conta ` +
    `TODO o histórico disponível e as próximas provas agendadas.\n\n` +
    `Objetivos de CORPO disponíveis (usa exatamente estas chaves):\n${bodyMetricLines}\n\n` +
    `Objetivos de NUTRIÇÃO disponíveis (usa exatamente estas chaves, valores diários):\n${nutritionGoalLines}\n\n` +
    `Data de hoje: ${todayISO}.\n\n` +
    (bio.length ? `Dados biométricos:\n${bio.join("\n")}\n\n` : "") +
    (profile?.coach_context ? `Perfil e objetivos definidos pelo próprio utilizador:\n${profile.coach_context.trim()}\n\n` : "") +
    `Objetivos de Corpo atuais (podes mantê-los, ajustá-los, ou sugerir novos onde não existem):\n${currentBodyGoals}\n\n` +
    `Objetivos de Nutrição atuais:\n${currentNutritionGoals}\n\n` +
    `Histórico de avaliações de corpo (mais recente primeiro):\n${assessmentLines}\n\n` +
    `Consumo nutricional diário recente (mais recente primeiro):\n${nutritionLines}\n\n` +
    `Próximas provas agendadas (a mais próxima é a prioridade, mas tem em conta se houver várias muito ` +
    `seguidas — nesse caso os objetivos devem servir a sequência toda, não só a primeira):\n${raceLines}\n\n` +
    `Corridas recentes (últimos ~60 dias, mais recente primeiro):\n${runLines}\n\n` +
    `Treinos de ginásio recentes (últimos ~60 dias, mais recente primeiro):\n${gymLines}\n\n` +
    `Regras:\n` +
    `- Só sugere um valor para um objetivo se fizer sentido com os dados disponíveis (ex.: não sugiras ` +
    `peso-alvo se nunca houve avaliação de peso; não sugiras objetivos de nutrição se não houver nenhum ` +
    `consumo registado para calibrar). Caso contrário devolve null nessa chave.\n` +
    `- Sê realista e gradual — não sugiras uma perda de gordura, ganho de músculo, ou défice/superávit ` +
    `calórico irrealista para o tempo disponível até à prova mais próxima. Prioriza consistência com o ` +
    `histórico real do utilizador (o que ele já come/treina), não o oposto disso.\n` +
    `- Se houver uma prova de resistência próxima (10km+), tende a NÃO sugerir défice calórico agressivo ` +
    `nem perda de peso rápida perto da prova — prioriza carga de hidratos e energia suficiente, e ajusta ` +
    `calorie_goal/carbs_goal em conformidade (mais hidratos, calorias suficientes para o volume de treino).\n` +
    `- Os objetivos de nutrição devem ser coerentes entre si (ex.: soma aproximada de calorias vindas de ` +
    `proteína+hidratos+gordura não deve contradizer o calorie_goal sugerido; usa 4 kcal/g para proteína e ` +
    `hidratos, 9 kcal/g para gordura).\n` +
    `- No campo "rationale", explica em 2-4 frases, em português de Portugal, o raciocínio por trás dos ` +
    `objetivos escolhidos (Corpo e Nutrição), mencionando a prova relevante e o que no histórico levou a ` +
    `essa escolha. Sê direto e concreto, não genérico.\n\n` +
    `Responde apenas com JSON estruturado conforme o schema.`
  );
}

type GeminiUsage = { input_tokens: number; output_tokens: number };

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
    const todayISO = new Date().toISOString().slice(0, 10);

    const profileColumns = ["gender", "height_cm", "weight_kg", "coach_context", ...BODY_GOAL_KEYS, ...NUTRITION_GOAL_KEYS].join(", ");
    const { data: profile, error: profileError } = await sb
      .from("profiles")
      .select(profileColumns)
      .eq("id", userId)
      .maybeSingle();
    if (profileError) return jsonResponse({ error: `Falha a obter perfil: ${profileError.message}` }, 500);

    const { data: assessments } = await sb
      .from("body_assessments")
      .select(BODY_METRICS.map((m) => m.key).join(", ") + ", date")
      .eq("user_id", userId)
      .order("date", { ascending: false })
      .limit(20);

    const { data: raceEvents } = await sb
      .from("race_events")
      .select("date, name, race_type, target_time")
      .eq("user_id", userId)
      .neq("status", "concluida")
      .gte("date", todayISO)
      .order("date", { ascending: true })
      .limit(5);

    const windowStart60 = new Date();
    windowStart60.setUTCDate(windowStart60.getUTCDate() - 59);
    const windowStart60ISO = windowStart60.toISOString().slice(0, 10);

    const { data: runs } = await sb
      .from("runs")
      .select("date, kind, training_type, distance_km, duration_seconds")
      .eq("user_id", userId)
      .gte("date", windowStart60ISO)
      .order("date", { ascending: false })
      .limit(30);

    const { data: gymSessions } = await sb
      .from("workout_sessions")
      .select("date, name, status, workout_session_sets(reps, weight)")
      .eq("user_id", userId)
      .eq("status", "concluido")
      .gte("date", windowStart60ISO)
      .order("date", { ascending: false })
      .limit(20);

    const windowStart14 = new Date();
    windowStart14.setUTCDate(windowStart14.getUTCDate() - 13);
    const { data: meals } = await sb
      .from("meals")
      .select("date, meal_items(quantity_grams, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g)")
      .eq("user_id", userId)
      .gte("date", windowStart14.toISOString().slice(0, 10))
      .lte("date", todayISO);

    const prompt = buildPrompt(
      profile || {}, assessments || [], raceEvents || [], runs || [], gymSessions || [], meals || [], todayISO,
    );

    const geminiRes = await fetchGeminiWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
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
        return jsonResponse({
          error: "O Gemini atingiu o limite de pedidos gratuitos neste momento. Espera um pouco e tenta novamente.",
        }, 502);
      }
      return jsonResponse({ error: `Falha ao gerar objetivos (Gemini ${geminiRes.status}). Tenta novamente.` }, 502);
    }

    const geminiJson = await geminiRes.json();
    const usage: GeminiUsage = {
      input_tokens: Number(geminiJson?.usageMetadata?.promptTokenCount) || 0,
      output_tokens: Number(geminiJson?.usageMetadata?.candidatesTokenCount) || 0,
    };
    const rawText = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;
    let parsed: { goals?: Record<string, unknown>; rationale?: unknown };
    try {
      parsed = JSON.parse(rawText);
    } catch {
      console.error("Gemini devolveu JSON inválido:", rawText);
      return jsonResponse({ error: "A análise devolveu um formato inesperado. Tenta novamente." }, 502);
    }

    const num = (v: unknown): number | null =>
      typeof v === "number" && isFinite(v) && v >= 0 ? v : null;
    const rawGoals = (parsed.goals ?? {}) as Record<string, unknown>;

    // Só gravamos as chaves com valor sugerido — nunca apagamos um objetivo
    // existente só porque o Gemini decidiu não opinar sobre essa métrica.
    const goalsToSave: Record<string, number> = {};
    for (const key of [...BODY_GOAL_KEYS, ...NUTRITION_GOAL_KEYS]) {
      const v = num(rawGoals[key]);
      if (v !== null) goalsToSave[key] = v;
    }

    const rationale = typeof parsed.rationale === "string" && parsed.rationale.trim()
      ? parsed.rationale.trim()
      : "O Coach não forneceu uma explicação para esta sugestão.";

    if (Object.keys(goalsToSave).length > 0) {
      const { error: updateError } = await sb.from("profiles").update(goalsToSave).eq("id", userId);
      if (updateError) return jsonResponse({ error: `Falha a gravar objetivos: ${updateError.message}` }, 500);
    }

    return jsonResponse({ goals: goalsToSave, rationale, usage });
  } catch (e) {
    console.error("Erro inesperado:", e);
    return jsonResponse({ error: "Erro inesperado no servidor" }, 500);
  }
});
