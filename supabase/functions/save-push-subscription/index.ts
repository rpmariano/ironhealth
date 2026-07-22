// IronHealth · save-push-subscription Edge Function
// Regista (POST) ou remove (DELETE) a subscrição Web Push do browser do
// utilizador autenticado, usada por send-water-reminders para o notificar
// mesmo com a app fechada.

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST" && req.method !== "DELETE") {
    return jsonResponse({ error: "Método não suportado" }, 405);
  }

  try {
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

    const body = await req.json().catch(() => ({}));
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : null;
    if (!endpoint) return jsonResponse({ error: "Endpoint em falta" }, 400);

    if (req.method === "DELETE") {
      const { error } = await sb.from("push_subscriptions").delete()
        .eq("user_id", userId).eq("endpoint", endpoint);
      if (error) return jsonResponse({ error: error.message }, 500);
      return jsonResponse({ ok: true });
    }

    const p256dh = body?.keys?.p256dh;
    const auth = body?.keys?.auth;
    if (typeof p256dh !== "string" || typeof auth !== "string") {
      return jsonResponse({ error: "Subscrição inválida" }, 400);
    }

    const { error } = await sb.from("push_subscriptions")
      .upsert({ user_id: userId, endpoint, p256dh, auth }, { onConflict: "endpoint" });
    if (error) return jsonResponse({ error: error.message }, 500);

    return jsonResponse({ ok: true });
  } catch (e) {
    console.error("Erro inesperado:", e);
    return jsonResponse({ error: "Erro inesperado no servidor" }, 500);
  }
}

if (import.meta.main) {
  Deno.serve(handler);
}
