// Vérification de l'identité (Google) et de l'accès payant (Stripe).
// Variables d'environnement Netlify à définir :
//   GOOGLE_CLIENT_ID   — l'ID client OAuth Google (le même que dans CONFIG.googleClientId)
//   STRIPE_SECRET_KEY  — clé secrète Stripe (idéalement une clé restreinte : Checkout Sessions = lecture)
//   SESSION_SECRET     — longue chaîne aléatoire (32+ caractères) pour signer les sessions
// Optionnelles :
//   FREE_ACCESS_EMAILS — emails séparés par des virgules qui ont l'accès sans payer (toi, testeurs)
//   STRIPE_PAYMENT_LINK_ID — id du Payment Link (plink_...) pour ne compter que les paiements de cette offre

const crypto = require("crypto");

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 jours
const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";

const json = (statusCode, obj) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(obj),
});

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => Buffer.from(s, "base64url");

/* ---------- Google ID token (RS256) ---------- */
let certsCache = { keys: null, at: 0 };
async function getGoogleKeys() {
  if (certsCache.keys && Date.now() - certsCache.at < 3600 * 1000) return certsCache.keys;
  const r = await fetch(GOOGLE_CERTS_URL);
  if (!r.ok) throw new Error("google_certs_unavailable");
  const data = await r.json();
  certsCache = { keys: data.keys || [], at: Date.now() };
  return certsCache.keys;
}

async function verifyGoogleCredential(credential, opts = {}) {
  try {
    const clientId = opts.clientId || process.env.GOOGLE_CLIENT_ID;
    if (!clientId || typeof credential !== "string") return null;
    const parts = credential.split(".");
    if (parts.length !== 3) return null;
    const header = JSON.parse(fromB64u(parts[0]).toString());
    const payload = JSON.parse(fromB64u(parts[1]).toString());
    if (header.alg !== "RS256") return null;
    const keys = opts.keys || (await getGoogleKeys());
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
    const ok = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), publicKey, fromB64u(parts[2]));
    if (!ok) return null;
    const now = Math.floor(Date.now() / 1000);
    if (payload.aud !== clientId) return null;
    if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") return null;
    if (!payload.exp || payload.exp < now) return null;
    if (!payload.email || payload.email_verified !== true) return null;
    return {
      sub: String(payload.sub),
      email: String(payload.email).toLowerCase(),
      name: payload.name || "",
      picture: payload.picture || "",
    };
  } catch (e) {
    return null;
  }
}

/* ---------- Session Arisebet (HMAC) ---------- */
function signSession(user, secret = process.env.SESSION_SECRET) {
  const exp = Date.now() + SESSION_TTL_MS;
  const body = b64u(JSON.stringify({ sub: user.sub, email: user.email, name: user.name, picture: user.picture, exp }));
  const sig = b64u(crypto.createHmac("sha256", secret).update(body).digest());
  return { token: body + "." + sig, exp };
}

function verifySession(token, secret = process.env.SESSION_SECRET) {
  try {
    if (!secret || typeof token !== "string") return null;
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;
    const expected = crypto.createHmac("sha256", secret).update(body).digest();
    const given = fromB64u(sig);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const p = JSON.parse(fromB64u(body).toString());
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch (e) {
    return null;
  }
}

/* ---------- Paiement (Stripe) ---------- */
const paidCache = new Map(); // email -> timestamp du dernier "payé" vérifié
async function isPaid(email) {
  email = String(email || "").toLowerCase();
  const free = (process.env.FREE_ACCESS_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (free.includes(email)) return true;

  const hit = paidCache.get(email);
  if (hit && Date.now() - hit < 5 * 60 * 1000) return true;

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("stripe_not_configured");
  const url = new URL("https://api.stripe.com/v1/checkout/sessions");
  url.searchParams.set("limit", "100");
  url.searchParams.set("customer_details[email]", email);
  if (process.env.STRIPE_PAYMENT_LINK_ID) url.searchParams.set("payment_link", process.env.STRIPE_PAYMENT_LINK_ID);
  const r = await fetch(url, { headers: { Authorization: "Bearer " + key } });
  if (!r.ok) throw new Error("stripe_unavailable");
  const data = await r.json();
  const paid = (data.data || []).some((s) => s.payment_status === "paid");
  if (paid) paidCache.set(email, Date.now());
  return paid;
}

/* ---------- Helper pour les autres fonctions (ex. ai-analyze.js) ---------- */
function bearer(event) {
  const h = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

// Retourne { ok:true, user } ou { ok:false, response } (à renvoyer tel quel).
async function requirePaid(event) {
  const user = verifySession(bearer(event));
  if (!user) return { ok: false, response: json(401, { error: "invalid_session" }) };
  try {
    if (!(await isPaid(user.email))) return { ok: false, response: json(402, { error: "not_subscribed" }) };
  } catch (e) {
    return { ok: false, response: json(502, { error: "payment_check_unavailable" }) };
  }
  return { ok: true, user };
}

module.exports = { json, bearer, verifyGoogleCredential, signSession, verifySession, isPaid, requirePaid };
