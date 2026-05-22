const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SB_URL  = Deno.env.get('SUPABASE_URL')!;
const SB_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANT_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const TG_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const TG_CHAT  = Deno.env.get('TELEGRAM_CHAT_ID')!;

const USER_ID = 'u_6vb0si3amp8sxkkw';

async function sendTelegram(text: string) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text }),
  });
}

async function getLastWeekSleep(): Promise<unknown[]> {
  const since = new Date();
  since.setDate(since.getDate() - 7);
  const res = await fetch(
    `${SB_URL}/rest/v1/sleep_data?user_id=eq.${USER_ID}&date=gte.${since.toISOString().slice(0,10)}&order=date.desc&limit=7`,
    { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }
  );
  return res.json();
}

async function analyzeSleep(data: Record<string, unknown>, history: unknown[]): Promise<string> {
  const histSummary = (history as Record<string, unknown>[]).map(d =>
    `${d.date}: ${d.sleep_duration_min}min sommeil | HRV ${d.hrv_avg || '—'} | RC ${d.resting_hr || '—'}`
  ).join('\n');

  const prompt = `Données nuit du ${data.date} (Noah, trail/ultra, UTMB Andorre 12 juin J-${Math.max(0, Math.round((new Date('2026-06-12').getTime() - Date.now()) / 86400000))}):

Sommeil total : ${data.sleep_duration_min} min (${((data.sleep_duration_min as number)/60).toFixed(1)}h)
Profond : ${data.deep_sleep_min || '—'} min | REM : ${data.rem_sleep_min || '—'} min | Léger : ${data.light_sleep_min || '—'} min
HRV moy : ${data.hrv_avg || '—'} ms | FC repos : ${data.resting_hr || '—'} bpm
${data.body_battery ? `Body Resources/Battery : ${data.body_battery}/100` : ''}
${data.respiratory_rate ? `FR repos : ${data.respiratory_rate}/min` : ''}

Historique 7 jours :
${histSummary || 'Première mesure'}

Donne un bilan de récupération en 3 points max (format Telegram, max 100 mots) :
1. Qualité nuit (bon/moyen/mauvais + raison chiffrée)
2. Niveau de récupération pour s'entraîner aujourd'hui (feu vert / orange / rouge)
3. Recommandation séance du jour adaptée (type + D+ + durée)
Emojis OK, texte brut.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANT_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: 'Tu es Coach Atlas, expert trail/ultra. Réponds en français, direct et chiffré. Jamais de données inventées.',
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const d = await res.json();
  return d.content?.[0]?.text || '';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const body = await req.json();
    const {
      date,
      sleep_duration_min,
      deep_sleep_min,
      rem_sleep_min,
      light_sleep_min,
      awake_min,
      hrv_avg,
      hrv_sdnn,
      resting_hr,
      body_battery,
      respiratory_rate,
      sleep_score,
    } = body;

    if (!date) throw new Error('date requis (YYYY-MM-DD)');

    // Sauvegarde en base
    await fetch(`${SB_URL}/rest/v1/sleep_data`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        user_id: USER_ID, date, sleep_duration_min, deep_sleep_min, rem_sleep_min,
        light_sleep_min, awake_min, hrv_avg, hrv_sdnn, resting_hr,
        body_battery, respiratory_rate, sleep_score, source: 'apple_health',
      }),
    });

    // Analyse + envoi Telegram
    const history = await getLastWeekSleep();
    const analysis = await analyzeSleep(body, history);
    if (analysis) {
      const h = Math.floor((sleep_duration_min || 0) / 60);
      const m = (sleep_duration_min || 0) % 60;
      const msg = `😴 Nuit du ${date} — ${h}h${m.toString().padStart(2,'0')}${hrv_avg ? ` | HRV ${hrv_avg}ms` : ''}${resting_hr ? ` | FC repos ${resting_hr}` : ''}\n\n${analysis}`;
      await sendTelegram(msg);
    }

    // Sauvegarde dans historique coach unifié
    const sessionRes = await fetch(
      `${SB_URL}/rest/v1/coach_sessions?id=eq.telegram_main&select=messages`,
      { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }
    );
    const sessions = await sessionRes.json();
    const prevMsgs = sessions?.[0]?.messages || [];
    await fetch(`${SB_URL}/rest/v1/coach_sessions`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        id: 'telegram_main',
        user_id: USER_ID,
        name: '📱 Telegram',
        goal: 'andorre',
        messages: [
          ...prevMsgs,
          { role: 'user', content: `[Sommeil ${date}] ${sleep_duration_min}min | HRV: ${hrv_avg || '—'} | FC repos: ${resting_hr || '—'} | Body Battery: ${body_battery || '—'}`, channel: 'health', ts: new Date().toISOString() },
          { role: 'coach', content: analysis, channel: 'telegram', ts: new Date().toISOString() },
        ],
        updated_at: new Date().toISOString(),
      }),
    });

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...CORS, 'content-type': 'application/json' },
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...CORS, 'content-type': 'application/json' },
    });
  }
});
