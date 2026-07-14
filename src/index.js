/**
 * Cloudflare Worker — PluginHub
 *   1) "Çalışmıyor Bildir" -> Telegram proxy   (mevcut, path: "/" veya "/report")
 *   2) Film notları (Dolby Atmos listesi)       (yeni,   path: "/notes")
 *
 * KURULUM (Telegram kısmı için, değişmedi):
 * 1. https://dash.cloudflare.com -> Workers & Pages -> Create -> Worker
 * 2. Bu kodu yapıştır, Deploy et
 * 3. Worker ayarlarında (Settings -> Variables and Secrets) şu SECRET'ları ekle:
 *      TELEGRAM_BOT_TOKEN = <BotFather'dan aldığın token>
 *      TELEGRAM_CHAT_ID   = <bildirimlerin gideceği grup/DM id'si>
 * 4. wrangler.toml içinde NOTES_KV binding'i olmalı (KV namespace):
 *      [[kv_namespaces]]
 *      binding = "NOTES_KV"
 *      id = "71df456dcbf942d98ee2ff0d7111f94b"
 *
 * GÜVENLİK:
 * - ALLOWED_ORIGIN değerini kendi sitenin adresine göre ayarla (CORS koruması için)
 * - Report endpoint'inde basit bir rate-limit var (aynı IP'den dakikada 5 istek)
 */

const ALLOWED_ORIGIN = "https://tcl-iffalcon.github.io"; // kendi domainin ile değiştir

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight (her iki route için ortak)
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ── ROUTE: /notes (film notları) ─────────────────────────
    if (url.pathname === "/notes") {
      return handleNotes(request, env, url);
    }

    // ── ROUTE: her şey diğer -> "Çalışmıyor Bildir" (Telegram) ──
    return handleReport(request, env);
  },
};

async function handleNotes(request, env, url) {
  if (request.method === "GET") {
    const movie = url.searchParams.get("movie");
    if (!movie) return json({ error: "movie parametresi gerekli" }, 400);
    const notes = await getNotes(env, movie);
    return json({ notes });
  }

  if (request.method === "POST") {
    const body = await safeJson(request);
    const movieKey = body?.movie;
    const text = (body?.text || "").toString().trim().slice(0, 300);

    if (!movieKey || !text) {
      return json({ error: "movie ve text gerekli" }, 400);
    }

    const notes = await getNotes(env, movieKey);
    notes.push({ text, ts: Date.now() });

    // Aşırı büyümesin diye son 200 notu tut
    const trimmed = notes.slice(-200);

    await env.NOTES_KV.put(kvKey(movieKey), JSON.stringify(trimmed));
    return json({ notes: trimmed });
  }

  return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
}

function kvKey(movie) {
  return `notes:${movie}`;
}

async function getNotes(env, movie) {
  const raw = await env.NOTES_KV.get(kvKey(movie));
  return raw ? JSON.parse(raw) : [];
}

async function handleReport(request, env) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (isRateLimited(ip)) {
    return json({ error: "rate_limited" }, 429);
  }

  const body = await safeJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  const { pluginName, app, type, action } = body;
  if (!pluginName || !app) {
    return json({ error: "missing_fields" }, 400);
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
    return json({ error: "telegram_failed", detail: errText }, 502);
  }

  return json({ ok: true });
}