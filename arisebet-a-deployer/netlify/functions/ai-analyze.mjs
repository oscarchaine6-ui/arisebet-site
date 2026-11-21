// POST /.netlify/functions/ai-analyze
// Analyse IA d'un match (mode "match") ou question libre (mode "chat"), avec recherche web.
// Réservé aux membres payants : même session et même vérification Stripe que auth.js.
//
// Variables d'environnement Netlify (scope Functions) :
//   ANTHROPIC_API_KEY   — obligatoire (console.anthropic.com)
//   SESSION_SECRET, STRIPE_SECRET_KEY, FREE_ACCESS_EMAILS — déjà utilisées par auth.js
// Optionnelles :
//   AI_MODEL            — défaut "claude-sonnet-5-5"
//   AI_DAILY_LIMIT      — analyses de match par membre et par jour (défaut 15)
//   AI_CHAT_DAILY_LIMIT — questions au chat par membre et par jour (défaut 30)
//   AI_TICKET_DAILY_LIMIT — tickets/combinés analysés par membre et par jour (défaut 10)
//
// Réponse : flux SSE simplifié, une ligne "data: {json}" par événement :
//   {t:"search", q}        une recherche web lancée
//   {t:"text", d}          morceau de texte (mode chat)
//   {t:"done", text, sources, cached, left}
//   {t:"error", error}
import access from "./lib/access.js";
import { espnBrief } from "./lib/espn.mjs";
import { matchPrompt, recordPick, recordOutsider, extractJson, wrapJson, validateMatch, validateTicket } from "./lib/ai-common.mjs";

const { verifySession, isPaid } = access;
const MODEL = () => process.env.AI_MODEL || "claude-sonnet-5-5";
const CACHE_MS = 3 * 3600 * 1000;
const HARD_STOP_MS = 54 * 1000; // la plateforme coupe à 60 s

async function blobStore() {
  try {
    const { getStore } = await import("@netlify/blobs");
    return getStore("arisebet-ai");
  } catch (e) {
    return null; // sans Blobs : pas de cache partagé ni de quota persistant, l'analyse marche quand même
  }
}

const memQuota = new Map();
async function takeQuota(store, user, kind) {
  const limit = Number(kind === "chat" ? process.env.AI_CHAT_DAILY_LIMIT || 30 : kind === "ticket" ? process.env.AI_TICKET_DAILY_LIMIT || 10 : process.env.AI_DAILY_LIMIT || 15);
  const day = new Date().toISOString().slice(0, 10);
  const key = `quota/${kind}/${user.sub || user.email}/${day}`;
  let used = 0;
  if (store) { try { used = Number((await store.get(key)) || 0); } catch (e) {} }
  else used = memQuota.get(key) || 0;
  if (used >= limit) return { ok: false, left: 0, limit };
  used++;
  if (store) { try { await store.set(key, String(used)); } catch (e) {} }
  else memQuota.set(key, used);
  return { ok: true, left: limit - used, limit };
}

const MATCH_SYSTEM = `Tu es l'analyste principal d'Arisebet, une app française d'aide à la décision pour les paris sportifs. Tes clients paient pour une analyse sérieuse, vérifiée et honnête qui les aide à gagner sur la durée. Réponds toujours en français.

MÉTHODE (dans cet ordre) :
1. Recherche sur le web, en 3 à 5 recherches ciblées (en anglais pour les sports US et le tennis, en français pour le football et le rugby français) :
   a) les 5 derniers résultats de chaque camp avec leurs dates. VÉRIFIE que ce sont bien les plus récents de la saison en cours par rapport à la date du jour : n'utilise jamais une saison passée comme forme actuelle ;
   b) le classement ou le bilan de la saison ;
   c) les confrontations directes récentes ;
   d) les absences, blessures, suspensions et compositions probables (gardien titulaire en NHL, lanceur partant en MLB, back-to-back en NBA/NHL, surface et vitesse du court en tennis) ;
   e) le contexte : enjeu, rotation possible, calendrier, déplacement, et les infos des dernières 48 h.
2. Pars des probabilités du marché fournies : elles sont très fiables. Ajuste-les uniquement avec des faits concrets trouvés (absence d'un joueur clé, rotation, fatigue…), en général de 0 à 6 points, jamais plus de 10. Explique chaque ajustement.
3. Évalue chaque marché fourni avec SES cotes réelles : value = proba × cote − 1. N'invente jamais de cote ni de marché absent des données.
4. Choisis le pick : le client veut avant tout la plus forte probabilité de gagner, sans tomber dans un piège à valeur négative. Prends la sélection la plus probable dont la value est d'au moins −4 % et la proba d'au moins 55 %. Si aucune ne remplit ces deux conditions, mets "no_bet": true et "pick": null. Indique à part la meilleure value positive s'il y en a une.
   OUTSIDER : examine TOUJOURS sérieusement l'outsider (le camp le moins probable). Les outsiders gagnent souvent quand le favori est surcoté, fatigué, privé de joueurs clés, démotivé, ou quand l'argent rentre sur l'outsider. Si l'outsider a de vrais arguments ET une value positive (ou une proba ≥ 30 % avec value ≥ −3 %), remplis "outsider" ; sinon mets "outsider": null. Ne mets jamais un outsider juste pour la grosse cote.
5. Points à vérifier selon le sport :
   - Football : compos probables, rotation avant/après une Coupe d'Europe, enjeu au classement, domicile/extérieur, moyenne de buts pour les marchés plus/moins.
   - Basket (NBA/Euroleague) : rapport de blessures du jour, back-to-back et voyages, rythme (pace) des deux équipes pour les totaux.
   - Hockey (NHL) : gardien titulaire confirmé, back-to-back. Le client joue le Face à Face, prolongation et tirs au but compris.
   - Tennis : surface et vitesse du court, classement, bilan de la saison sur cette surface, % de jeux de service gagnés, fatigue du tour précédent, abandons récents.
   - Baseball : lanceurs partants (ERA, forme), bullpen.
   - Rugby : compositions, doublons internationaux, météo.
6. Ne présente jamais un pari comme sûr à 100 %. Si une info n'est pas trouvée, écris "Non trouvé" plutôt que d'inventer. Sois direct et concis.

FORMAT DE SORTIE : une courte phrase pendant tes recherches si tu veux, puis UNIQUEMENT ce bloc JSON à la fin, entre \`\`\`json et \`\`\` :
{
 "resume": "2 à 3 phrases : ce qui décide ce match",
 "note_sur_20": 0,
 "forme": {"A": "5 derniers résultats datés + tendance", "B": "idem"},
 "classement": "bilans / classements",
 "confrontations": "derniers face-à-face",
 "absences": "absences et compos, par camp",
 "contexte": "enjeu, calendrier, fatigue, surface…",
 "probas": {"A": 0.00, "N": 0.00, "B": 0.00},
 "ajustement": "en quoi et pourquoi tu t'écartes du marché (ou 'aucun')",
 "marches": [{"marche": "Victoire X", "cote": 0.00, "bookmaker": "…", "proba": 0.00, "value": 0.00, "risque": "faible|moyen|élevé"}],
 "pick": {"marche": "…", "cote": 0.00, "bookmaker": "…", "proba": 0.00, "confiance": "haute|moyenne|faible", "pourquoi": "1 phrase"},
 "meilleure_value": {"marche": "…", "cote": 0.00, "bookmaker": "…", "proba": 0.00, "value": 0.00} ,
 "outsider": {"marche": "…", "cote": 0.00, "bookmaker": "…", "proba": 0.00, "value": 0.00, "pourquoi": "les arguments concrets pour la surprise"},
 "no_bet": false,
 "risques": ["risque 1", "risque 2"],
 "verdict": "une phrase nette",
 "sources": [{"titre": "…", "url": "https://…"}]
}
Utilise null pour "pick", "meilleure_value" ou "outsider" s'il n'y en a pas. Pour un sport sans nul, mets "N": 0. "note_sur_20" note le pick (20 = quasi certain et bien payé, 10 = pile ou face, moins de 12 = à éviter ; 0 si NO BET).`;

const TICKET_SYSTEM = `Tu es l'analyste d'Arisebet. Un client te montre son ticket de paris (capture d'écran Unibet ou autre, ou liste de sélections). Réponds en français, direct et honnête.

MÉTHODE :
1. Lis le ticket : chaque sélection (match, type de pari, cote), le type (simple, combiné, système), la mise et la cote totale si visibles. N'invente rien : si une ligne est illisible, dis-le.
2. Pour chaque sélection, estime la probabilité réelle. Si le match figure dans la liste des matchs chargés fournie, pars de sa probabilité sans marge. Sinon pars de la cote (1/cote moins environ 6 % de marge).
3. Fais 2 à 4 recherches web sur les sélections les plus douteuses (forme récente de la saison en cours, blessures, contexte). Vérifie les dates : jamais une saison passée.
4. Un outsider n'est pas forcément une mauvaise jambe : s'il a une value positive et de vrais arguments, dis-le. Ce qui compte, c'est la proba réelle comparée à la cote.
5. Classe le risque de chaque sélection (faible ≥ 68 %, moyen 52-67 %, élevé < 52 %), calcule la probabilité totale du combiné (produit des probas) et repère la jambe la plus faible.
6. Propose une version améliorée : quelles jambes retirer, et éventuellement par quoi les remplacer en utilisant UNIQUEMENT des matchs et cotes de la liste fournie. Si le ticket est en cours, donne un conseil de cash-out.
7. Ne garantis jamais un gain.

FORMAT : uniquement ce JSON entre \`\`\`json et \`\`\` à la fin :
{
 "lecture": "ce que tu as lu : type, mise, cote totale, gain potentiel",
 "jambes": [{"match": "…", "pari": "…", "cote": 0.00, "proba": 0.00, "risque": "faible|moyen|élevé", "note_sur_20": 0, "note": "1 phrase factuelle"}],
 "note_ticket_sur_20": 0,
 "cote_totale": 0.00,
 "proba_totale": 0.00,
 "jambe_faible": "…",
 "a_retirer": ["…"],
 "version_amelioree": {"jambes": ["…"], "cote": 0.00, "proba": 0.00} ,
 "cash_out": "conseil ou null",
 "verdict": "une phrase nette",
 "sources": [{"titre": "…", "url": "https://…"}]
}`;

const CHAT_SYSTEM = `Tu es Arise IA, l'assistant de paris sportifs de l'app Arisebet. Réponds en français, court et direct, avec des listes à puces et des niveaux de risque (faible/moyen/élevé).
Tu reçois la liste des matchs chargés dans l'app avec leurs probabilités sans marge et leurs meilleures cotes réelles : sers-t'en en priorité et ne propose jamais de cote qui n'y figure pas. Tu peux faire 1 à 3 recherches web pour vérifier la forme, les blessures ou l'actualité.
Vérifie que la forme citée est bien de la saison en cours. Calcule la value (proba × cote − 1), signale la jambe la plus faible d'un combiné et dis "NO BET" quand rien ne vaut le coup. Ne propose pas que des favoris : si un outsider a une value positive et de vrais arguments (favori fatigué ou diminué, argent qui rentre sur l'outsider), présente-le comme tel, avec une petite mise. Ne garantis jamais un gain. Termine par une ligne "Sources :" si tu as cherché sur le web.`;

function sse(obj) {
  return new TextEncoder().encode("data: " + JSON.stringify(obj) + "\n\n");
}

export default async (req) => {
  if (req.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return Response.json({ error: "ai_not_configured" }, { status: 500 });

  const auth = req.headers.get("authorization") || "";
  const user = verifySession(auth.startsWith("Bearer ") ? auth.slice(7) : "");
  if (!user) return Response.json({ error: "invalid_session" }, { status: 401 });
  try {
    if (!(await isPaid(user.email))) return Response.json({ error: "not_subscribed" }, { status: 402 });
  } catch (e) {
    return Response.json({ error: "payment_check_unavailable" }, { status: 502 });
  }

  let body = {};
  try { body = await req.json(); } catch (e) {}
  const mode = body.mode === "chat" ? "chat" : body.mode === "ticket" ? "ticket" : "match";
  const store = await blobStore();

  // Cache partagé : une analyse de match sert à tous les membres pendant 3 h.
  const cacheKey = mode === "match" && body.match && body.match.id && !body.match.userNotes ? `match/${String(body.match.id).replace(/[^\w-]/g, "")}` : null;
  if (cacheKey && store && !body.force) {
    try {
      const hit = await store.get(cacheKey, { type: "json" });
      if (hit && Date.now() - hit.ts < CACHE_MS) {
        return new Response(new ReadableStream({ start(c) { c.enqueue(sse({ t: "done", text: hit.text, sources: hit.sources, cached: true, ts: hit.ts })); c.close(); } }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      }
    } catch (e) {}
  }

  const q = await takeQuota(store, user, mode);
  if (!q.ok) return Response.json({ error: "daily_limit", limit: q.limit }, { status: 429 });

  let messages, system, maxUses, maxTokens;
  if (mode === "match") {
    if (!body.match || !body.match.home || !body.match.away || !body.match.fair) return Response.json({ error: "bad_request" }, { status: 400 });
    if (body.match.sportKey && !body.match.espn) { try { body.match.espn = await Promise.race([espnBrief(body.match.sportKey, body.match.home, body.match.away), new Promise((ok) => setTimeout(() => ok(""), 7000))]); } catch (e) {} }
    system = MATCH_SYSTEM; maxUses = body.match.espn ? 4 : 5; maxTokens = 3500;
    messages = [{ role: "user", content: matchPrompt(body.match) + "\n\nFais ton analyse complète selon la méthode, puis donne le JSON." }];
  } else if (mode === "ticket") {
    const content = [];
    const img = typeof body.image === "string" ? body.image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/) : null;
    if (img) {
      if (img[2].length > 4_500_000) return Response.json({ error: "image_too_large" }, { status: 413 });
      content.push({ type: "image", source: { type: "base64", media_type: img[1], data: img[2] } });
    }
    const legs = Array.isArray(body.legs) ? body.legs.slice(0, 15).map((l) => String(l).slice(0, 300)) : [];
    if (!img && !legs.length) return Response.json({ error: "bad_request" }, { status: 400 });
    const ctx = String(body.context || "").slice(0, 12000);
    content.push({ type: "text", text: `Date du jour : ${new Date().toLocaleDateString("fr-FR", { dateStyle: "full", timeZone: "Europe/Paris" })}.\n${legs.length ? "Sélections du ticket :\n- " + legs.join("\n- ") + "\n" : "Le ticket est sur la capture d'écran.\n"}${body.stake ? "Mise : " + Number(body.stake) + " €\n" : ""}\nMatchs chargés dans l'app (proba sans marge et meilleures cotes) :\n${ctx || "(aucun)"}\n\nAnalyse ce ticket selon la méthode, puis donne le JSON.` });
    system = TICKET_SYSTEM; maxUses = 4; maxTokens = 3000;
    messages = [{ role: "user", content }];
  } else {
    const question = String(body.question || "").slice(0, 1500);
    if (!question) return Response.json({ error: "bad_request" }, { status: 400 });
    system = CHAT_SYSTEM; maxUses = 3; maxTokens = 1800;
    const ctx = String(body.context || "").slice(0, 12000);
    const hist = Array.isArray(body.history) ? body.history.slice(-6).filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string").map((h) => ({ role: h.role, content: h.content.slice(0, 3000) })) : [];
    messages = [...hist, { role: "user", content: `Date du jour : ${new Date().toLocaleDateString("fr-FR", { dateStyle: "full", timeZone: "Europe/Paris" })}.\nMatchs chargés dans l'app :\n${ctx || "(aucun)"}\n\nQuestion du client : ${question}` }];
    while (messages.length && messages[0].role !== "user") messages.shift();
  }

  const started = Date.now();
  const ctrl = new AbortController();
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: ctrl.signal,
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL(), max_tokens: maxTokens, stream: true, system, messages,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxUses, user_location: { type: "approximate", country: "FR", timezone: "Europe/Paris" } }],
    }),
  }).catch((e) => null);
  if (!upstream || !upstream.ok || !upstream.body) {
    const detail = upstream ? await upstream.text().catch(() => "") : "network";
    console.log("anthropic error", upstream && upstream.status, detail.slice(0, 500));
    return Response.json({ error: "ai_unavailable" }, { status: 502 });
  }

  const stream = new ReadableStream({
    async start(out) {
      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
      let buf = "", text = "";
      const blocks = {}; const sources = new Map();
      const timer = setTimeout(() => ctrl.abort(), HARD_STOP_MS - (Date.now() - started));
      const handle = (ev) => {
        if (ev.type === "content_block_start") {
          const b = ev.content_block || {};
          blocks[ev.index] = { type: b.type, json: "" };
          if (b.type === "web_search_tool_result" && Array.isArray(b.content)) b.content.forEach((r) => { if (r.url && sources.size < 12) sources.set(r.url, r.title || r.url); });
        } else if (ev.type === "content_block_delta") {
          const b = blocks[ev.index] || {};
          const d = ev.delta || {};
          if (d.type === "input_json_delta") b.json = (b.json || "") + (d.partial_json || "");
          else if (d.type === "text_delta") { text += d.text; if (mode === "chat") out.enqueue(sse({ t: "text", d: d.text })); }
          else if (d.type === "citations_delta" && d.citation && d.citation.url) sources.set(d.citation.url, d.citation.title || d.citation.url);
        } else if (ev.type === "content_block_stop") {
          const b = blocks[ev.index];
          if (b && b.type === "server_tool_use") { try { const inp = JSON.parse(b.json || "{}"); if (inp.query) out.enqueue(sse({ t: "search", q: inp.query })); } catch (e) {} }
        }
      };
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const line = chunk.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            try { handle(JSON.parse(line.slice(6))); } catch (e) {}
          }
        }
        const src = [...sources].map(([url, titre]) => ({ url, titre }));
        // contrôle automatique : cotes réelles, value recalculée, règles de sécurité
        if (mode !== "chat") { const j = extractJson(text); if (j) text = wrapJson(mode === "match" ? validateMatch(j, body.match) : validateTicket(j)); }
        if (cacheKey && store && /```json/.test(text)) {
          try { await store.setJSON(cacheKey, { ts: Date.now(), text, sources: src }); } catch (e) {}
          try { await recordPick(body.match, text); } catch (e) {}
          try { await recordOutsider(body.match, extractJson(text)); } catch (e) {}
        }
        out.enqueue(sse({ t: "done", text, sources: src, cached: false, left: q.left }));
      } catch (e) {
        out.enqueue(sse({ t: "error", error: ctrl.signal.aborted ? "timeout" : "stream_error" }));
      } finally {
        clearTimeout(timer);
        out.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
};
