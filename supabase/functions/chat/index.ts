const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-anthropic-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { messages, system } = await req.json();

    const apiKey = req.headers.get('x-anthropic-key');
    if (!apiKey) return new Response(JSON.stringify({ error: 'Missing API key' }), {
      status: 401, headers: { ...CORS, 'content-type': 'application/json' },
    });

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2048, system, messages }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || JSON.stringify(data));

    return new Response(JSON.stringify({ reply: data.content[0].text }), {
      headers: { ...CORS, 'content-type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...CORS, 'content-type': 'application/json' },
    });
  }
});
