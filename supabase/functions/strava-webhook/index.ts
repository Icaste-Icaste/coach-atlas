const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

const SB_URL  = Deno.env.get('SUPABASE_URL')!;
const SB_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TG_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const TG_CHAT  = Deno.env.get('TELEGRAM_CHAT_ID')!;
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY');

const SYSTEM_PROMPT = `Tu es Coach Atlas — expert en trail/ultratrail et triathlon.
Profil athlète Noah : 65 km/sem, 2000-3000 m D+/sem, ultra récent 67 km / 2700 m D+.
Objectifs : UTMB Andorre dans ~1 mois, Lyon→Nice 500 km.
Quand tu analyses une activité Strava, sois précis, chiffré, direct.
Format Telegram (pas de markdown lourd) : utilise des emojis, max 300 mots.
Structure : 📊 Données | 💡 Analyse | ✅ Point clé | ➡️ Action 24-48h`;

async function sbFetch(path: string, opts: RequestInit = {}) {
  return fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
      ...(opts.headers || {}),
    },
  });
}

async function sendTelegram(text: string) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }),
  });
}

async function getStravaToken(athleteId: number) {
  const res = await sbFetch(`/strava_tokens?athlete_id=eq.${athleteId}&select=*`);
  const rows = await res.json();
  if (!rows?.length) return null;
  let token = rows[0];

  // Refresh si expiré
  if (token.expires_at < Math.floor(Date.now() / 1000) + 300) {
    const r = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: Deno.env.get('STRAVA_CLIENT_ID'),
        client_secret: Deno.env.get('STRAVA_CLIENT_SECRET'),
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token,
      }),
    });
    const fresh = await r.json();
    token = { ...token, access_token: fresh.access_token, refresh_token: fresh.refresh_token, expires_at: fresh.expires_at };
    await sbFetch(`/strava_tokens?athlete_id=eq.${athleteId}`, {
      method: 'PATCH',
      body: JSON.stringify({ access_token: fresh.access_token, refresh_token: fresh.refresh_token, expires_at: fresh.expires_at, updated_at: new Date().toISOString() }),
    });
  }
  return token;
}

async function analyzeWithClaude(activity: Record<string, unknown>, recentSessions: unknown[]) {
  if (!ANTHROPIC_KEY) return null;

  const pace = activity.avg_pace
    ? `${Math.floor(Number(activity.avg_pace)/60)}'${String(Math.round(Number(activity.avg_pace)%60)).padStart(2,'0')}"/km`
    : '—';

  const historyContext = recentSessions.length > 0
    ? `Dernières sessions coach : ${JSON.stringify(recentSessions.slice(0,3).map((s: unknown) => {
        const sess = s as Record<string, unknown>;
        return { name: sess.name, messages_count: Array.isArray(sess.messages) ? sess.messages.length : 0 };
      }))}`
    : '';

  const prompt = `Activité Strava enregistrée :
- Nom : ${activity.name}
- Type : ${activity.type}
- Distance : ${activity.distance_km} km
- Dénivelé : ${activity.elevation_m} m D+
- Durée : ${Math.floor(Number(activity.duration_s)/3600)}h${Math.floor((Number(activity.duration_s)%3600)/60)}min
- Allure moyenne : ${pace}
- FC moy : ${activity.avg_hr || '—'} bpm | FC max : ${activity.max_hr || '—'} bpm
- Calories : ${activity.calories || '—'}
${historyContext}

Analyse cette sortie pour Noah. Format court pour Telegram (emojis, max 250 mots).`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 600, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await res.json();
  return data.content?.[0]?.text || null;
}

async function processActivity(event: Record<string, unknown>) {
  const athleteId = event.owner_id as number;
  const activityId = event.object_id as number;

  const tokenData = await getStravaToken(athleteId);
  if (!tokenData) return;

  // Fetch activité depuis Strava
  const actRes = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
    headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
  });
  const act = await actRes.json();
  if (act.errors) return;

  const distKm = +(act.distance / 1000).toFixed(2);
  const avgPace = distKm > 0 ? +(act.moving_time / distKm).toFixed(2) : null;

  const activity = {
    id: `${tokenData.user_id}_${activityId}`,
    user_id: tokenData.user_id,
    strava_id: activityId,
    name: act.name,
    type: act.type,
    distance_km: distKm,
    elevation_m: +(act.total_elevation_gain || 0).toFixed(1),
    duration_s: act.moving_time,
    avg_pace: avgPace,
    avg_hr: act.average_heartrate ? Math.round(act.average_heartrate) : null,
    max_hr: act.max_heartrate ? Math.round(act.max_heartrate) : null,
    calories: act.calories || null,
    start_date: act.start_date,
    raw_json: act,
  };

  // Sauvegarde en base
  await sbFetch('/strava_activities', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(activity),
  });

  // Récupère sessions récentes pour contexte
  const sessRes = await sbFetch(`/coach_sessions?user_id=eq.${tokenData.user_id}&order=updated_at.desc&limit=5&select=name,messages,updated_at`);
  const sessions = await sessRes.json().catch(() => []);

  // Analyse Claude
  const analysis = await analyzeWithClaude(activity, sessions);

  // Message Telegram
  const pace = avgPace
    ? `${Math.floor(avgPace/60)}'${String(Math.round(avgPace%60)).padStart(2,'0')}"/km`
    : '—';

  const msg = analysis
    ? `🏃 <b>${act.name}</b>\n\n${analysis}`
    : `🏃 <b>${act.name}</b> synced !\n\n📊 ${distKm} km | ${activity.elevation_m} m D+ | ${Math.floor(act.moving_time/3600)}h${Math.floor((act.moving_time%3600)/60)}min | ${pace}${activity.avg_hr ? ` | ❤️ ${activity.avg_hr} bpm` : ''}\n\nOuvre Coach Atlas pour l'analyse complète.`;

  await sendTelegram(msg);

  // Questions de ressenti 3 secondes après l'analyse
  await new Promise(r => setTimeout(r, 3000));
  const stats = `${distKm} km | ${activity.elevation_m} m D+ | ${Math.floor(act.moving_time/3600)}h${Math.floor((act.moving_time%3600)/60)}min | ${pace}`;
  await sendRessentQuestions(act.name, stats);
}

async function sendRessentQuestions(activityName: string, stats: string) {
  const SB_URL_LOCAL = Deno.env.get('SUPABASE_URL')!;
  const SB_KEY_LOCAL = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const TG_TOKEN_LOCAL = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
  const TG_CHAT_LOCAL = Deno.env.get('TELEGRAM_CHAT_ID')!;

  // Sauvegarde l'état
  await fetch(`${SB_URL_LOCAL}/rest/v1/telegram_state`, {
    method: 'POST',
    headers: {
      'apikey': SB_KEY_LOCAL, 'Authorization': `Bearer ${SB_KEY_LOCAL}`,
      'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      chat_id: TG_CHAT_LOCAL,
      state: 'waiting_q1',
      activity_name: activityName,
      activity_stats: stats,
      answers: {},
      updated_at: new Date().toISOString(),
    }),
  });

  // Envoie la première question
  await fetch(`https://api.telegram.org/bot${TG_TOKEN_LOCAL}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TG_CHAT_LOCAL,
      text: `💬 Comment tu te sens après "${activityName}" ?`,
      reply_markup: {
        inline_keyboard: [[
          { text: '💪 Au top', callback_data: 'q1_top' },
          { text: '😊 Bien', callback_data: 'q1_bien' },
          { text: '😐 Moyen', callback_data: 'q1_moyen' },
          { text: '😓 Fatigué', callback_data: 'q1_fatigue' },
        ]],
      },
    }),
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  // Vérification webhook Strava (GET)
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const challenge = url.searchParams.get('hub.challenge');
    const verify = url.searchParams.get('hub.verify_token');
    if (verify === 'COACH_ATLAS_WEBHOOK' && challenge) {
      return new Response(JSON.stringify({ 'hub.challenge': challenge }), {
        headers: { ...CORS, 'content-type': 'application/json' },
      });
    }
    return new Response('Forbidden', { status: 403 });
  }

  // Webhook event (POST) — répondre immédiatement
  const event = await req.json().catch(() => ({}));
  if (event.aspect_type === 'create' && event.object_type === 'activity') {
    // Fire & forget
    processActivity(event).catch(console.error);
  }
  return new Response('ok', { headers: CORS });
});

// Export pour usage depuis d'autres fonctions
export { sendTelegram };
