// ─────────────────────────────────────────────────────────
// wc2026-proxy — Cloudflare Worker
// football-data.org'u CORS + cache ile sarar.
//
// KURULUM:
// 1) https://dash.cloudflare.com → Workers & Pages → Create → "Hello World" Worker
// 2) Bu dosyanın tamamını editördeki kodun üzerine yapıştır
// 3) Settings → Variables → Add variable:
//      FOOTBALL_DATA_TOKEN = 853b8809676e4a30bf6268cc17da7d6f
//    (Encrypt'i işaretle, böylece kimse panelden bile okuyamaz)
// 4) Deploy'a bas. Sana "https://wc2026-proxy.SENINKULLANICIADIN.workers.dev"
//    gibi bir URL verecek — bunu wc2026.html içindeki API_BASE'e yapıştır.
// ─────────────────────────────────────────────────────────

const UPSTREAM = 'https://api.football-data.org/v4';
const ALLOWED_PREFIXES = ['/competitions/WC/matches', '/competitions/WC'];
const CACHE_SECONDS = 60; // football-data.org free tier: 10 istek/dk — bu önbellek o limiti korur

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // Güvenlik: sadece beklenen path'lere izin ver, proxy'yi açık vekil olarak kullanmayı engelle
    const path = url.pathname;
    const isAllowed = ALLOWED_PREFIXES.some(p => path === p || path.startsWith(p + '?') || path.startsWith(p + '/'));
    if (!isAllowed) {
      return new Response(JSON.stringify({ error: 'Bu path için izin yok' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    let response = await cache.match(cacheKey);
    if (response) return response;

    const target = `${UPSTREAM}${path}${url.search}`;
    const upstream = await fetch(target, {
      headers: { 'X-Auth-Token': env.FOOTBALL_DATA_TOKEN }
    });

    const body = await upstream.text();
    response = new Response(body, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
        ...corsHeaders()
      }
    });

    if (upstream.ok) {
      // Cloudflare edge cache'ine de yaz (sınırlı CPU süresini aşmadan arka planda)
      await cache.put(cacheKey, response.clone());
    }
    return response;
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
