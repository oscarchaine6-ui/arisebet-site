// Outils partagés côté serveur : probabilités sans marge (Shin) et consensus des bookmakers.
export const SHARP = { pinnacle: 4, betfair_ex_eu: 3, betfair_ex_uk: 3, matchbook: 3, smarkets: 2, lowvig: 2 };

export function shin(prices) {
  if (prices.length < 2) return prices.map(() => 1);
  const pi = prices.map((p) => 1 / p), sp = pi.reduce((a, b) => a + b, 0);
  const pz = (z) => pi.map((p) => (Math.sqrt(Math.max(z * z + 4 * (1 - z) * p * p / sp, 0)) - z) / (2 * (1 - z)));
  let lo = 0, hi = 0.49;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; pz(m).reduce((a, b) => a + b, 0) > 1 ? (lo = m) : (hi = m); }
  return pz((lo + hi) / 2);
}

// Consensus d'un match (marché vainqueur) : probabilités sans marge, meilleure cote, cote moyenne.
export function consensus(ev) {
  const H = ev.home_team, A = ev.away_team, F = { A: [], N: [], B: [] }, W = [], WN = [], best = {}, sum = { A: 0, N: 0, B: 0 }, cnt = { A: 0, N: 0, B: 0 };
  (ev.bookmakers || []).forEach((bk) => {
    const m = (bk.markets || []).find((x) => x.key === "h2h"); if (!m) return;
    let a = null, b = null, n = null;
    m.outcomes.forEach((o) => { if (o.name === H) a = o.price; else if (o.name === A) b = o.price; else if (/draw|nul/i.test(o.name)) n = o.price; });
    if (a == null || b == null) return;
    const pr = n != null ? [a, b, n] : [a, b], p = shin(pr), w = SHARP[bk.key] || 1;
    F.A.push(p[0]); F.B.push(p[1]); W.push(w); if (n != null) { F.N.push(p[2]); WN.push(w); }
    [["A", a], ["B", b], ["N", n]].forEach(([k, v]) => { if (v == null) return; sum[k] += v; cnt[k]++; if (!best[k] || v > best[k].price) best[k] = { price: v, book: bk.title }; });
  });
  if (!F.A.length) return null;
  const wm = (arr, w) => { let s = 0, t = 0; arr.forEach((v, i) => { s += v * w[i]; t += w[i]; }); return t ? s / t : 0; };
  let pA = wm(F.A, W), pB = wm(F.B, W), pN = F.N.length ? wm(F.N, WN) : 0; const T = pA + pB + pN;
  const avg = {}; ["A", "N", "B"].forEach((k) => { if (cnt[k]) avg[k] = Math.round((sum[k] / cnt[k]) * 100) / 100; });
  return { p: { A: pA / T, N: pN / T, B: pB / T }, best, avg, books: F.A.length, hasDraw: F.N.length > 0 };
}
