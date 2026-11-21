// /.netlify/functions/ai-deep : la GROSSE analyse d'un match (jusqu'à 10 recherches web, plusieurs minutes).
//   POST { match }  → lance l'analyse en arrière-plan (ai-deep-run), renvoie { status }
//   GET ?id=…       → { status: "running"|"done"|"error"|"none", progress: [...], result? }
// Réservé aux membres. Variables : ANTHROPIC_API_KEY, SESSION_SECRET, STRIPE_SECRET_KEY (déjà en place),
// AI_DEEP_DAILY_LIMIT (défaut 6 par membre et par jour).
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";
import access from "./lib/access.js";

const { verifySession, isPaid } = access;
const FRESH_MS = 3 * 3600e3;

async function member(req) {
  const auth = req.headers.get("authorization") || "";
  const user = verifySession(auth.startsWith("Bearer ") ? auth.slice(7) : "");
  if (!user) return { error: Response.json({ error: "invalid_session" }, { status: 401 }) };
  try { if (!(await isPaid(user.email))) return { error: Response.json({ error: "not_subscribed" }, { status: 402 }) }; }
  catch (e) { return { error: Response.json({ error: "payment_check_unavailable" }, { status: 502 }) }; }
  return { user };
}
const cleanId = (x) => String(x || "").replace(/[^\w-]/g, "").slice(0, 64);

export default async (req) => {
  const m = await member(req); if (m.error) return m.error;
  const st = getStore("arisebet-ai");

  if (req.method === "GET") {
    const id = cleanId(new URL(req.url).searchParams.get("id")); if (!id) return Response.json({ error: "bad_request" }, { status: 400 });
    const done = await st.get(`deep/${id}`, { type: "json" }).catch(() => null);
    if (done && Date.now() - done.ts < FRESH_MS) return Response.json({ status: "done", result: done }, { headers: { "cache-control": "no-store" } });
    const job = await st.get(`deepjob/${id}`, { type: "json" }).catch(() => null);
    if (!job) return Response.json({ status: "none" });
    if (job.status === "running" && Date.now() - job.started > 12 * 60e3) job.status = "error";
    return Response.json({ status: job.status, progress: job.progress || [], error: job.error || null }, { headers: { "cache-control": "no-store" } });
  }

  if (req.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  if (!process.env.ANTHROPIC_API_KEY) return Response.json({ error: "ai_not_configured" }, { status: 500 });
  let body = {}; try { body = await req.json(); } catch (e) {}
  const match = body.match; const id = cleanId(match && match.id);
  if (!id || !match.home || !match.away || !match.fair) return Response.json({ error: "bad_request" }, { status: 400 });

  const done = await st.get(`deep/${id}`, { type: "json" }).catch(() => null);
  if (done && Date.now() - done.ts < FRESH_MS && !body.force) return Response.json({ status: "done" });
  const job = await st.get(`deepjob/${id}`, { type: "json" }).catch(() => null);
  if (job && job.status === "running" && Date.now() - job.started < 6 * 60e3) return Response.json({ status: "running" });

  // quota par membre et par jour (souple : pas de verrou, suffisant pour limiter les coûts)
  const day = new Date().toISOString().slice(0, 10), qk = `quota/deep/${m.user.sub || m.user.email}/${day}`;
  const limit = Number(process.env.AI_DEEP_DAILY_LIMIT || 6), used = Number((await st.get(qk).catch(() => 0)) || 0);
  if (used >= limit) return Response.json({ error: "daily_limit", limit }, { status: 429 });
  await st.set(qk, String(used + 1));

  await st.setJSON(`deepjob/${id}`, { status: "running", started: Date.now(), progress: ["Préparation de l'analyse"] });
  const payload = JSON.stringify({ match: { ...match, id } });
  const sig = crypto.createHmac("sha256", process.env.SESSION_SECRET || "").update(payload).digest("hex");
  const base = process.env.URL || new URL(req.url).origin;
  const r = await fetch(`${base}/.netlify/functions/ai-deep-run`, { method: "POST", headers: { "content-type": "application/json", "x-arisebet-sig": sig }, body: payload }).catch(() => null);
  if (!r || (r.status !== 202 && !r.ok)) {
    await st.setJSON(`deepjob/${id}`, { status: "error", started: Date.now(), error: "start_failed" });
    return Response.json({ error: "start_failed" }, { status: 502 });
  }
  return Response.json({ status: "running", left: limit - used - 1 });
};
