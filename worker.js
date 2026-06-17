// ─────────────────────────────────────────────────────────
// wc2026-proxy — Cloudflare Worker
// football-data.org'u CORS ile sarar.
//
// KURULUM:
// 1) Worker'ının "Edit Code" ekranına gir, mevcut kodun tamamını sil,
//    bu dosyanın tamamını yapıştır.
// 2) Settings → Variables and Secrets → FOOTBALL_DATA_TOKEN zaten tanımlıysa
//    dokunma. Yoksa: 853b8809676e4a30bf6268cc17da7d6f değerini ekle.
// 3) Deploy.
//
// NOT: caches.default (Cache API) workers.dev alt alan adlarında ÇALIŞMIYOR —
// önceki sürümde bu vardı ve worker'ı çökertip CORS'suz bir hata sayfası
// döndürüyordu (tarayıcıda "NetworkError" olarak görünen şey buydu). Bu
// sürümde kaldırıldı. Cache-Control header'ı ziyaretçinin kendi tarayıcı
// cache'i için hâlâ işe yarıyor; paylaşımlı/edge cache istersen Workers KV
// eklemek gerekir (custom domain şart değil, ama ekstra kurulum ister).
// ─────────────────────────────────────────────────────────

const UPSTREAM = 'https://api.football-data.org/v4';
const ALLOWED_PREFIXES = ['/competitions/WC/matches', '/competitions/WC'];
const CACHE_SECONDS = 60; // football-data.org free tier: 10 istek/dk

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // Güvenlik: sadece beklenen path'lere izin ver
    const path = url.pathname;
    const isAllowed = ALLOWED_PREFIXES.some(p => path === p || path.startsWith(p + '?') || path.startsWith(p + '/'));
    if (!isAllowed) {
      return new Response(JSON.stringify({ error: 'Bu path için izin yok', path }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    if (!env.FOOTBALL_DATA_TOKEN) {
      return new Response(JSON.stringify({ error: 'FOOTBALL_DATA_TOKEN tanımlı değil (Settings → Variables and Secrets)' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    try {
      const target = `${UPSTREAM}${path}${url.search}`;
      const upstream = await fetch(target, {
        headers: { 'X-Auth-Token': env.FOOTBALL_DATA_TOKEN }
      });

      const body = await upstream.text();
      return new Response(body, {
        status: upstream.status,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
          ...corsHeaders()
        }
      });
    } catch (err) {
      // Ne olursa olsun CORS header'lı bir cevap dön — aksi halde tarayıcı
      // bunu yine belirsiz bir "NetworkError" olarak gösterir.
      return new Response(JSON.stringify({ error: 'Upstream istek başarısız', detail: String(err) }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
