const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const TG_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const TG_CHAT  = Deno.env.get('TELEGRAM_CHAT_ID')!;
const SB_URL   = Deno.env.get('SUPABASE_URL')!;
const SB_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANT_KEY  = Deno.env.get('ANTHROPIC_API_KEY')!;

const SYSTEM = `Tu es Coach Atlas, coach trail/ultra expert.

PROFIL NOAH (données Strava vérifiées) :
- 19 mois de pratique (oct. 2024 → mai 2026)
- Moyenne réelle : 50,7 km/sem | 1 357 m D+/sem
- 4 dernières semaines : 69,8 km / 1 695 m D+ (en hausse)
- Meilleure perf : 67 km / 2 757 m D+ (Ultra Lac du Paladru, avr. 2026)
- UTMB Andorre : 12 juin 2026 — 79 km / 3 900 m D+ — J-26
- Phase actuelle : TAPER — fraîcheur prioritaire
- Projet futur : Lyon→Nice ~500 km

Semaines = lundi→dimanche (toujours).

Quand tu reçois un ressenti post-sortie, génère un encouragement COURT (max 120 mots) :
- Personnalisé selon les réponses (fatigué → récupération et J-26 ; au top → capitalise)
- 1 conseil séance suivante : type (EF/TEMPO/VMA/CAP/RÉCUP) + durée + D+ si pertinent + nutrition clé en 1 ligne
- Phrase de motivation ancrée sur l'objectif réel (79 km / 3 900 m D+)
- Ton direct, chaleureux, jamais de chiffres inventés
- Emojis OK, texte brut uniquement`;

async function tgSend(text: string, extra: Record<string, unknown> = {}) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, ...extra }),
  });
}

async function tgAnswer(callbackQueryId: string) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

const USER_ID = 'u_6vb0si3amp8sxkkw';
const TG_SESSION_ID = 'telegram_main';

async function sbGet(path: string) {
  const r = await fetch(`${SB_URL}/rest/v1${path}`, {
    headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` },
  });
  return r.json();
}

// Charge l'historique unifié (web + telegram) pour le contexte Claude
async function loadFullHistory(): Promise<{role:string, content:string}[]> {
  try {
    const rows = await sbGet(
      `/coach_sessions?user_id=eq.${USER_ID}&order=updated_at.desc&limit=5&select=messages,name`
    );
    const all: {role:string, content:string}[] = [];
    for (const row of (rows || [])) {
      const msgs = Array.isArray(row.messages) ? row.messages : [];
      all.push(...msgs.map((m: {role:string, content:string}) => ({
        role: m.role === 'coach' ? 'assistant' : 'user',
        content: m.content || '',
      })));
    }
    return all.slice(-20); // 20 derniers messages pour contexte
  } catch { return []; }
}

// Sauvegarde message dans la session Telegram unifiée
async function saveToSession(userMsg: string, coachReply: string) {
  try {
    const rows = await sbGet(
      `/coach_sessions?id=eq.${TG_SESSION_ID}&select=messages`
    );
    const existing = rows?.[0]?.messages || [];
    const updated = [
      ...existing,
      { role: 'user',  content: userMsg,    channel: 'telegram', ts: new Date().toISOString() },
      { role: 'coach', content: coachReply, channel: 'telegram', ts: new Date().toISOString() },
    ];
    await fetch(`${SB_URL}/rest/v1/coach_sessions`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        id: TG_SESSION_ID,
        user_id: USER_ID,
        name: '📱 Telegram',
        goal: 'andorre',
        messages: updated,
        updated_at: new Date().toISOString(),
      }),
    });
  } catch(e) { console.error('saveToSession:', e); }
}

async function sbUpsert(table: string, data: Record<string, unknown>) {
  await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(data),
  });
}

async function claudeReply(userContent: string, extraContext = ''): Promise<string> {
  const history = await loadFullHistory();
  const messages = [
    ...history,
    { role: 'user', content: extraContext ? `${extraContext}\n\n${userContent}` : userContent },
  ];
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANT_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 400,
      system: SYSTEM,
      messages,
    }),
  });
  const d = await res.json();
  return d.content?.[0]?.text || 'Continue comme ça Noah ! 💪';
}

// Envoie les 3 questions après une activité
export async function sendPostActivityQuestions(activityName: string, stats: string) {
  // Sauvegarde le contexte de l'activité en cours
  await sbUpsert('telegram_state', {
    chat_id: TG_CHAT,
    state: 'waiting_q1',
    activity_name: activityName,
    activity_stats: stats,
    answers: {},
    updated_at: new Date().toISOString(),
  });

  await tgSend(
    `💬 Quelques questions sur ta sortie "${activityName}" :\n\nComment tu te sens globalement ?`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '💪 Au top', callback_data: 'q1_top' },
          { text: '😊 Bien', callback_data: 'q1_bien' },
          { text: '😐 Moyen', callback_data: 'q1_moyen' },
          { text: '😓 Fatigué', callback_data: 'q1_fatigue' },
        ]],
      },
    }
  );
}

async function handleCallbackQuery(query: Record<string, unknown>) {
  const data = query.data as string;
  const queryId = query.id as string;
  await tgAnswer(queryId);

  // Charge l'état actuel
  const states = await sbGet(`/telegram_state?chat_id=eq.${TG_CHAT}&select=*`);
  const st = states?.[0];
  if (!st) return;

  const answers = st.answers || {};

  if (data.startsWith('q1_')) {
    const labels: Record<string, string> = { q1_top: 'Au top 💪', q1_bien: 'Bien 😊', q1_moyen: 'Moyen 😐', q1_fatigue: 'Fatigué 😓' };
    answers.ressenti = labels[data];
    await sbUpsert('telegram_state', { chat_id: TG_CHAT, state: 'waiting_q2', answers, updated_at: new Date().toISOString() });

    await tgSend('Et tes jambes / corps ?', {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Légères', callback_data: 'q2_legeres' },
          { text: '🦵 Lourdes', callback_data: 'q2_lourdes' },
          { text: '⚠️ Gêne/douleur', callback_data: 'q2_douleur' },
        ]],
      },
    });

  } else if (data.startsWith('q2_')) {
    const labels: Record<string, string> = { q2_legeres: 'Légères ✅', q2_lourdes: 'Lourdes 🦵', q2_douleur: 'Gêne/douleur ⚠️' };
    answers.corps = labels[data];
    await sbUpsert('telegram_state', { chat_id: TG_CHAT, state: 'waiting_q3', answers, updated_at: new Date().toISOString() });

    await tgSend('Mental pendant l\'effort ?', {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔥 En feu', callback_data: 'q3_feu' },
          { text: '👍 Solide', callback_data: 'q3_solide' },
          { text: '😶 Neutre', callback_data: 'q3_neutre' },
          { text: '😔 Dur', callback_data: 'q3_dur' },
        ]],
      },
    });

  } else if (data.startsWith('q3_')) {
    const labels: Record<string, string> = { q3_feu: 'En feu 🔥', q3_solide: 'Solide 👍', q3_neutre: 'Neutre 😶', q3_dur: 'Dur 😔' };
    answers.mental = labels[data];
    await sbUpsert('telegram_state', { chat_id: TG_CHAT, state: 'done', answers, updated_at: new Date().toISOString() });

    // Sauvegarde permanent dans training_ressentis
    await fetch(`${SB_URL}/rest/v1/training_ressentis`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        user_id: 'u_6vb0si3amp8sxkkw',
        activity_name: st.activity_name,
        activity_stats: st.activity_stats,
        ressenti: answers.ressenti,
        corps: answers.corps,
        mental: answers.mental,
      }),
    });

    // Génère l'encouragement
    const context = `Sortie : ${st.activity_name}
Stats : ${st.activity_stats}
Ressenti global : ${answers.ressenti}
Corps/jambes : ${answers.corps}
Mental : ${answers.mental}
Génère un message d'encouragement personnalisé.`;

    await tgSend('⏳ Coach Atlas analyse ton ressenti…');
    const encouragement = await claudeReply('Génère un message d\'encouragement personnalisé.', context);
    await tgSend(encouragement);
    // Sauvegarde dans l'historique unifié
    const summary = `[Post-sortie ${st.activity_name}] Ressenti: ${answers.ressenti} | Corps: ${answers.corps} | Mental: ${answers.mental}`;
    await saveToSession(summary, encouragement);
  }
}

async function handleTextMessage(text: string) {
  const reply = await claudeReply(text);
  await tgSend(reply);
  await saveToSession(text, reply);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const update = await req.json();
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    } else if (update.message?.text && update.message.chat.id.toString() === TG_CHAT) {
      await handleTextMessage(update.message.text);
    }
  } catch(e) { console.error(e); }
  return new Response('ok', { headers: CORS });
});
