import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const WEBHOOK_VERIFY_TOKEN = 'COACH_ATLAS_WEBHOOK';

async function refreshStravaToken(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  refreshToken: string,
): Promise<string> {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: 247715,
      client_secret: Deno.env.get('STRAVA_CLIENT_SECRET'),
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    throw new Error(`Strava token refresh failed: ${await res.text()}`);
  }

  const data = await res.json();
  const { access_token, refresh_token: new_refresh_token, expires_at } = data;

  await supabase
    .from('strava_tokens')
    .update({ access_token, refresh_token: new_refresh_token, expires_at })
    .eq('user_id', userId);

  return access_token;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Webhook verification (GET)
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const challenge = url.searchParams.get('hub.challenge');
    const verifyToken = url.searchParams.get('hub.verify_token');

    if (verifyToken !== WEBHOOK_VERIFY_TOKEN || !challenge) {
      return new Response(
        JSON.stringify({ error: 'Invalid verify token' }),
        { status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({ 'hub.challenge': challenge }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
    );
  }

  // Webhook event (POST)
  if (req.method === 'POST') {
    // Respond 200 immediately as Strava requires a fast response
    const eventPromise = (async () => {
      try {
        const event = await req.json();

        if (event.aspect_type !== 'create' || event.object_type !== 'activity') {
          return;
        }

        const ownerId: number = event.owner_id;
        const activityId: number = event.object_id;

        const supabase = createClient(
          Deno.env.get('SUPABASE_URL')!,
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
        );

        // Fetch tokens for the athlete
        const { data: tokenRow, error: tokenError } = await supabase
          .from('strava_tokens')
          .select('user_id, access_token, refresh_token, expires_at')
          .eq('athlete_id', ownerId)
          .single();

        if (tokenError || !tokenRow) {
          console.error('No token found for athlete_id:', ownerId, tokenError);
          return;
        }

        let accessToken: string = tokenRow.access_token;
        const nowEpoch = Math.floor(Date.now() / 1000);

        if (tokenRow.expires_at <= nowEpoch) {
          accessToken = await refreshStravaToken(supabase, tokenRow.user_id, tokenRow.refresh_token);
        }

        // Fetch activity details
        const activityRes = await fetch(
          `https://www.strava.com/api/v3/activities/${activityId}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );

        if (!activityRes.ok) {
          console.error('Failed to fetch activity:', activityId, await activityRes.text());
          return;
        }

        const activity = await activityRes.json();

        const avgPace =
          activity.moving_time > 0 && activity.distance > 0
            ? activity.moving_time / (activity.distance / 1000) // seconds per km
            : null;

        const { error: insertError } = await supabase.from('strava_activities').upsert(
          {
            user_id: tokenRow.user_id,
            strava_id: activity.id,
            name: activity.name,
            type: activity.type,
            distance_km: activity.distance / 1000,
            elevation_m: activity.total_elevation_gain,
            duration_s: activity.moving_time,
            avg_pace: avgPace,
            avg_hr: activity.average_heartrate ?? null,
            max_hr: activity.max_heartrate ?? null,
            calories: activity.calories ?? null,
            start_date: activity.start_date,
            polyline: activity.map?.summary_polyline ?? null,
            raw_json: activity,
          },
          { onConflict: 'strava_id' },
        );

        if (insertError) {
          console.error('Failed to insert activity:', insertError);
        }
      } catch (err) {
        console.error('Webhook processing error:', err);
      }
    })();

    // Fire and forget — don't await
    void eventPromise;

    return new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
    );
  }

  return new Response(
    JSON.stringify({ error: 'Method not allowed' }),
    { status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
  );
});
