// Fonction en arrière-plan (jusqu'à 15 min), lancée par daily.mjs.
// 1. Vérifie les résultats des picks de l'IA et des combinés du jour (scores The Odds API).
// 2. Le matin, crée « le combiné Arisebet du jour » : les matchs les plus solides, vérifiés par l'IA sur le web.
// 3. Recalcule le bilan public (taux de réussite, ROI) lu par track.mjs.
//
// Variables : ODDS_API_KEY, ANTHROPIC_API_KEY, SESSION_SECRET (déjà en place)
// Optionnelles : DAILY_COMPS (compétitions séparées par des virgules), AI_MODEL
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";
import { consensus } from "./lib/market.mjs";

export const config = { background: true };

const ODDS = "https://api.the-odds-api.com/v4";
const DEFAULT_COMPS = "soccer_france_ligue_one,soccer_epl,soccer_spain_la_liga,soccer_italy_serie_a,soccer_germany_bundesliga,soccer_uefa_champs_league,basketball_nba,icehockey_nhl";
const parisDay = (d = new Date()) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
const label = (x, side) => (side === "N" ? "Match nul" : "Victoire " + (side === "A" ? x.home : x.away));

async function oddsGet(path, params) {
  const qs = new URLSearchParams({ ...params, apiKey: process.env.ODDS_API_KEY });
  const r = await fetch(`${ODDS}${path}?${qs}`);
  if (!r.ok) throw new Error("odds " + r.status);
  return r.json();
}

function winnerOf(ev) {
  if (!ev || !ev.completed || !Array.isArray(ev.scores)) return null;
  const h = Number((ev.scores.find((s) => s.name === ev.home_team) || {}).score);
  const a = Number((ev.scores.find((s) => s.name === ev.away_team) || {}).score);
  if (!isFinite(h) || !isFinite(a)) return null;
  return h > a ? "A" : h < a ? "B" : "N";
}

async function settle(st) {
  const { blobs } = await st.list({ prefix: "pick/" });
  const daily = (await st.list({ prefix: "daily/" })).blobs.map((b) => b.key).sort().slice(-5);
  const picks = [];
  for (const b of blobs) { const x = await st.get(b.key, { type: "json" }); if (x && x.status === "pending") picks.push([b.key, x]); }
  const combos = [];
  for (const k of daily) { const x = await st.get(k, { type: "json" }); if (x && ((x.status === "pending" && x.legs && x.legs.length) || (x.outsider && x.outsider.status === "pending"))) combos.push([k, x]); }
  const sports = new Set([...picks.map(([, x]) => x.sportKey), ...combos.flatMap(([, c]) => [...c.legs, ...(c.outsider ? [c.outsider] : [])].map((l) => l.sportKey))].filter(Boolean));
  const res = {};
  for (const sk of sports) {
    try { (await oddsGet(`/sports/${sk}/scores/`, { daysFrom: "3", dateFormat: "iso" })).forEach((ev) => { res[ev.id] = ev; }); } catch (e) { console.log("scores", sk, e.message); }
  }
  const now = Date.now();
  const judge = (x) => {
    const w = winnerOf(res[x.eventId]);
    if (w) return w === x.side ? "won" : "lost";
    const t = x.kickoff ? Date.parse(x.kickoff) : x.ts;
    return now - t > 4 * 86400e3 ? "void" : "pending";
  };
  for (const [k, x] of picks) { const s = judge(x); if (s !== "pending") { x.status = s; x.settledAt = now; await st.setJSON(k, x); } }
  for (const [k, c] of combos) {
    if (c.outsider && c.outsider.status === "pending") c.outsider.status = judge(c.outsider);
    if (c.legs.length && c.status === "pending") {
      c.legs.forEach((l) => { if (l.status === "pending" || !l.status) l.status = judge(l); });
      if (c.legs.some((l) => l.status === "lost")) c.status = "lost";
      else if (c.legs.every((l) => l.status === "won" || l.status === "void")) c.status = c.legs.every((l) => l.status === "void") ? "void" : "won";
    }
    await st.setJSON(k, c);
  }
}

async function generate(st, day) {
  const comps = (process.env.DAILY_COMPS || DEFAULT_COMPS).split(",").map((s) => s.trim()).filter(Boolean);
  const now = Date.now(), cands = [], dogs = [];
  for (const sk of comps) {
    let evs = [];
    try { evs = await oddsGet(`/sports/${sk}/odds/`, { regions: "eu", markets: "h2h", oddsFormat: "decimal", dateFormat: "iso" }); } catch (e) { continue; }
    for (const ev of evs) {
      const t = Date.parse(ev.commence_time); if (!(t > now + 3600e3 && t < now + 30 * 3600e3)) continue;
      const c = consensus(ev); if (!c || c.books < 3) continue;
      ["A", "B"].forEach((k) => { const bo = c.best[k]; if (!bo || bo.price < 2.1 || bo.price > 6.5) return; const ev2 = c.p[k] * bo.price - 1; if (ev2 > 0.02) dogs.push({ eventId: ev.id, sportKey: sk, competition: ev.sport_title, home: ev.home_team, away: ev.away_team, kickoff: ev.commence_time, side: k, proba: c.p[k], cote: bo.price, book: bo.book, ev: ev2 }); });
      const side = ["A", "B", "N"].filter((k) => c.p[k]).sort((x, y) => c.p[y] - c.p[x])[0];
      const b = c.best[side]; if (!b || c.p[side] < 0.62 || b.price < 1.25) continue;
      let uni = null;
      (ev.bookmakers || []).forEach((bk) => { if (/unibet/.test(bk.key)) { const o = ((bk.markets || [])[0] || {}).outcomes || []; const nm = side === "A" ? ev.home_team : side === "B" ? ev.away_team : "Draw"; const f = o.find((x) => x.name === nm); if (f) uni = f.price; } });
      cands.push({ eventId: ev.id, sportKey: sk, competition: ev.sport_title, home: ev.home_team, away: ev.away_team, kickoff: ev.commence_time, side, proba: c.p[side], cote: b.price, book: b.book, unibet: uni });
    }
  }
  cands.sort((x, y) => y.proba - x.proba);
  const top = cands.slice(0, 10);
  dogs.sort((x, y) => y.ev - x.ev);
  const topDogs = dogs.slice(0, 6);
  let chosen = null, resume = "", dog = null;
  if (top.length >= 2 && process.env.ANTHROPIC_API_KEY) {
    const dogList = topDogs.map((c, i) => `${i + 1}. [${c.eventId}] ${c.competition} · ${c.home} – ${c.away} · outsider ${label(c, c.side)} · proba sans marge ${(c.proba * 100).toFixed(1)} % · meilleure cote ${c.cote} (${c.book}) · value +${(c.ev * 100).toFixed(1)} %`).join("\n");
    const list = top.map((c, i) => `${i + 1}. [${c.eventId}] ${c.competition} · ${new Date(c.kickoff).toLocaleString("fr-FR", { timeZone: "Europe/Paris", weekday: "short", hour: "2-digit", minute: "2-digit" })} · ${c.home} – ${c.away} · pick ${label(c, c.side)} · proba sans marge ${(c.proba * 100).toFixed(1)} % · meilleure cote ${c.cote} (${c.book})${c.unibet ? " · Unibet " + c.unibet : ""}`).join("\n");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.AI_MODEL || "claude-sonnet-5-5", max_tokens: 2000,
        system: "Tu es l'analyste d'Arisebet. Tu composes le combiné du jour pour des clients qui veulent maximiser leurs chances de gagner. Réponds en français. Sois honnête : aucun gain n'est garanti.",
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6, user_location: { type: "approximate", country: "FR", timezone: "Europe/Paris" } }],
        messages: [{ role: "user", content: `Date : ${new Date().toLocaleDateString("fr-FR", { dateStyle: "full", timeZone: "Europe/Paris" })}.\nVoici les favoris les plus solides des prochaines 30 h (probabilités sans marge, cotes réelles) :\n${list}\n\nVérifie sur le web les candidats les mieux classés (blessures, rotation, gardien ou lanceur titulaire, enjeu, forme de la saison EN COURS). Écarte ceux qui ont un vrai doute. Garde 2 ou 3 jambes maximum, de préférence dans des matchs différents et pas toutes dans la même compétition. Si moins de 2 sont vraiment solides, n'en garde aucune.\n\nOUTSIDERS avec une value positive selon le marché :\n${dogList || "(aucun)"}\nChoisis au maximum UN « outsider du jour » qui a de vrais arguments (favori fatigué, absences, argent qui rentre sur l'outsider, forme). S'il n'y en a pas de crédible, mets null.\nRéponds UNIQUEMENT par ce JSON entre \`\`\`json et \`\`\` :\n{"legs":[{"eventId":"…","raison":"1 phrase factuelle"}],"resume":"2 phrases","outsider":{"eventId":"…","raison":"les arguments"} }` }],
      }),
    }).catch(() => null);
    if (r && r.ok) {
      const d = await r.json();
      const text = (d.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
      try {
        const j = JSON.parse((text.match(/```json\s*([\s\S]*?)```/) || [])[1]);
        resume = j.resume || "";
        if (j.outsider && j.outsider.eventId) { const c = topDogs.find((x) => x.eventId === j.outsider.eventId); if (c) dog = { ...c, raison: j.outsider.raison || "" }; }
        chosen = (j.legs || []).map((l) => { const c = top.find((x) => x.eventId === l.eventId); return c ? { ...c, raison: l.raison || "" } : null; }).filter(Boolean).slice(0, 3);
      } catch (e) { console.log("daily json", e.message); }
    }
  }
  if (!chosen) { chosen = top.slice(0, 3).map((c) => ({ ...c, raison: "Plus forte probabilité du jour selon le marché." })); resume = resume || "Sélection automatique des favoris les plus solides selon le marché."; }
  if (chosen.length < 2) chosen = [];
  const cote = chosen.reduce((a, l) => a * l.cote, 1), proba = chosen.reduce((a, l) => a * l.proba, 1);
  const rec = { day, ts: Date.now(), resume: chosen.length ? resume : "Pas assez de matchs vraiment solides aujourd'hui : pas de combiné. Ne pas jouer fait aussi gagner.", legs: chosen.map((l) => ({ ...l, label: label(l, l.side), status: "pending" })), cote: chosen.length ? Math.round(cote * 100) / 100 : null, proba: chosen.length ? proba : null, status: chosen.length ? "pending" : "none", outsider: dog ? { ...dog, label: label(dog, dog.side), status: "pending" } : null };
  await st.setJSON(`daily/${day}`, rec);
}

async function summarize(st) {
  const picks = [];
  for (const b of (await st.list({ prefix: "pick/" })).blobs) { const x = await st.get(b.key, { type: "json" }); if (x) picks.push(x); }
  const combos = [];
  for (const b of (await st.list({ prefix: "daily/" })).blobs) { const x = await st.get(b.key, { type: "json" }); if (x && x.status !== "none") combos.push(x); }
  const stat = (arr, odd) => {
    const done = arr.filter((x) => x.status === "won" || x.status === "lost");
    const won = done.filter((x) => x.status === "won");
    const profit = won.reduce((a, x) => a + (odd(x) - 1), 0) - (done.length - won.length);
    return { n: done.length, won: won.length, hit: done.length ? won.length / done.length : null, roi: done.length ? profit / done.length : null, pending: arr.filter((x) => x.status === "pending").length };
  };
  const dailyAll = [];
  for (const b of (await st.list({ prefix: "daily/" })).blobs) { const x = await st.get(b.key, { type: "json" }); if (x && x.outsider) dailyAll.push({ ...x.outsider, ts: Date.parse(x.day) || x.ts, match: `${x.outsider.home} – ${x.outsider.away}`, marche: x.outsider.label, source: "outsider du jour" }); }
  const outs = [...picks.filter((x) => x.source === "outsider"), ...dailyAll].sort((a, b) => b.ts - a.ts);
  const favs = picks.filter((x) => x.source !== "outsider");
  picks.length = 0; picks.push(...favs);
  picks.sort((a, b) => b.ts - a.ts); combos.sort((a, b) => (a.day < b.day ? 1 : -1));
  const summary = {
    updated: Date.now(),
    analyse: { ...stat(picks, (x) => x.cote), calibration: [[0.55, 0.62, "55-62 %"], [0.62, 0.7, "62-70 %"], [0.7, 0.8, "70-80 %"], [0.8, 1.01, "80 % et +"]].map(([lo, hi, label]) => { const b = picks.filter((x) => (x.status === "won" || x.status === "lost") && x.proba >= lo && x.proba < hi); return { label, n: b.length, won: b.filter((x) => x.status === "won").length }; }), last: picks.slice(0, 20).map((x) => ({ match: `${x.home} – ${x.away}`, pick: x.marche, cote: x.cote, proba: x.proba, status: x.status, ts: x.ts })) },
    outsider: { ...stat(outs, (x) => x.cote), last: outs.slice(0, 15).map((x) => ({ match: x.match || `${x.home} – ${x.away}`, pick: x.marche, cote: x.cote, proba: x.proba, status: x.status, ts: x.ts })) },
    combine: { ...stat(combos, (x) => x.cote), last: combos.slice(0, 14).map((c) => ({ day: c.day, cote: c.cote, proba: c.proba, status: c.status, legs: c.legs.map((l) => ({ label: l.label, match: `${l.home} – ${l.away}`, status: l.status })) })) },
  };
  await st.setJSON("summary", summary);
}

export default async (req) => {
  const secret = process.env.SESSION_SECRET || "";
  const sig = req.headers.get("x-arisebet-cron") || "";
  const ok = [0, 1].some((n) => { const d = new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10); const exp = crypto.createHmac("sha256", secret).update("daily-run:" + d).digest("hex"); return secret && sig.length === exp.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp)); });
  if (!ok) { console.log("daily-run : signature refusée"); return; }
  if (!process.env.ODDS_API_KEY) { console.log("daily-run : ODDS_API_KEY manquante"); return; }
  const st = getStore("arisebet-track");
  try { await settle(st); } catch (e) { console.log("settle", e.message); }
  const day = parisDay();
  const h = Number(new Date().toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Europe/Paris" }));
  try { if (h < 16 && !(await st.get(`daily/${day}`))) await generate(st, day); } catch (e) { console.log("generate", e.message); }
  try { await summarize(st); } catch (e) { console.log("summary", e.message); }
};
