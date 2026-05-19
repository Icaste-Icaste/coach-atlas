const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-anthropic-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

async function loadFullHistory(userId: string): Promise<{role:string, content:string}[]> {
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/coach_sessions?user_id=eq.${userId}&order=updated_at.desc&limit=8&select=messages,name,updated_at`,
      { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }
    );
    const sessions = await res.json();
    if (!Array.isArray(sessions)) return [];

    const all: {role:string, content:string}[] = [];
    // Parcourt du plus ancien au plus récent pour garder la chronologie
    for (const session of sessions.reverse()) {
      const msgs = Array.isArray(session.messages) ? session.messages : [];
      for (const m of msgs) {
        if (m.content) all.push({
          role: m.role === 'coach' ? 'assistant' : 'user',
          content: String(m.content).slice(0, 800), // limite par message
        });
      }
    }
    return all.slice(-30); // 30 derniers messages toutes sessions confondues
  } catch { return []; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { messages, system, user_id } = await req.json();

    const apiKey = req.headers.get('x-anthropic-key');
    if (!apiKey) return new Response(JSON.stringify({ error: 'Missing API key' }), {
      status: 401, headers: { ...CORS, 'content-type': 'application/json' },
    });

    // Charge l'historique complet depuis Supabase si user_id fourni
    let contextMessages = messages;
    if (user_id) {
      const history = await loadFullHistory(user_id);
      // Fusionne : historique global + messages actuels (sans doublons)
      // Le dernier message de messages[] est le nouveau message utilisateur
      const lastMsg = messages[messages.length - 1];
      contextMessages = [...history, lastMsg].filter(Boolean);
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system,
        messages: contextMessages,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || JSON.stringify(data));

    return new Response(JSON.stringify({ reply: data.content[0].text }), {
      headers: { ...CORS, 'content-type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...CORS, 'content-type': 'application/json' },
    });
  }
});
