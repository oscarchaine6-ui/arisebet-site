// POST /.netlify/functions/account — connexion par e-mail et mot de passe (en plus de Google).
//   { action: "signup", email, password, name }  → crée le compte
//   { action: "login",  email, password }        → se connecte
// Renvoie la même session que auth.js (token signé, paiement Stripe vérifié sur l'e-mail).
// Les mots de passe sont hachés (scrypt + sel), jamais stockés en clair. Comptes dans Netlify Blobs.
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";
import access from "./lib/access.js";

const { signSession, isPaid, isFounder } = access;
const tries = new Map(); // anti force brute simple : 8 essais / 15 min par IP + e-mail

const hashPw = (pw, salt) => new Promise((ok, ko) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? ko(e) : ok(k.toString("hex")))));
const keyOf = (email) => "u/" + crypto.createHash("sha256").update(email).digest("hex");
const bad = (status, error) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

export default async (req, context) => {
  if (req.method !== "POST") return bad(405, "method_not_allowed");
  if (!process.env.SESSION_SECRET) return bad(500, "server_not_configured");
  let b = {}; try { b = await req.json(); } catch (e) {}
  const email = String(b.email || "").trim().toLowerCase();
  const password = String(b.password || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) return bad(400, "bad_email");
  if (password.length < 8 || password.length > 200) return bad(400, "bad_password");

  const ip = (context && context.ip) || req.headers.get("x-nf-client-connection-ip") || "?";
  const tk = ip + "|" + email, now = Date.now(), t = (tries.get(tk) || []).filter((x) => now - x < 15 * 60e3);
  if (t.length >= 8) return bad(429, "too_many_attempts");

  const st = getStore("arisebet-users");
  const key = keyOf(email);
  let user = await st.get(key, { type: "json" }).catch(() => null);

  if (b.action === "signup") {
    if (user) return bad(409, "email_taken");
    // Personne ne peut créer un compte e-mail avec l'adresse du fondateur (il se connecte avec Google).
    if (isFounder(email)) return bad(403, "founder_use_google");
    const salt = crypto.randomBytes(16).toString("hex");
    const name = String(b.name || "").trim().slice(0, 60) || email.split("@")[0];
    user = { email, name, salt, hash: await hashPw(password, salt), created: now };
    const { modified } = await st.setJSON(key, user, { onlyIfNew: true });
    if (!modified) return bad(409, "email_taken");
  } else if (b.action === "login") {
    if (!user) { t.push(now); tries.set(tk, t); return bad(401, "invalid_credentials"); }
    const h = await hashPw(password, user.salt);
    if (!crypto.timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(user.hash, "hex"))) { t.push(now); tries.set(tk, t); return bad(401, "invalid_credentials"); }
  } else return bad(400, "bad_action");

  tries.delete(tk);
  let paid = false;
  try { paid = await isPaid(email); } catch (e) { paid = false; }
  const sess = { sub: "email:" + key.slice(2, 22), email, name: user.name, picture: "" };
  const { token, exp } = signSession(sess);
  return Response.json({ token, exp, paid, email, name: user.name, picture: "", sub: sess.sub }, { headers: { "cache-control": "no-store" } });
};
