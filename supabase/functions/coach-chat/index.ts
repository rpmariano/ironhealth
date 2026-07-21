// IronHealth · coach-chat Edge Function
// Recebe uma mensagem do utilizador, constrói o contexto completo
// (role de sistema + perfil do utilizador + dados nutricionais de hoje +
// histórico de conversa) e chama o Gemini. Guarda pergunta e resposta
// na tabela coach_messages para persistência entre sessões.

import { createClient } from "jsr:@supabase/supabase-js@2";

// Alias que segue sempre o modelo flash estável mais recente — evita 404s
// quando a Google descontinua uma versão fixa (confirmado em produção: fixar
// em "gemini-2.5-flash" resultou em 404 "no longer available to new users"
// dias depois). O preço de usar o alias é que os parâmetros aceites por
// generationConfig podem mudar de geração para geração (ver thinkingConfig
// abaixo) — por isso esta função evita depender de campos específicos de uma
// geração de modelo.
const GEMINI_MODEL = "gemini-flash-latest";
const MAX_HISTORY   = 30;   // mensagens mais recentes enviadas ao Gemini
const MAX_MSG_LEN   = 2000; // caracteres máximos por mensagem
const MAX_TOOL_ROUNDS = 4;  // idas-e-voltas de function calling antes de forçar resposta final
// Tempo máximo por chamada ao Gemini antes de desistir e tentar mais uma vez.
// A API do Gemini (sobretudo no tier gratuito) tem latência muito variável —
// isto evita que uma chamada presa arraste a função até ao limite rígido da
// plataforma (~150s), o que produz um erro genérico e ilegível no cliente.
const GEMINI_TIMEOUT_MS = 40000;
const GEMINI_RETRIES = 1; // repetições automáticas após timeout, antes de desistir de vez

const NUTRITION_TOOL = {
  name: "get_nutrition_history",
  description:
    "Obtém o resumo nutricional diário (calorias, proteína, hidratos, gordura, nº refeições) " +
    "do utilizador para um intervalo de datas específico. Usa esta função sempre que a pergunta " +
    "envolva um período fora dos últimos 7 dias já fornecidos no contexto (ex: um mês passado, " +
    "uma data concreta, \"desde o início do ano\").",
  parameters: {
    type: "OBJECT",
    properties: {
      start_date: { type: "STRING", description: "Data de início, formato YYYY-MM-DD" },
      end_date: { type: "STRING", description: "Data de fim (inclusive), formato YYYY-MM-DD" },
    },
    required: ["start_date", "end_date"],
  },
};

const GYM_TOOL = {
  name: "get_gym_history",
  description:
    "Obtém os treinos de ginásio concluídos (data, nome do treino, volume total em kg, " +
    "nº de séries) do utilizador para um intervalo de datas específico. Usa esta função " +
    "sempre que a pergunta envolva treinos fora dos últimos 30 dias já fornecidos no contexto.",
  parameters: {
    type: "OBJECT",
    properties: {
      start_date: { type: "STRING", description: "Data de início, formato YYYY-MM-DD" },
      end_date: { type: "STRING", description: "Data de fim (inclusive), formato YYYY-MM-DD" },
    },
    required: ["start_date", "end_date"],
  },
};

const RUNNING_TOOL = {
  name: "get_running_history",
  description:
    "Obtém as corridas do utilizador (data, tipo — simples/treino/competição —, distância, " +
    "duração, pace) para um intervalo de datas específico. Usa esta função sempre que a " +
    "pergunta envolva corridas fora dos últimos 30 dias já fornecidos no contexto.",
  parameters: {
    type: "OBJECT",
    properties: {
      start_date: { type: "STRING", description: "Data de início, formato YYYY-MM-DD" },
      end_date: { type: "STRING", description: "Data de fim (inclusive), formato YYYY-MM-DD" },
    },
    required: ["start_date", "end_date"],
  },
};

// Ferramentas que o Gemini pode invocar quando a pergunta do utilizador sai
// das janelas já incluídas no contexto (ex: "compara Maio com hoje").
function buildTools() {
  return [{ functionDeclarations: [NUTRITION_TOOL, GYM_TOOL, RUNNING_TOOL] }];
}

// Contagem de tokens de uma (ou mais, somadas) chamadas ao Gemini —
// usada para estimar o custo real da API — ver admin_logs/painel de custos.
type GeminiUsage = { input_tokens: number; output_tokens: number };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Resposta estruturada: separa o texto da resposta das sugestões de
// seguimento, para o cliente poder mostrar as sugestões como botões
// em vez de o modelo as misturar dentro do texto. `on_topic` deixa o
// próprio modelo sinalizar perguntas fora do âmbito da app (ver
// buildSystemInstruction) — o servidor devolve erro nesse caso em vez
// de guardar/mostrar uma resposta.
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    on_topic: { type: "BOOLEAN" },
    reply: { type: "STRING" },
    suggestions: {
      type: "ARRAY",
      items: { type: "STRING" },
      maxItems: 3,
    },
  },
  required: ["on_topic", "reply", "suggestions"],
};

// Estados HTTP de sobrecarga momentânea do lado da Google (500/502/503/504) —
// vale a pena repetir estes, porque costumam resolver-se à segunda. O 429
// (limite de pedidos excedido) fica DE FORA de propósito: repetir logo a
// seguir só volta a bater no mesmo limite por minuto — e até o acelera — por
// isso passa já ao chamador com a mensagem própria de 429 (ver handler).
// Erros "permanentes" (400, 401, 403...) também passam sempre à primeira.
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

type DayTotals = { kcal: number; prot: number; carbs: number; fat: number; meals: number };

// deno-lint-ignore no-explicit-any
export function aggregateMealsByDate(meals: any[]): Record<string, DayTotals> {
  const byDate: Record<string, DayTotals> = {};
  for (const meal of meals) {
    if (!byDate[meal.date]) byDate[meal.date] = { kcal: 0, prot: 0, carbs: 0, fat: 0, meals: 0 };
    const d = byDate[meal.date];
    d.meals += 1;
    for (const it of (meal.meal_items || [])) {
      const f = (it.quantity_grams || 0) / 100;
      d.kcal  += (it.calories_per_100g || 0) * f;
      d.prot  += (it.protein_per_100g  || 0) * f;
      d.carbs += (it.carbs_per_100g    || 0) * f;
      d.fat   += (it.fat_per_100g      || 0) * f;
    }
  }
  return byDate;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;      // limite defensivo para não pedir intervalos absurdos
const WEEKLY_BUCKET_THRESHOLD = 35; // acima disto, agrega por semana em vez de por dia

// Executa a function call pedida pelo Gemini: vai buscar os dados nutricionais
// do intervalo pedido e devolve um resumo textual compacto.
// deno-lint-ignore no-explicit-any
export async function runGetNutritionHistory(sb: any, userId: string, args: { start_date?: string; end_date?: string }): Promise<string> {
  const { start_date, end_date } = args;
  if (!start_date || !end_date || !ISO_DATE_RE.test(start_date) || !ISO_DATE_RE.test(end_date)) {
    return "Erro: start_date e end_date têm de ser strings no formato YYYY-MM-DD.";
  }
  const start = new Date(start_date + "T00:00:00Z");
  const end = new Date(end_date + "T00:00:00Z");
  if (start > end) return "Erro: start_date é posterior a end_date.";
  const rangeDays = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  if (rangeDays > MAX_RANGE_DAYS) return `Erro: intervalo demasiado longo (máximo ${MAX_RANGE_DAYS} dias).`;

  const { data: meals, error } = await sb
    .from("meals")
    .select("date, meal_items(quantity_grams, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g)")
    .eq("user_id", userId)
    .gte("date", start_date)
    .lte("date", end_date);

  if (error) return `Erro ao consultar dados: ${error.message}`;

  const byDate = aggregateMealsByDate(meals || []);
  const daysWithData = Object.keys(byDate).length;
  if (daysWithData === 0) {
    return `Sem refeições registadas entre ${start_date} e ${end_date}.`;
  }

  if (rangeDays <= WEEKLY_BUCKET_THRESHOLD) {
    const lines: string[] = [];
    for (let i = 0; i < rangeDays; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i);
      const iso = d.toISOString().slice(0, 10);
      const day = byDate[iso];
      lines.push(
        day
          ? `- ${iso}: ${day.kcal.toFixed(0)} kcal, ${day.prot.toFixed(0)}g proteína, ${day.carbs.toFixed(0)}g hidratos, ${day.fat.toFixed(0)}g gordura (${day.meals} refeições)`
          : `- ${iso}: sem refeições registadas`,
      );
    }
    return `Resumo diário de ${start_date} a ${end_date}:\n${lines.join("\n")}`;
  }

  // Intervalo longo: agrega por semana para não inchar o prompt.
  const weeks: { start: string; end: string; totals: DayTotals; days: number }[] = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    const weekStart = new Date(cursor);
    const weekEnd = new Date(cursor);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    if (weekEnd > end) weekEnd.setTime(end.getTime());

    const totals: DayTotals = { kcal: 0, prot: 0, carbs: 0, fat: 0, meals: 0 };
    let days = 0;
    const d = new Date(weekStart);
    while (d <= weekEnd) {
      const iso = d.toISOString().slice(0, 10);
      const day = byDate[iso];
      if (day) {
        totals.kcal += day.kcal; totals.prot += day.prot;
        totals.carbs += day.carbs; totals.fat += day.fat; totals.meals += day.meals;
        days += 1;
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }
    weeks.push({ start: weekStart.toISOString().slice(0, 10), end: weekEnd.toISOString().slice(0, 10), totals, days });
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }

  const lines = weeks.map((w) => {
    const n = Math.max(w.days, 1);
    return `- ${w.start} a ${w.end} (média/dia com registo, ${w.days} dias registados): ` +
      `${(w.totals.kcal / n).toFixed(0)} kcal, ${(w.totals.prot / n).toFixed(0)}g proteína, ` +
      `${(w.totals.carbs / n).toFixed(0)}g hidratos, ${(w.totals.fat / n).toFixed(0)}g gordura`;
  });
  return `Resumo semanal (médias diárias) de ${start_date} a ${end_date}:\n${lines.join("\n")}`;
}

// ── Ginásio ────────────────────────────────────────────────────────────────
// Resume sessões de treino em {data, nome, volume, séries}. Volume = Σ reps×carga
// sobre séries com reps e carga preenchidos.
// deno-lint-ignore no-explicit-any
export function summariseSessions(sessions: any[]): { date: string; name: string; volume: number; sets: number }[] {
  return sessions.map((s) => {
    let volume = 0;
    let sets = 0;
    for (const st of (s.workout_session_sets || [])) {
      if (st.reps != null && st.weight != null) { volume += st.reps * st.weight; sets += 1; }
    }
    return { date: s.date, name: s.name || "Treino", volume, sets };
  });
}

// deno-lint-ignore no-explicit-any
function buildGymSummary(sessions: any[], windowDays: number): string {
  const rows = summariseSessions(sessions);
  if (rows.length === 0) {
    return `Treinos de ginásio (últimos ${windowDays} dias): sem treinos concluídos.`;
  }
  const lines = rows.map((r) =>
    `- ${r.date}: ${r.name} — ${Math.round(r.volume)} kg de volume, ${r.sets} séries`,
  );
  return `Treinos de ginásio (últimos ${windowDays} dias, ${rows.length} concluído(s)):\n${lines.join("\n")}`;
}

// Executa a function call get_gym_history: treinos concluídos num intervalo.
// deno-lint-ignore no-explicit-any
export async function runGetGymHistory(sb: any, userId: string, args: { start_date?: string; end_date?: string }): Promise<string> {
  const { start_date, end_date } = args;
  if (!start_date || !end_date || !ISO_DATE_RE.test(start_date) || !ISO_DATE_RE.test(end_date)) {
    return "Erro: start_date e end_date têm de ser strings no formato YYYY-MM-DD.";
  }
  const start = new Date(start_date + "T00:00:00Z");
  const end = new Date(end_date + "T00:00:00Z");
  if (start > end) return "Erro: start_date é posterior a end_date.";
  const rangeDays = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  if (rangeDays > MAX_RANGE_DAYS) return `Erro: intervalo demasiado longo (máximo ${MAX_RANGE_DAYS} dias).`;

  const { data, error } = await sb
    .from("workout_sessions")
    .select("date, name, status, workout_session_sets(reps, weight)")
    .eq("user_id", userId)
    .eq("status", "concluido")
    .gte("date", start_date)
    .lte("date", end_date)
    .order("date", { ascending: true });

  if (error) return `Erro ao consultar dados: ${error.message}`;
  const rows = summariseSessions(data || []);
  if (rows.length === 0) return `Sem treinos concluídos entre ${start_date} e ${end_date}.`;
  const lines = rows.map((r) => `- ${r.date}: ${r.name} — ${Math.round(r.volume)} kg de volume, ${r.sets} séries`);
  return `Treinos de ${start_date} a ${end_date} (${rows.length}):\n${lines.join("\n")}`;
}

// ── Corrida ──────────────────────────────────────────────────────────────
const RUN_KIND_LABELS: Record<string, string> = {
  simples: "Simples", treino: "Treino", competicao: "Competição",
};
const RUN_TRAINING_TYPE_LABELS: Record<string, string> = {
  continuo: "Contínuo", longo: "Longo", tempo: "Tempo", recuperacao: "Recuperação",
  intervalos: "Intervalos", sprints: "Sprints",
};

function formatPace(distanceKm: number | null, durationSeconds: number | null): string | null {
  if (!distanceKm || !durationSeconds || distanceKm <= 0) return null;
  const secPerKm = durationSeconds / distanceKm;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}/km`;
}
function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.round(totalSeconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

// deno-lint-ignore no-explicit-any
function summariseRuns(runs: any[]): string[] {
  return runs.map((r) => {
    const kindLabel = r.kind === "treino"
      ? `Treino${r.training_type ? ` (${RUN_TRAINING_TYPE_LABELS[r.training_type] || r.training_type})` : ""}`
      : RUN_KIND_LABELS[r.kind] || "Simples";
    const distance = r.distance_km != null ? `${Number(r.distance_km).toFixed(2)} km` : null;
    const duration = r.duration_seconds != null ? formatDuration(r.duration_seconds) : null;
    const pace = formatPace(r.distance_km, r.duration_seconds);
    const parts = [distance, duration, pace].filter(Boolean);
    return `- ${r.date}: ${kindLabel}${parts.length ? ` — ${parts.join(", ")}` : ""}`;
  });
}

// deno-lint-ignore no-explicit-any
function buildRunningSummary(runs: any[], windowDays: number): string {
  if (runs.length === 0) {
    return `Corridas (últimos ${windowDays} dias): sem corridas registadas.`;
  }
  return `Corridas (últimos ${windowDays} dias, ${runs.length} registada(s)):\n${summariseRuns(runs).join("\n")}`;
}

// Executa a function call get_running_history: corridas num intervalo.
// deno-lint-ignore no-explicit-any
export async function runGetRunningHistory(sb: any, userId: string, args: { start_date?: string; end_date?: string }): Promise<string> {
  const { start_date, end_date } = args;
  if (!start_date || !end_date || !ISO_DATE_RE.test(start_date) || !ISO_DATE_RE.test(end_date)) {
    return "Erro: start_date e end_date têm de ser strings no formato YYYY-MM-DD.";
  }
  const start = new Date(start_date + "T00:00:00Z");
  const end = new Date(end_date + "T00:00:00Z");
  if (start > end) return "Erro: start_date é posterior a end_date.";
  const rangeDays = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  if (rangeDays > MAX_RANGE_DAYS) return `Erro: intervalo demasiado longo (máximo ${MAX_RANGE_DAYS} dias).`;

  const { data, error } = await sb
    .from("runs")
    .select("date, kind, training_type, distance_km, duration_seconds")
    .eq("user_id", userId)
    .gte("date", start_date)
    .lte("date", end_date)
    .order("date", { ascending: true });

  if (error) return `Erro ao consultar dados: ${error.message}`;
  if (!data || data.length === 0) return `Sem corridas registadas entre ${start_date} e ${end_date}.`;
  return `Corridas de ${start_date} a ${end_date} (${data.length}):\n${summariseRuns(data).join("\n")}`;
}

// ── Agenda de provas ─────────────────────────────────────────────────────
const RACE_TYPE_LABELS: Record<string, string> = {
  estrada: "Estrada", trail: "Trail", ultra: "Ultra", "5k": "5 km", "10k": "10 km",
  "21k": "Meia maratona", "42k": "Maratona", outro: "Outro",
};

// Contexto das próximas provas agendadas — é a base da proactividade do
// Coach (ex.: sugerir tapering/hidratos quando falta pouco para uma prova).
// Inclui explicitamente "dias até à prova" para o modelo não ter de calcular
// datas por conta própria.
// deno-lint-ignore no-explicit-any
function buildRaceEventsContext(events: any[], todayISO: string): string | null {
  if (events.length === 0) return null;
  const today = new Date(todayISO + "T00:00:00Z");
  const lines = events.map((e) => {
    const eventDate = new Date(e.date + "T00:00:00Z");
    const daysUntil = Math.round((eventDate.getTime() - today.getTime()) / 86400000);
    const typeLabel = RACE_TYPE_LABELS[e.race_type] || e.race_type;
    const extras = [
      e.location ? `local: ${e.location}` : null,
      e.target_time ? `tempo-alvo: ${e.target_time}` : null,
    ].filter(Boolean).join(", ");
    return `- ${e.date} (daqui a ${daysUntil} dia(s)): ${e.name} — ${typeLabel}${extras ? ` (${extras})` : ""}`;
  });
  return `Próximas provas agendadas:\n${lines.join("\n")}`;
}

function buildSystemInstruction(
  coachContext: string | null,
  biometrics: { height_cm: number | null; weight_kg: number | null; gender: string | null },
  nutritionSummary: string,
  gymSummary: string | null,
  runningSummary: string | null,
  raceEventsContext: string | null,
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
    `MUITO IMPORTANTE — âmbito: só respondes a perguntas sobre nutrição, treino de ginásio, ` +
    `corrida, composição/avaliação corporal, ou o próprio uso desta app. Para QUALQUER pergunta ` +
    `fora destes temas (ex.: desporto profissional/futebol, atualidade, entretenimento, ` +
    `perguntas pessoais sobre ti como IA, ou qualquer outro assunto geral), define o campo ` +
    `"on_topic" como false e deixa "reply" vazio — não tentes responder ao tema nem explicar ` +
    `porque não podes. Só defines "on_topic" como true quando a pergunta se enquadra no âmbito acima.\n\n` +
    `MUITO IMPORTANTE — foco na pergunta: responde apenas ao que foi perguntado. ` +
    `Se o utilizador pede o próximo treino, dá-lhe só o próximo treino — não expandas ` +
    `automaticamente para um plano da semana inteira, nem inicies sugestões de nutrição ` +
    `ou de outros temas que não foram pedidos. Não tentes ser exaustivo nem antecipar ` +
    `tudo o que a pessoa possa querer saber.\n\n` +
    `No campo "suggestions", propõe até 3 perguntas de seguimento curtas e específicas ` +
    `que o utilizador possa querer fazer a seguir, escritas na primeira pessoa como se ` +
    `fosse o próprio utilizador a perguntar (ex: "Queres um plano de nutrição para hoje?" ` +
    `torna-se "Dá-me um plano de nutrição para hoje"). Não repitas no texto da resposta ` +
    `(campo "reply") o convite para essas perguntas — isso é só para o campo "suggestions". ` +
    `Se não fizer sentido nenhuma sugestão, deixa o array vazio.\n\n` +
    `MUITO IMPORTANTE — proactividade perto de provas: se houver "Próximas provas agendadas" ` +
    `no contexto abaixo, tem sempre em conta a proximidade da mais próxima ao dar qualquer ` +
    `conselho de treino ou nutrição, mesmo que o utilizador não a mencione diretamente. ` +
    `Regras gerais (ajusta com bom senso ao tipo de prova e distância):\n` +
    `- Última semana antes da prova: sugere reduzir o volume de treino (tapering) — menos ` +
    `quilómetros/carga, treinos mais curtos e leves, priorizar descanso e sono.\n` +
    `- Últimos 2-3 dias antes da prova (sobretudo 10km+): sugere aumentar a proporção de ` +
    `hidratos de carbono na alimentação e reduzir a intensidade do treino a quase zero.\n` +
    `- Dia da prova ou no dia seguinte: pergunta como correu / parabeniza, sem impor um novo plano.\n` +
    `Não forces este tópico se o utilizador perguntar algo completamente não relacionado (ex.: ` +
    `um alimento específico) — menciona a prova próxima apenas quando for relevante ou quando ` +
    `deres um conselho de treino/nutrição geral que deva ter isso em conta.\n\n` +
    `Data atual: ${today}.\n\n` +
    `O contexto abaixo tem os dados de nutrição dos últimos 7 dias, os treinos de ginásio e as ` +
    `corridas dos últimos 30 dias. Se a pergunta do utilizador precisar de dados fora dessas ` +
    `janelas (um mês específico, uma data no passado, "desde o início do ano", etc.), usa a ` +
    `função get_nutrition_history (nutrição), get_gym_history (ginásio) ou get_running_history ` +
    `(corrida) com o intervalo de datas necessário antes de responder.`;

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
  if (raceEventsContext) sys += `\n\n${raceEventsContext}`;

  return sys;
}

async function handler(req: Request): Promise<Response> {
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

    // ── Dados nutricionais dos últimos 7 dias ────────────────────────────
    // Uma semana dá ao coach contexto suficiente sobre consistência e
    // padrões (incluindo fins de semana) sem inchar o prompt com histórico
    // desnecessário.
    const NUTRITION_WINDOW_DAYS = 7;
    const todayISO = new Date().toISOString().slice(0, 10);
    const startDate = new Date();
    startDate.setUTCDate(startDate.getUTCDate() - (NUTRITION_WINDOW_DAYS - 1));
    const startISO = startDate.toISOString().slice(0, 10);

    const { data: weekMeals } = await sb
      .from("meals")
      .select("date, meal_items(quantity_grams, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g)")
      .eq("user_id", userId)
      .gte("date", startISO)
      .lte("date", todayISO);

    const byDate: Record<string, { kcal: number; prot: number; carbs: number; fat: number; meals: number }> = {};
    for (const meal of (weekMeals || [])) {
      if (!byDate[meal.date]) byDate[meal.date] = { kcal: 0, prot: 0, carbs: 0, fat: 0, meals: 0 };
      const d = byDate[meal.date];
      d.meals += 1;
      for (const it of (meal.meal_items || [])) {
        const f = (it.quantity_grams || 0) / 100;
        d.kcal  += (it.calories_per_100g || 0) * f;
        d.prot  += (it.protein_per_100g  || 0) * f;
        d.carbs += (it.carbs_per_100g    || 0) * f;
        d.fat   += (it.fat_per_100g      || 0) * f;
      }
    }

    const g = profile || {} as Record<string, unknown>;
    const today = byDate[todayISO];
    const todaySummary = today
      ? `Hoje (${todayISO}):\n` +
        `- Calorias: ${today.kcal.toFixed(0)} kcal (meta diária: ${g.calorie_goal ?? "–"} kcal)\n` +
        `- Proteína: ${today.prot.toFixed(1)} g (meta: ${g.protein_goal ?? "–"} g)\n` +
        `- Hidratos: ${today.carbs.toFixed(1)} g (meta: ${g.carbs_goal ?? "–"} g)\n` +
        `- Gordura: ${today.fat.toFixed(1)} g (meta: ${g.fat_goal ?? "–"} g)\n` +
        `- Refeições registadas: ${today.meals}`
      : `Hoje (${todayISO}): sem refeições registadas ainda.`;

    const historyLines: string[] = [];
    for (let i = 1; i < NUTRITION_WINDOW_DAYS; i++) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      const iso = d.toISOString().slice(0, 10);
      const day = byDate[iso];
      historyLines.push(
        day
          ? `- ${iso}: ${day.kcal.toFixed(0)} kcal, ${day.prot.toFixed(0)}g proteína, ${day.carbs.toFixed(0)}g hidratos, ${day.fat.toFixed(0)}g gordura (${day.meals} refeições)`
          : `- ${iso}: sem refeições registadas`,
      );
    }

    const nutritionSummary =
      `${todaySummary}\n\n` +
      `Histórico dos ${NUTRITION_WINDOW_DAYS - 1} dias anteriores (metas diárias: ${g.calorie_goal ?? "–"} kcal / ${g.protein_goal ?? "–"}g proteína / ${g.carbs_goal ?? "–"}g hidratos / ${g.fat_goal ?? "–"}g gordura):\n` +
      historyLines.join("\n");

    // ── Treinos de ginásio dos últimos 30 dias ───────────────────────────
    // Janela maior que a nutrição porque os treinos são menos frequentes.
    const GYM_WINDOW_DAYS = 30;
    const gymStartD = new Date();
    gymStartD.setUTCDate(gymStartD.getUTCDate() - (GYM_WINDOW_DAYS - 1));
    const gymStartISO = gymStartD.toISOString().slice(0, 10);
    const { data: gymSessions } = await sb
      .from("workout_sessions")
      .select("date, name, status, workout_session_sets(reps, weight)")
      .eq("user_id", userId)
      .eq("status", "concluido")
      .gte("date", gymStartISO)
      .lte("date", todayISO)
      .order("date", { ascending: false });
    const gymSummary = buildGymSummary(gymSessions || [], GYM_WINDOW_DAYS);

    // ── Corridas dos últimos 30 dias ──────────────────────────────────────
    const RUNNING_WINDOW_DAYS = 30;
    const runStartD = new Date();
    runStartD.setUTCDate(runStartD.getUTCDate() - (RUNNING_WINDOW_DAYS - 1));
    const runStartISO = runStartD.toISOString().slice(0, 10);
    const { data: recentRuns } = await sb
      .from("runs")
      .select("date, kind, training_type, distance_km, duration_seconds")
      .eq("user_id", userId)
      .gte("date", runStartISO)
      .lte("date", todayISO)
      .order("date", { ascending: false });
    const runningSummary = buildRunningSummary(recentRuns || [], RUNNING_WINDOW_DAYS);

    // ── Próximas provas agendadas (base da proactividade do Coach) ───────
    // Inclui desde ontem (não só a partir de hoje) para o Coach poder
    // perguntar "como correu?" no dia seguinte a uma prova.
    const raceLookbackD = new Date();
    raceLookbackD.setUTCDate(raceLookbackD.getUTCDate() - 1);
    const raceLookbackISO = raceLookbackD.toISOString().slice(0, 10);
    const { data: upcomingRaces } = await sb
      .from("race_events")
      .select("date, name, race_type, location, target_time")
      .eq("user_id", userId)
      .gte("date", raceLookbackISO)
      .order("date", { ascending: true })
      .limit(5);
    const raceEventsContext = buildRaceEventsContext(upcomingRaces || [], todayISO);

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
    const systemInstruction = buildSystemInstruction(
      profile?.coach_context ?? null,
      {
        height_cm: (profile?.height_cm as number | null) ?? null,
        weight_kg: (profile?.weight_kg as number | null) ?? null,
        gender: (profile?.gender as string | null) ?? null,
      },
      nutritionSummary,
      gymSummary,
      runningSummary,
      raceEventsContext,
    );

    // deno-lint-ignore no-explicit-any
    const contents: any[] = [
      ...(history || []).map((m: { role: string; content: string }) => ({
        role: m.role,
        parts: [{ text: m.content }],
      })),
      { role: "user", parts: [{ text: message }] },
    ];

    // ── Loop de function calling ──────────────────────────────────────────
    // tools + response_schema coexistem: quando o modelo decide chamar uma
    // função devolve uma parte functionCall (ignora o schema), quando decide
    // responder ao utilizador segue o schema {reply, suggestions} como sempre.
    async function callGemini() {
      const res = await fetchGeminiWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemInstruction }] },
            contents,
            tools: buildTools(),
            generationConfig: {
              temperature: 0.7,
              // Sem thinkingConfig de propósito: o campo para desativar/limitar
              // "thinking" mudou de nome entre gerações do modelo por trás do
              // alias "-latest" (thinkingBudget vs. thinkingLevel — confirmado
              // em produção: thinkingBudget causou 400 INVALID_ARGUMENT assim
              // que o alias rodou para uma geração mais recente). Sem o campo,
              // o pedido funciona com qualquer geração; em compensação
              // maxOutputTokens fica bem acima do necessário para a resposta,
              // para sobrar espaço aos tokens de raciocínio interno e a
              // resposta não ser cortada a meio.
              maxOutputTokens: 4000,
              response_mime_type: "application/json",
              response_schema: RESPONSE_SCHEMA,
            },
          }),
        },
      );
      return res;
    }

    // Soma tokens de TODAS as chamadas ao Gemini neste pedido — o loop de
    // function calling pode fazer várias idas-e-voltas (cada uma consome
    // tokens) antes de chegar à resposta final que o utilizador vê.
    const totalUsage: GeminiUsage = { input_tokens: 0, output_tokens: 0 };

    let geminiJson: Record<string, unknown> | undefined;
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const isLastAllowedRound = round === MAX_TOOL_ROUNDS;
      let geminiRes: Response;
      try {
        geminiRes = await callGemini();
      } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : "Falha ao contactar o coach." }, 504);
      }

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        console.error("Gemini error:", geminiRes.status, errText);
        if (geminiRes.status === 429) {
          return jsonResponse({
            error: "O coach atingiu o limite de pedidos da API neste momento. Tenta novamente dentro de alguns minutos.",
          }, 503);
        }
        return jsonResponse({
          error: `Falha na resposta do coach (${geminiRes.status}). Tenta novamente.`,
          detail: errText.slice(0, 500),
        }, 502);
      }

      // deno-lint-ignore no-explicit-any
      const parsedRes: any = await geminiRes.json();
      totalUsage.input_tokens += Number(parsedRes?.usageMetadata?.promptTokenCount) || 0;
      totalUsage.output_tokens += Number(parsedRes?.usageMetadata?.candidatesTokenCount) || 0;
      // deno-lint-ignore no-explicit-any
      const parts: any[] = parsedRes?.candidates?.[0]?.content?.parts || [];
      // deno-lint-ignore no-explicit-any
      const functionCalls = parts.filter((p) => p.functionCall);

      if (functionCalls.length === 0 || isLastAllowedRound) {
        geminiJson = parsedRes;
        break;
      }

      // O modelo pediu dados — regista o turno e executa cada function call.
      contents.push({ role: "model", parts });
      const responseParts = [];
      for (const p of functionCalls) {
        const { name, args } = p.functionCall;
        let result: string;
        if (name === "get_nutrition_history") {
          result = await runGetNutritionHistory(sb, userId, args || {});
        } else if (name === "get_gym_history") {
          result = await runGetGymHistory(sb, userId, args || {});
        } else if (name === "get_running_history") {
          result = await runGetRunningHistory(sb, userId, args || {});
        } else {
          result = `Erro: função desconhecida "${name}".`;
        }
        responseParts.push({ functionResponse: { name, response: { result } } });
      }
      contents.push({ role: "function", parts: responseParts });
    }

    const rawText: string | undefined =
      // deno-lint-ignore no-explicit-any
      (geminiJson as any)?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawText) {
      console.error("Gemini resposta vazia:", JSON.stringify(geminiJson));
      return jsonResponse({ error: "O coach não conseguiu gerar uma resposta. Tenta novamente." }, 502);
    }

    let replyText: string;
    let suggestions: string[] = [];
    try {
      const parsed = JSON.parse(rawText);
      // O modelo sinaliza perguntas fora do âmbito da app (ver
      // buildSystemInstruction) — devolve erro em vez de guardar/mostrar
      // uma resposta, e não insere a mensagem do modelo no histórico.
      if (parsed.on_topic === false) {
        return jsonResponse({
          error: "Só posso ajudar com temas de nutrição, treino de ginásio, corrida e composição corporal — os módulos desta app. Tenta outra pergunta relacionada com estas áreas.",
        }, 400);
      }
      replyText = typeof parsed.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : rawText;
      suggestions = Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s: unknown) => typeof s === "string" && s.trim()).slice(0, 3)
        : [];
    } catch {
      // JSON inválido/cortado (ex.: resposta truncada a meio) — nunca mostrar
      // o texto bruto ao utilizador (parecia um JSON partido no ecrã); melhor
      // pedir para tentar de novo do que guardar/mostrar lixo no histórico.
      console.error("Gemini devolveu JSON inválido/incompleto:", rawText);
      return jsonResponse({
        error: "O coach teve um problema a gerar a resposta. Tenta novamente.",
      }, 502);
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
        suggestions,
        usage: totalUsage,
      });
    }

    return jsonResponse({ user_message: userMsg, model_message: modelMsg, suggestions, usage: totalUsage });

  } catch (e) {
    console.error("Erro inesperado:", e);
    return jsonResponse({ error: "Erro inesperado no servidor" }, 500);
  }
}

if (import.meta.main) {
  Deno.serve(handler);
}
