// Supabase Edge Function: prune-waits
// Deploy with: supabase functions deploy prune-waits
// Then schedule via Supabase Dashboard > Integrations > Cron (weekly)

Deno.serve(async (_req: Request) => {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const cutoff = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/wait_times?recorded_at=lt.${cutoff}`,
    {
      method: 'DELETE',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer':        'return=minimal',
      },
    }
  );

  if (!res.ok) {
    const text = await res.text();
    console.error(`Prune failed: ${res.status} ${text}`);
    return new Response(JSON.stringify({ ok: false, error: text }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  console.log(`✓ Pruned rows older than ${cutoff}`);
  return new Response(JSON.stringify({ ok: true, cutoff }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
