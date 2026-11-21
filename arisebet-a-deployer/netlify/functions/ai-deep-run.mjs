// Fonction en arrière-plan (jusqu'à 15 min) : la grosse analyse d'un match, lancée par ai-deep.mjs.
// Écrit sa progression dans Blobs (deepjob/<id>) puis le résultat (deep/<id>), partagé 3 h entre tous les membres.
// Variables : ANTHROPIC_API_KEY, SESSION_SECRET. Optionnelle : AI_DEEP_MODEL (défaut claude-sonnet-5-5 ; claude-opus-5-5 = encore plus fin, ~2× plus cher).
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";
import { matchPrompt, recordPick, recordOutsider, extractJson, wrapJson, validateMatch } from "./lib/ai-common.mjs";
import { espnBrief } from "./lib/espn.mjs";

export const config = { background: true };

const CRITIC_SYSTEM = `Tu es le contrôleur qualité d'Arisebet. Un analyste a écrit l'analyse JSON d'un match. Ton travail : la rendre irréprochable avant qu'un client paie pour la lire. Réponds en français.
Vérifie point par point :
1. La forme citée est-elle datée et de la saison EN COURS ? Correspond-elle aux résultats ESPN fournis (s'il y en a) ? Corrige avec les résultats ESPN.
2. Chaque chiffre (stats, classement, confrontations, absences) a-t-il une source plausible ? Supprime ou marque "Non vérifié" ce qui ne l'est pas. Tu peux faire 1 ou 2 recherches web pour lever un doute important (blessure, titulaire).
3. Le raisonnement est-il cohérent avec les probabilités ? Un écart au marché de plus de 6 points doit être justifié par un fait précis, sinon réduis-le.
4. Le pick respecte-t-il les règles : proba ≥ 55 % et value ≥ −4 % avec les cotes fournies ? Sinon no_bet: true.
4 bis. L'outsider a-t-il été vraiment étudié ? Si ses arguments sont solides et sa value positive, garde-le ou ajoute-le ; s'il est là juste pour la cote, mets "outsider": null.
5. Le verdict est-il net et cohérent avec le pick ?
Renvoie l'analyse COMPLÈTE corrigée, même format, avec en plus "verification": ["ce que tu as vérifié ou corrigé, 1 ligne chacun"]. Uniquement le JSON entre \`\`\`json et \`\`\`.`;

const DEEP_SYSTEM = `Tu es l'analyste en chef d'Arisebet. Tu fais l'analyse la plus complète possible d'UN match pour des clients qui paient pour gagner sur la durée. Réponds en français. Tu as du temps : fais 6 à 10 recherches web ciblées avant de conclure.

RECHERCHES À FAIRE (adapte au sport ; en anglais pour sports US et tennis, en français pour foot et rugby français) :
1. Forme : les 5 à 10 derniers matchs de chaque camp AVEC DATES et scores, saison en cours uniquement (vérifie avec la date du jour). Distingue domicile et extérieur.
2. Classement, bilan, différence de buts/points, série en cours.
3. Statistiques avancées : football → xG pour/contre, tirs, possession, buts encaissés ; basket → offensive/defensive rating, pace, % à 3 points ; hockey → gardien titulaire et son % d'arrêts, power-play, penalty-kill ; tennis → classement, bilan sur la surface, % de jeux de service et de retour gagnés, aces/doubles fautes ; baseball → lanceurs partants (ERA, WHIP, forme), bullpen ; rugby → essais marqués/encaissés, discipline.
4. Confrontations directes récentes avec scores.
5. Absences : blessés, suspendus, incertains, compositions probables, joueurs clés et leur forme.
6. Calendrier : jours de repos, back-to-back, déplacement, match de Coupe d'Europe avant/après (rotation).
7. Enjeu et motivation : classement, qualification, derby, fin de saison.
8. Actualité des dernières 48 h (conférences de presse, entraînement, météo pour les sports en extérieur).
9. Le mouvement des cotes fourni : cherche ce qui l'explique.

RAISONNEMENT :
- Pars des probabilités du marché fournies (très fiables). Ajuste uniquement avec des faits trouvés, en général 0 à 6 points, jamais plus de 10, en expliquant chaque point.
- Évalue chaque marché fourni avec ses vraies cotes : value = proba × cote − 1. N'invente aucune cote ni aucun marché.
- Pick : la sélection la plus probable dont la value est ≥ −4 % et la proba ≥ 55 %. Sinon "no_bet": true. Donne aussi la meilleure value positive à part, et un plan B.
   OUTSIDER : examine TOUJOURS sérieusement l'outsider (le camp le moins probable). Les outsiders gagnent souvent quand le favori est surcoté, fatigué, privé de joueurs clés, démotivé, ou quand l'argent rentre sur l'outsider. Si l'outsider a de vrais arguments ET une value positive (ou une proba ≥ 30 % avec value ≥ −3 %), remplis "outsider" ; sinon mets "outsider": null. Ne mets jamais un outsider juste pour la grosse cote.
- Note le pick sur 20 (20 = quasi certain et bien payé ; 10 = pile ou face ; en dessous de 12 = à éviter).
- Toute info non trouvée : écris "Non trouvé". Ne garantis jamais un gain.

FORMAT : une phrase si tu veux pendant les recherches, puis UNIQUEMENT ce JSON entre \`\`\`json et \`\`\` :
{
 "resume": "3 phrases : ce qui décide ce match",
 "note_sur_20": 0,
 "score_predit": "2-1",
 "scenario": "comment le match devrait se dérouler, 2-3 phrases",
 "forme": {"A": "derniers résultats datés + tendance", "B": "idem"},
 "domicile_exterieur": "bilans à domicile de A et à l'extérieur de B",
 "classement": "…",
 "stats_cles": [{"stat": "xG pour / match", "A": "1,9", "B": "1,1"}],
 "confrontations": "…",
 "absences": {"A": "…", "B": "…"},
 "joueurs_cles": "…",
 "calendrier_fatigue": "…",
 "enjeu_motivation": "…",
 "mouvement_cotes": "ce que dit le marché et pourquoi",
 "probas": {"A": 0.00, "N": 0.00, "B": 0.00},
 "ajustement": "écart au marché et pourquoi",
 "marches": [{"marche": "…", "cote": 0.00, "bookmaker": "…", "proba": 0.00, "value": 0.00, "risque": "faible|moyen|élevé"}],
 "pick": {"marche": "…", "cote": 0.00, "bookmaker": "…", "proba": 0.00, "confiance": "haute|moyenne|faible", "pourquoi": "2 phrases", "cote_mini": 0.00},
 "plan_b": {"marche": "…", "cote": 0.00, "proba": 0.00, "pourquoi": "1 phrase"},
 "meilleure_value": {"marche": "…", "cote": 0.00, "bookmaker": "…", "proba": 0.00, "value": 0.00},
 "outsider": {"marche": "…", "cote": 0.00, "bookmaker": "…", "proba": 0.00, "value": 0.00, "pourquoi": "les arguments concrets pour la surprise"},
 "no_bet": false,
 "risques": ["…"],
 "verdict": "une phrase nette",
 "sources": [{"titre": "…", "url": "https://…"}]
}
"cote_mini" = la cote en dessous de laquelle le pick ne vaut plus le coup (≈ 1 / proba × 0,96). Utilise null quand une rubrique n'existe pas.`;

export default async (req) => {
  const raw = await req.text();
  const sig = req.headers.get("x-arisebet-sig") || "";
  const exp = crypto.createHmac("sha256", process.env.SESSION_SECRET || "").update(raw).digest("hex");
  if (!process.env.SESSION_SECRET || sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) { console.log("ai-deep-run : signature refusée"); return; }
  const { match } = JSON.parse(raw);
  const st = getStore("arisebet-ai");
  const jobKey = `deepjob/${match.id}`, started = Date.now(), progress = ["Lecture des cotes et du marché"];
  const save = (extra = {}) => st.setJSON(jobKey, { status: "running", started, progress, ...extra }).catch(() => {});
  await save();
  if (match.sportKey && !match.espn) { progress.push("Récupération des résultats officiels ESPN"); await save(); try { match.espn = await espnBrief(match.sportKey, match.home, match.away); } catch (e) {} if (match.espn) progress.push("Résultats ESPN récupérés"); }

  let text = ""; const sources = new Map(), blocks = {};
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.AI_DEEP_MODEL || "claude-sonnet-5-5", max_tokens: 8000, stream: true, system: DEEP_SYSTEM,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 10, user_location: { type: "approximate", country: "FR", timezone: "Europe/Paris" } }],
        messages: [{ role: "user", content: matchPrompt(match) + "\n\nFais l'analyse complète selon la méthode (6 à 10 recherches), puis donne le JSON." }],
      }),
    });
    if (!r.ok || !r.body) throw new Error("anthropic " + r.status + " " + (await r.text().catch(() => "")).slice(0, 300));
    const reader = r.body.getReader(), dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: ")); buf = buf.slice(i + 2);
        if (!line) continue; let ev; try { ev = JSON.parse(line.slice(6)); } catch (e) { continue; }
        if (ev.type === "content_block_start") {
          const b = ev.content_block || {}; blocks[ev.index] = { type: b.type, json: "" };
          if (b.type === "web_search_tool_result" && Array.isArray(b.content)) b.content.forEach((x) => { if (x.url && sources.size < 16) sources.set(x.url, x.title || x.url); });
        } else if (ev.type === "content_block_delta") {
          const d = ev.delta || {}, b = blocks[ev.index] || {};
          if (d.type === "input_json_delta") b.json = (b.json || "") + (d.partial_json || "");
          else if (d.type === "text_delta") text += d.text;
          else if (d.type === "citations_delta" && d.citation && d.citation.url) sources.set(d.citation.url, d.citation.title || d.citation.url);
        } else if (ev.type === "content_block_stop") {
          const b = blocks[ev.index];
          if (b && b.type === "server_tool_use") { try { const q = JSON.parse(b.json || "{}").query; if (q) { progress.push("Recherche : " + q); await save(); } } catch (e) {} }
          if (b && b.type === "text" && /```json/.test(text) && !progress.includes("Rédaction du verdict")) { progress.push("Rédaction du verdict"); await save(); }
        }
      }
    }
    if (!/```json/.test(text)) throw new Error("no_json");
    // 2e passe : contre-expertise par un contrôleur qualité, puis contrôle automatique des chiffres
    progress.push("Contre-expertise de l'analyse"); await save();
    let j = extractJson(text);
    try {
      const c = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: process.env.AI_DEEP_MODEL || "claude-sonnet-5-5", max_tokens: 8000, system: CRITIC_SYSTEM,
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2, user_location: { type: "approximate", country: "FR", timezone: "Europe/Paris" } }],
          messages: [{ role: "user", content: `${matchPrompt(match)}\n\nSOURCES CONSULTÉES PAR L'ANALYSTE :\n${[...sources].map(([u, t]) => "- " + t + " (" + u + ")").join("\n") || "(aucune)"}\n\nANALYSE À CONTRÔLER :\n${wrapJson(j)}` }],
        }),
      });
      if (c.ok) { const d = await c.json(); const t2 = (d.content || []).filter((x) => x.type === "text").map((x) => x.text).join(""); const j2 = extractJson(t2); if (j2 && j2.pick !== undefined && j2.probas) j = j2; }
    } catch (e) { console.log("critique", e.message); }
    j = validateMatch(j, match);
    progress.push(j.controle && j.controle.corrections.length ? `Contrôle des chiffres : ${j.controle.corrections.length} correction(s)` : "Contrôle des chiffres : tout est juste"); await save();
    text = wrapJson(j);
    const result = { ts: Date.now(), text, sources: [...sources].map(([url, titre]) => ({ url, titre })), deep: true };
    await st.setJSON(`deep/${match.id}`, result);
    await st.setJSON(jobKey, { status: "done", started, progress });
    try { await recordPick(match, text); } catch (e) {}
    try { await recordOutsider(match, j); } catch (e) {}
  } catch (e) {
    console.log("ai-deep-run", e.message);
    await st.setJSON(jobKey, { status: "error", started, progress, error: "ai_failed" });
  }
};
