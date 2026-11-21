// Données vérifiées ESPN (gratuites) : derniers résultats datés de chaque équipe, domicile/extérieur.
// Elles sont données à l'IA comme base fiable, pour qu'elle ne parte pas d'une saison passée.
const MAP = {
  soccer_epl: ["soccer", "eng.1"], soccer_spain_la_liga: ["soccer", "esp.1"], soccer_italy_serie_a: ["soccer", "ita.1"],
  soccer_germany_bundesliga: ["soccer", "ger.1"], soccer_france_ligue_one: ["soccer", "fra.1"], soccer_france_ligue_two: ["soccer", "fra.2"],
  soccer_uefa_champs_league: ["soccer", "uefa.champions"], soccer_uefa_europa_league: ["soccer", "uefa.europa"], soccer_usa_mls: ["soccer", "usa.1"],
  soccer_netherlands_eredivisie: ["soccer", "ned.1"], soccer_portugal_primeira_liga: ["soccer", "por.1"],
  basketball_nba: ["basketball", "nba"], basketball_wnba: ["basketball", "wnba"], baseball_mlb: ["baseball", "mlb"],
  icehockey_nhl: ["hockey", "nhl"], americanfootball_nfl: ["football", "nfl"],
};
const BASE = "https://site.api.espn.com/apis/site/v2/sports";
const nrm = (x) => String(x || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\b(fc|cf|ac|as|sc|afc|club|de|the)\b/g, "").replace(/[^a-z0-9]/g, "");

async function getJson(url, ms = 6000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal }); return r.ok ? await r.json() : null; } catch (e) { return null; } finally { clearTimeout(t); }
}
const scoreOf = (c) => { const s = c && c.score; if (s == null) return null; if (typeof s === "object") return s.displayValue ?? (s.value != null ? String(s.value) : null); return String(s); };

function findTeam(teams, name) {
  const q = nrm(name); if (!q) return null;
  let best = null;
  for (const t of teams) {
    const c = [t.displayName, t.name, t.shortDisplayName, t.location, t.nickname].filter(Boolean).map(nrm);
    if (c.includes(q)) return t;
    if (!best && c.some((x) => x.length >= 4 && (x.includes(q) || q.includes(x)))) best = t;
  }
  return best;
}

function lastResults(sched, teamId, n = 6) {
  const evs = (sched && sched.events) || [];
  const done = evs.filter((e) => e.competitions && e.competitions[0] && e.competitions[0].status && e.competitions[0].status.type && e.competitions[0].status.type.completed);
  done.sort((a, b) => (a.date < b.date ? 1 : -1));
  return done.slice(0, n).map((e) => {
    const comp = e.competitions[0], me = comp.competitors.find((c) => String(c.team && c.team.id) === String(teamId)), op = comp.competitors.find((c) => c !== me);
    if (!me || !op) return null;
    const s1 = scoreOf(me), s2 = scoreOf(op), res = me.winner === true ? "V" : op.winner === true ? "D" : "N";
    const d = new Date(e.date).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit", timeZone: "Europe/Paris" });
    return `${d} ${res} ${s1}-${s2} ${me.homeAway === "home" ? "dom." : "ext."} vs ${op.team && op.team.displayName}`;
  }).filter(Boolean);
}

// Renvoie un texte prêt pour le prompt, ou "" si rien n'est disponible (tennis, ligue non couverte…).
export async function espnBrief(sportKey, home, away) {
  const map = MAP[sportKey]; if (!map) return "";
  const [s, l] = map;
  const list = await getJson(`${BASE}/${s}/${l}/teams?limit=200`);
  const teams = ((((list || {}).sports || [])[0] || {}).leagues || [])[0]?.teams?.map((x) => x.team).filter(Boolean) || [];
  const tA = findTeam(teams, home), tB = findTeam(teams, away);
  if (!tA && !tB) return "";
  const [sA, sB] = await Promise.all([tA ? getJson(`${BASE}/${s}/${l}/teams/${tA.id}/schedule`) : null, tB ? getJson(`${BASE}/${s}/${l}/teams/${tB.id}/schedule`) : null]);
  const lines = [];
  const fmt = (name, t, sc) => { if (!t || !sc) return; const r = lastResults(sc, t.id); if (r.length) { const f = r.slice(0, 5).map((x) => x.split(" ")[1]).join(" "); lines.push(`${name} — forme ${f} (du plus récent au plus ancien) :\n  ${r.join("\n  ")}`); } };
  fmt(home, tA, sA); fmt(away, tB, sB);
  return lines.length ? lines.join("\n") : "";
}
