import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const userId = url.searchParams.get('state');

    if (!code || !userId) {
      return new Response(
        JSON.stringify({ error: 'Missing code or state parameter' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
      );
    }

    // Exchange code for tokens
    const tokenResponse = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 247715,
        client_secret: Deno.env.get('STRAVA_CLIENT_SECRET'),
        code,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('Strava token exchange failed:', errorText);
      return new Response(
        JSON.stringify({ error: 'Failed to exchange code with Strava' }),
        { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
      );
    }

    const tokenData = await tokenResponse.json();
    const { access_token, refresh_token, expires_at, athlete } = tokenData;

    // Save tokens to Supabase
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { error: upsertError } = await supabase
      .from('strava_tokens')
      .upsert(
        {
          user_id: userId,
          athlete_id: athlete.id,
          access_token,
          refresh_token,
          expires_at,
          athlete_name: `${athlete.firstname} ${athlete.lastname}`.trim(),
          athlete_avatar: athlete.profile_medium ?? athlete.profile ?? null,
        },
        { onConflict: 'user_id' },
      );

    if (upsertError) {
      console.error('Supabase upsert error:', upsertError);
      return new Response(
        JSON.stringify({ error: 'Failed to save tokens' }),
        { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
      );
    }

    // Redirect to app
    return new Response(null, {
      status: 302,
      headers: {
        ...CORS_HEADERS,
        Location: 'https://icaste-icaste.github.io/coach-atlas/?strava=connected',
      },
    });
  } catch (err) {
    console.error('Unexpected error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
    );
  }
});
