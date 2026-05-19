const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

async function sbFetch(path: string, opts: RequestInit = {}) {
  return fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...((opts.headers as Record<string,string>) || {}),
    },
  });
}

async function refreshIfNeeded(token: Record<string,unknown>) {
  if ((token.expires_at as number) >= Math.floor(Date.now() / 1000) + 300) return token;
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
  await sbFetch(`/strava_tokens?athlete_id=eq.${token.athlete_id}`, {
    method: 'PATCH',
    body: JSON.stringify({ access_token: fresh.access_token, refresh_token: fresh.refresh_token, expires_at: fresh.expires_at, updated_at: new Date().toISOString() }),
  });
  return { ...token, access_token: fresh.access_token };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { user_id } = await req.json();
    if (!user_id) throw new Error('user_id requis');

    const tr = await sbFetch(`/strava_tokens?user_id=eq.${user_id}&select=*`);
    const tokens = await tr.json();
    if (!tokens?.length) throw new Error('Strava non connecté');
    const token = await refreshIfNeeded(tokens[0]);

    // Fetch toutes les activités paginées
    let page = 1;
    const allActivities: unknown[] = [];
    while (true) {
      const res = await fetch(
        `https://www.strava.com/api/v3/athlete/activities?per_page=200&page=${page}`,
        { headers: { 'Authorization': `Bearer ${token.access_token}` } }
      );
      const acts = await res.json();
      if (!Array.isArray(acts) || acts.length === 0) break;
      allActivities.push(...acts);
      page++;
      if (acts.length < 200) break;
    }

    // Transforme
    const rows = allActivities.map((act: unknown) => {
      const a = act as Record<string, unknown>;
      const distKm = +((a.distance as number) / 1000).toFixed(2);
      const avgPace = distKm > 0 ? +((a.moving_time as number) / distKm).toFixed(2) : null;
      return {
        id: `${user_id}_${a.id}`,
        user_id,
        strava_id: a.id,
        name: a.name,
        type: a.type,
        distance_km: distKm,
        elevation_m: +((a.total_elevation_gain as number) || 0).toFixed(1),
        duration_s: a.moving_time,
        avg_pace: avgPace,
        avg_hr: a.average_heartrate ? Math.round(a.average_heartrate as number) : null,
        max_hr: a.max_heartrate ? Math.round(a.max_heartrate as number) : null,
        calories: a.calories || null,
        start_date: a.start_date,
        raw_json: a,
      };
    });

    // Upsert par batch de 50
    for (let i = 0; i < rows.length; i += 50) {
      await sbFetch('/strava_activities', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' } as Record<string,string>,
        body: JSON.stringify(rows.slice(i, i + 50)),
      });
    }

    return new Response(JSON.stringify({ success: true, total: rows.length }), {
      headers: { ...CORS, 'content-type': 'application/json' },
    });

  } catch(e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...CORS, 'content-type': 'application/json' },
    });
  }
});
