// GET /.netlify/functions/odds?p=sports|odds|event|scores&sport=...&event=...
// Va chercher les cotes The Odds API avec TA clé (variable ODDS_API_KEY) et les met en cache
// pour TOUS les clients : un client qui ouvre la Ligue 1 juste après un autre ne coûte rien.
// Tes clients n'ont donc plus besoin de leur propre clé.
//
// Variables d'environnement Netlify (scope Functions) :
//   ODDS_API_KEY      — obligatoire, ta clé the-odds-api.com
//   ODDS_CACHE_MIN    — durée du cache des cotes en minutes (défaut 10)
//   SESSION_SECRET    — déjà utilisée par auth.js (il faut être connecté avec Google)
import access from "./lib/access.js";
import { consensus } from "./lib/market.mjs";

const { verifySession, isPaid } = access;
const BASE = "https://api.the-odds-api.com/v4";

async function blobStore() {
  try { const { getStore } = await import("@netlify/blobs"); return getStore("arisebet-odds"); } catch (e) { return null; }
}
const mem = new Map();

// Garde la cote d'ouverture (première cote vue) de chaque match pour repérer les mouvements de marché.
async function withOpening(store, sport, body, now) {
  let events; try { events = JSON.parse(body); } catch (e) { return body; }
  if (!Array.isArray(events)) return body;
  const k = `open/${sport}`;
  let map = {}; try { map = (store ? await store.get(k, { type: "json" }) : mem.get(k)) || {}; } catch (e) {}
  const ids = new Set();
  events.forEach((ev) => {
    ids.add(ev.id);
    const c = consensus(ev); if (!c) return;
    if (!map[ev.id]) map[ev.id] = { ts: now, ...c.avg, pA: c.p.A, pN: c.p.N, pB: c.p.B };
    ev._open = map[ev.id];
  });
  for (const id of Object.keys(map)) if (!ids.has(id) && now - map[id].ts > 4 * 86400e3) delete map[id];
  try { if (store) await store.setJSON(k, map); else mem.set(k, map); } catch (e) {}
  return JSON.stringify(events);
}

export default async (req) => {
  const key = process.env.ODDS_API_KEY;
  if (!key) return Response.json({ error: "odds_not_configured" }, { status: 500 });
  const auth = req.headers.get("authorization") || "";
  const user = verifySession(auth.startsWith("Bearer ") ? auth.slice(7) : "");
  if (!user) return Response.json({ error: "invalid_session" }, { status: 401 });

  const u = new URL(req.url);
  const p = u.searchParams.get("p");
  const sport = u.searchParams.get("sport") || "";
  const event = u.searchParams.get("event") || "";
  if (sport && !/^[a-z0-9_]{2,60}$/.test(sport)) return Response.json({ error: "bad_sport" }, { status: 400 });
  if (event && !/^[a-zA-Z0-9]{6,64}$/.test(event)) return Response.json({ error: "bad_event" }, { status: 400 });

  const ttlOdds = Math.max(2, Number(process.env.ODDS_CACHE_MIN || 10)) * 60e3;
  let path, params, ttl, cacheKey;
  if (p === "sports") { path = "/sports/"; params = {}; ttl = 6 * 3600e3; cacheKey = "sports"; }
  else if (p === "odds" && sport) { path = `/sports/${sport}/odds/`; params = { regions: "eu", markets: "h2h", oddsFormat: "decimal", dateFormat: "iso" }; ttl = ttlOdds; cacheKey = `odds/${sport}`; }
  else if (p === "event" && sport && event) {
    // marchés plus/moins et handicaps : réservés aux membres (ils coûtent 2 requêtes)
    try { if (!(await isPaid(user.email))) return Response.json({ error: "not_subscribed" }, { status: 402 }); } catch (e) { return Response.json({ error: "payment_check_unavailable" }, { status: 502 }); }
    path = `/sports/${sport}/events/${event}/odds/`; params = { regions: "eu", markets: "totals,spreads", oddsFormat: "decimal", dateFormat: "iso" }; ttl = 15 * 60e3; cacheKey = `event/${event}`;
  }
  else if (p === "scores" && sport) { path = `/sports/${sport}/scores/`; params = { daysFrom: "3", dateFormat: "iso" }; ttl = 3 * 60e3; cacheKey = `scores/${sport}`; }
  else return Response.json({ error: "bad_request" }, { status: 400 });

  const store = await blobStore();
  const now = Date.now();
  let hit = null;
  try { hit = store ? await store.get(cacheKey, { type: "json" }) : mem.get(cacheKey); } catch (e) {}
  if (hit && now - hit.ts < ttl) {
    return new Response(hit.body, { headers: { "content-type": "application/json", "x-cache": "hit", "x-age": String(Math.round((now - hit.ts) / 1000)), "x-requests-remaining": String(hit.left ?? "") } });
  }

  const qs = new URLSearchParams({ ...params, apiKey: key });
  let r;
  try { r = await fetch(`${BASE}${path}?${qs}`); } catch (e) { r = null; }
  if (!r || !r.ok) {
    // si l'API ne répond pas, on renvoie la dernière version connue plutôt que rien
    if (hit) return new Response(hit.body, { headers: { "content-type": "application/json", "x-cache": "stale", "x-requests-remaining": String(hit.left ?? "") } });
    const status = r ? r.status : 502;
    return Response.json({ error: status === 401 ? "server_key_invalid" : status === 429 ? "server_quota" : status === 404 ? "not_found" : "upstream_error" }, { status: status === 404 ? 404 : 502 });
  }
  let body = await r.text();
  const left = r.headers.get("x-requests-remaining");
  if (p === "odds") body = await withOpening(store, sport, body, now);
  const rec = { ts: now, body, left };
  try { if (store) await store.setJSON(cacheKey, rec); else mem.set(cacheKey, rec); } catch (e) {}
  return new Response(body, { headers: { "content-type": "application/json", "x-cache": "miss", "x-requests-remaining": String(left ?? "") } });
};
