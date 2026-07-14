/**
 * Cloudflare Worker — PluginHub "Çalışmıyor Bildir" -> Telegram proxy
 *
 * KURULUM:
 * 1. https://dash.cloudflare.com -> Workers & Pages -> Create -> Worker
 * 2. Bu kodu yapıştır, Deploy et
 * 3. Worker ayarlarında (Settings -> Variables and Secrets) şu SECRET'ları ekle:
 *      TELEGRAM_BOT_TOKEN = <BotFather'dan aldığın token>
 *      TELEGRAM_CHAT_ID   = <bildirimlerin gideceği grup/DM id'si>
 *    (Secret olarak eklersen kodun içinde token görünmez, dashboard'da da şifreli tutulur)
 * 4. Worker'ın URL'sini not al (örn: https://pluginhub-report.SENIN-SUBDOMAIN.workers.dev)
 * 5. Bu URL'yi site tarafındaki REPORT_ENDPOINT değişkenine yapıştır (aşağıdaki ikinci dosyaya bak)
 *
 * GÜVENLİK:
 * - ALLOWED_ORIGIN değerini kendi sitenin adresine göre ayarla (CORS koruması için)
 * - Basit bir rate-limit eklendi (aynı IP'den dakikada 5 istek); ciddi kötüye kullanım için
 *   Cloudflare'in kendi Rate Limiting Rules özelliğini de ekleyebilirsin (ücretsiz planda da var)
 */

const ALLOWED_ORIGIN = "https://tcl-iffalcon.github.io"; // kendi domainin ile değiştir

// Basit in-memory rate limit (worker instance ömrü boyunca; kalıcı değil ama spam'i frenler)
const rateMap = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60_000; // 1 dakika
  const limit = 5;
  const entry = rateMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > windowMs) {
    entry.count = 0;
    entry.start = now;
  }
  entry.count++;
  rateMap.set(ip, entry);
  return entry.count > limit;
}

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (isRateLimited(ip)) {
      return new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": ALLOWED_ORIGIN },
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": ALLOWED_ORIGIN },
      });
    }

    const { pluginName, app, type, action } = body || {};
    if (!pluginName || !app) {
      return new Response(JSON.stringify({ error: "missing_fields" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": ALLOWED_ORIGIN },
      });
    }

    const verb = action === "unreport" ? "Bildirim geri alındı" : "🚩 Çalışmıyor bildirimi";
    const text =
      `${verb}\n\n` +
      `📦 Eklenti: ${pluginName}\n` +
      `🔧 Uygulama: ${app}\n` +
      `🏷️ Tür: ${type || "-"}\n` +
      `🌐 IP: ${ip}\n` +
      `🕐 ${new Date().toISOString()}`;

    const tgUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const tgRes = await fetch(tgUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
      }),
    });

    if (!tgRes.ok) {
      const errText = await tgRes.text();
      return new Response(JSON.stringify({ error: "telegram_failed", detail: errText }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": ALLOWED_ORIGIN },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": ALLOWED_ORIGIN },
    });
  },
};