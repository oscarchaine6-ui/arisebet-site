// Fonctions partagées par ai-analyze.mjs et ai-deep-run.mjs.
const pct = (p) => (p == null ? "—" : Math.round(p * 1000) / 10 + " %");
const odd = (o) => (o == null ? "—" : Number(o).toFixed(2));

export function matchPrompt(m) {
  const today = new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" });
  const lines = [];
  lines.push(`Date du jour : ${today}.`);
  lines.push(`Sport : ${m.sport} · Compétition : ${m.competition}`);
  lines.push(`Coup d'envoi : ${m.kickoff} (heure de Paris)${m.live ? " — LE MATCH EST EN COURS" : ""}`);
  lines.push(`Équipe/joueur A (domicile) : ${m.home}`);
  lines.push(`Équipe/joueur B (extérieur) : ${m.away}`);
  lines.push("");
  lines.push(`PROBABILITÉS DU MARCHÉ sans marge (méthode de Shin, consensus de ${m.books} bookmakers, Pinnacle et Betfair pondérés plus fort) :`);
  lines.push(`- A ${m.home} : ${pct(m.fair.A)} · meilleure cote ${odd(m.best.A?.price)} (${m.best.A?.book || "—"}) · Unibet ${odd(m.unibet?.A)}`);
  if (m.fair.N) lines.push(`- Nul : ${pct(m.fair.N)} · meilleure cote ${odd(m.best.N?.price)} (${m.best.N?.book || "—"}) · Unibet ${odd(m.unibet?.N)}`);
  lines.push(`- B ${m.away} : ${pct(m.fair.B)} · meilleure cote ${odd(m.best.B?.price)} (${m.best.B?.book || "—"}) · Unibet ${odd(m.unibet?.B)}`);
  lines.push(`Marge moyenne des bookmakers : ${pct(m.margin)}`);
  if (Array.isArray(m.extra) && m.extra.length) {
    lines.push("");
    lines.push("AUTRES MARCHÉS DISPONIBLES (proba sans marge · meilleure cote · Unibet) :");
    m.extra.slice(0, 16).forEach((x) => lines.push(`- ${x.label} : ${pct(x.p)} · ${odd(x.best?.price)} (${x.best?.book || "—"}) · Unibet ${odd(x.uni)}`));
  }
  if (m.espn) {
    lines.push("");
    lines.push("RÉSULTATS VÉRIFIÉS ESPN (source fiable et à jour : base de la forme, ne les contredis pas) :");
    lines.push(m.espn);
  }
  if (m.movement) {
    lines.push("");
    lines.push(`MOUVEMENT DES COTES depuis l'ouverture (cote moyenne) : ${m.movement}. Une baisse nette signale souvent de l'argent informé (compo, blessure) : cherche pourquoi.`);
  }
  if (m.standings) {
    lines.push("");
    lines.push(`CLASSEMENT ESPN (à jour) : ${m.standings}`);
  }
  if (m.userNotes) {
    lines.push("");
    lines.push(`SAISIE DU CLIENT (prioritaire si plus récente que tes sources) : ${m.userNotes}`);
  }
  if (m.hockeyNote) lines.push(m.hockeyNote);
  return lines.join("\n");
}

// Enregistre le pick de l'IA (marché vainqueur) pour le bilan public, vérifié ensuite par daily-run.
export async function recordOutsider(m, j) {
  if (!m || !m.sportKey || !m.id || !j || !j.outsider || !j.outsider.marche) return;
  const side = sideOfLabel(j.outsider.marche, m); if (!side) return;
  const { getStore } = await import("@netlify/blobs");
  const st = getStore("arisebet-track"), key = `pick/o-${String(m.id).replace(/[^\w-]/g, "")}`;
  if (await st.get(key)) return;
  await st.setJSON(key, { eventId: m.id, sportKey: m.sportKey, home: m.home, away: m.away, side, marche: j.outsider.marche, cote: Number(j.outsider.cote), proba: Number(j.outsider.proba) || null, kickoff: m.kickoffIso || null, ts: Date.now(), status: "pending", source: "outsider" });
}

export async function recordPick(m, text) {
  if (!m || !m.sportKey || !m.id) return;
  const raw = (text.match(/```json\s*([\s\S]*?)```/) || [])[1]; if (!raw) return;
  const j = JSON.parse(raw); if (!j || j.no_bet || !j.pick || !j.pick.marche || !j.pick.cote) return;
  const norm = (x) => String(x || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  const mk = norm(j.pick.marche);
  if (/[+-]\d|plusde|moinsde|chance|handicap|over|under/.test(mk)) return; // seulement le marché vainqueur, vérifiable automatiquement
  let side = null;
  if (/nul|draw/.test(mk)) side = "N"; else if (norm(m.home) && mk.includes(norm(m.home))) side = "A"; else if (norm(m.away) && mk.includes(norm(m.away))) side = "B";
  if (!side) return;
  const { getStore } = await import("@netlify/blobs");
  const st = getStore("arisebet-track");
  const key = `pick/${String(m.id).replace(/[^\w-]/g, "")}`;
  if (await st.get(key)) return; // un seul pick par match (le premier)
  await st.setJSON(key, { eventId: m.id, sportKey: m.sportKey, home: m.home, away: m.away, side, marche: j.pick.marche, cote: Number(j.pick.cote), proba: Number(j.pick.proba) || null, kickoff: m.kickoffIso || null, ts: Date.now(), status: "pending", source: "analyse" });
}


/* ============ CONTRÔLE AUTOMATIQUE DES RÉPONSES DE L'IA ============
   L'IA peut se tromper dans un calcul ou citer une cote qui n'existe pas.
   Ces fonctions revérifient tout avec les VRAIES données avant d'afficher quoi que ce soit. */
const nrm = (x) => String(x || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
const num = (x) => { const n = typeof x === "string" ? parseFloat(x.replace(",", ".")) : Number(x); return isFinite(n) ? n : null; };
const r2 = (x) => Math.round(x * 100) / 100;
const riskOf = (p) => (p >= 0.68 ? "faible" : p >= 0.52 ? "moyen" : "élevé");

export function extractJson(text) {
  const m = String(text || "").match(/```json\s*([\s\S]*?)```/);
  let raw = m ? m[1] : null;
  if (!raw) { const i = text.indexOf("{"), j = text.lastIndexOf("}"); if (i >= 0 && j > i) raw = text.slice(i, j + 1); }
  try { return JSON.parse(raw); } catch (e) { return null; }
}
export const wrapJson = (j) => "```json\n" + JSON.stringify(j) + "\n```";

function sideOfLabel(label, m) {
  const raw = String(label || "").toLowerCase();
  if (/[+-]\s?\d|chance|plus de|moins de|over|under|handicap|\bou\b/.test(raw)) return null;
  const k = nrm(label).replace(/^victoire/, "");
  if (/^(match)?nul$/.test(k) || k === "draw") return "N";
  const h = nrm(m.home), a = nrm(m.away);
  const ini = (n) => { const w = String(n || "").split(/[\s-]+/).filter((x) => x.length > 1); return w.length >= 2 ? nrm(w.map((x) => x[0]).join("")) : ""; };
  if (k && k === ini(m.home)) return "A";
  if (k && k === ini(m.away)) return "B";
  if (h && (k === h || k.includes(h) || (h.includes(k) && k.length >= 4))) return "A";
  if (a && (k === a || k.includes(a) || (a.includes(k) && k.length >= 4))) return "B";
  return null;
}

// Liste des cotes réellement disponibles pour ce match : vainqueur + marchés plus/moins/handicaps fournis.
function knownMarkets(m) {
  const out = [];
  const add = (label, p, best, uni, side) => { if (p != null) out.push({ label, key: nrm(label), p, best: best || null, uni: uni ?? null, side }); };
  add("Victoire " + m.home, m.fair?.A, m.best?.A, m.unibet?.A, "A");
  if (m.fair?.N) add("Match nul", m.fair.N, m.best?.N, m.unibet?.N, "N");
  add("Victoire " + m.away, m.fair?.B, m.best?.B, m.unibet?.B, "B");
  (m.extra || []).forEach((x) => add(x.label, x.p, x.best, x.uni, null));
  return out;
}
function findMarket(known, label, m) {
  const side = sideOfLabel(label, m);
  if (side) return known.find((x) => x.side === side) || null;
  const k = nrm(label);
  return known.find((x) => x.key === k) || known.find((x) => k && (x.key.includes(k) || k.includes(x.key)) && Math.abs(x.key.length - k.length) <= 6) || null;
}

export function validateMatch(j, m) {
  if (!j || typeof j !== "object") return j;
  const fixes = [];
  const known = knownMarkets(m);
  const keys = m.fair && m.fair.N ? ["A", "N", "B"] : ["A", "B"];
  // 1. Probabilités : nombres valides, somme = 100 %, jamais à plus de 10 points du marché
  const P = {};
  keys.forEach((k) => { let v = num(j.probas && j.probas[k]); if (v != null && v > 1) v = v / 100; P[k] = v != null && v >= 0 && v <= 1 ? v : m.fair[k]; });
  let clamped = false;
  for (let it = 0; it < 8; it++) { // ramène dans ±10 points du marché puis renormalise, jusqu'à stabilité
    keys.forEach((k) => { const lo = Math.max(0.005, m.fair[k] - 0.1), hi = Math.min(0.995, m.fair[k] + 0.1); if (P[k] < lo - 1e-9 || P[k] > hi + 1e-9) { P[k] = Math.min(hi, Math.max(lo, P[k])); clamped = true; } });
    const sum = keys.reduce((s, k) => s + P[k], 0); keys.forEach((k) => { P[k] = P[k] / sum; });
  }
  keys.forEach((k) => { P[k] = Math.round(P[k] * 1000) / 1000; });
  if (clamped) fixes.push("Probabilité ramenée à 10 points maximum de l'écart avec le marché");
  if (!m.fair.N) P.N = 0;
  j.probas = P;
  const probaFor = (mk) => (mk.side ? P[mk.side] : mk.p);
  // 2. Marchés : la cote doit exister chez un bookmaker, la value est recalculée
  if (Array.isArray(j.marches)) {
    const before = j.marches.length;
    j.marches = j.marches.map((x) => {
      const mk = findMarket(known, x.marche, m);
      if (!mk || !mk.best) return null;
      const cote = num(x.cote), real = mk.best.price;
      if (cote == null || Math.abs(cote - real) > 0.02 && !(mk.uni && Math.abs(cote - mk.uni) <= 0.02)) fixes.push(`Cote corrigée pour « ${x.marche} » : ${real.toFixed(2)} (meilleure cote réelle)`);
      const useCote = cote != null && mk.uni && Math.abs(cote - mk.uni) <= 0.02 ? mk.uni : real;
      let p = num(x.proba); if (p != null && p > 1) p /= 100;
      if (mk.side) p = probaFor(mk); else if (p == null || Math.abs(p - mk.p) > 0.1) { if (p != null) fixes.push(`Proba de « ${x.marche} » ramenée près du marché`); p = p == null ? mk.p : Math.min(mk.p + 0.1, Math.max(mk.p - 0.1, p)); }
      return { marche: x.marche, cote: useCote, bookmaker: useCote === real ? mk.best.book : "Unibet", proba: Math.round(p * 1000) / 1000, value: Math.round((p * useCote - 1) * 1000) / 1000, risque: riskOf(p) };
    }).filter(Boolean);
    if (j.marches.length < before) fixes.push(`${before - j.marches.length} marché(s) retiré(s) : cote introuvable chez les bookmakers`);
  }
  // 3. Pick : vraie cote, vraie proba, règles d'Arisebet (≥ 55 % et value ≥ −4 %)
  if (j.pick && j.pick.marche) {
    const mk = findMarket(known, j.pick.marche, m);
    if (!mk || !mk.best) { fixes.push("Pick retiré : sa cote n'existe chez aucun bookmaker"); j.pick = null; }
    else {
      let p = mk.side ? P[mk.side] : num(j.pick.proba); if (p != null && p > 1) p /= 100; if (!mk.side && (p == null || Math.abs(p - mk.p) > 0.1)) p = mk.p;
      const cote = mk.best.price, v = p * cote - 1;
      if (num(j.pick.cote) != null && Math.abs(num(j.pick.cote) - cote) > 0.02) fixes.push(`Cote du pick corrigée : ${cote.toFixed(2)} chez ${mk.best.book}`);
      j.pick = { ...j.pick, cote, bookmaker: mk.best.book, proba: Math.round(p * 1000) / 1000, value: Math.round(v * 1000) / 1000, cote_mini: r2(Math.max(1.01, 0.96 / p)) };
      if (p < 0.55 || v < -0.04) { fixes.push(`Pick refusé par les règles (${Math.round(p * 100)} % de chances, value ${(v * 100).toFixed(1)} %) : NO BET`); if (!j.plan_b || !j.plan_b.marche) j.plan_b = { marche: j.pick.marche, cote, proba: j.pick.proba, pourquoi: "Ne respecte pas les règles de sécurité : à jouer petit si tu le joues." }; j.pick = null; j.no_bet = true; }
    }
  }
  if (!j.pick) j.no_bet = true;
  if (j.no_bet) j.pick = null;
  // 4. Meilleure value : seulement si elle existe vraiment
  if (j.meilleure_value && j.meilleure_value.marche) {
    const mk = findMarket(known, j.meilleure_value.marche, m);
    if (!mk || !mk.best) j.meilleure_value = null;
    else { const p = mk.side ? P[mk.side] : (num(j.meilleure_value.proba) ?? mk.p); const v = p * mk.best.price - 1; j.meilleure_value = v > 0 ? { marche: j.meilleure_value.marche, cote: mk.best.price, bookmaker: mk.best.book, proba: Math.round(p * 1000) / 1000, value: Math.round(v * 1000) / 1000 } : null; }
  }
  // 4 bis. Outsider : vraie cote, proba cohérente, il faut des arguments ET (value ≥ 0, ou proba ≥ 30 % et value ≥ −3 %)
  if (j.outsider && j.outsider.marche) {
    const mk = findMarket(known, j.outsider.marche, m);
    if (!mk || !mk.best) { fixes.push("Outsider retiré : cote introuvable"); j.outsider = null; }
    else {
      let p = mk.side ? P[mk.side] : num(j.outsider.proba); if (p != null && p > 1) p /= 100; if (!mk.side && (p == null || Math.abs(p - mk.p) > 0.1)) p = mk.p;
      const v = p * mk.best.price - 1;
      if (!(v >= 0 || (p >= 0.3 && v >= -0.03)) || !j.outsider.pourquoi) { fixes.push(`Outsider « ${j.outsider.marche} » retiré : pas assez de value (${(v * 100).toFixed(1)} %)`); j.outsider = null; }
      else j.outsider = { ...j.outsider, cote: mk.best.price, bookmaker: mk.best.book, proba: Math.round(p * 1000) / 1000, value: Math.round(v * 1000) / 1000 };
    }
  } else j.outsider = null;
  // 5. Note sur 20 cohérente
  if (j.note_sur_20 != null) { let n = num(j.note_sur_20); n = n == null ? null : Math.max(0, Math.min(20, Math.round(n))); if (j.no_bet && n > 11) { n = 11; fixes.push("Note ramenée à 11/20 : pas de pick"); } j.note_sur_20 = n; }
  j.controle = { ok: fixes.length === 0, corrections: fixes, ts: Date.now() };
  return j;
}

export function validateTicket(j) {
  if (!j || !Array.isArray(j.jambes)) return j;
  const fixes = [];
  j.jambes = j.jambes.map((l) => {
    let p = num(l.proba); if (p != null && p > 1) p /= 100; if (p != null) p = Math.min(0.99, Math.max(0.01, p));
    const r = p != null ? riskOf(p) : l.risque;
    if (p != null && l.risque && l.risque !== r) fixes.push(`Risque de « ${l.pari} » recalé sur sa proba`);
    return { ...l, proba: p, risque: r, note_sur_20: l.note_sur_20 != null ? Math.max(0, Math.min(20, Math.round(num(l.note_sur_20) || 0))) : null };
  });
  const ps = j.jambes.map((l) => l.proba).filter((x) => x != null), cs = j.jambes.map((l) => num(l.cote)).filter((x) => x != null);
  if (ps.length === j.jambes.length && ps.length) { const P = ps.reduce((a, b) => a * b, 1); if (j.proba_totale == null || Math.abs(num(j.proba_totale) - P) > 0.01) fixes.push("Proba totale recalculée (produit des jambes)"); j.proba_totale = Math.round(P * 10000) / 10000; }
  if (cs.length === j.jambes.length && cs.length && j.cote_totale == null) j.cote_totale = r2(cs.reduce((a, b) => a * b, 1));
  if (j.jambes.length > 1 && ps.length === j.jambes.length) { const w = j.jambes.reduce((x, l) => (l.proba < x.proba ? l : x)); if (!j.jambe_faible || !nrm(j.jambe_faible).includes(nrm(w.pari).slice(0, 6))) fixes.push("Jambe faible recalculée"); j.jambe_faible = `${w.pari} (${w.match}, ${Math.round(w.proba * 100)} %)`; }
  j.controle = { ok: fixes.length === 0, corrections: fixes, ts: Date.now() };
  return j;
}
