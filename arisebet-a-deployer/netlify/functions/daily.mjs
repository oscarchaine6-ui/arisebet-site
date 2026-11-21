// Tâche planifiée : 4 fois par jour, lance daily-run en arrière-plan (les tâches planifiées sont limitées à 30 s).
// Horaires en UTC : 7h, 12h, 17h, 22h UTC = 8h, 13h, 18h, 23h à Paris en hiver (9h, 14h, 19h, minuit en été).
import crypto from "node:crypto";

export default async () => {
  const secret = process.env.SESSION_SECRET;
  const base = process.env.URL;
  if (!secret || !base) { console.log("daily: SESSION_SECRET ou URL manquant"); return; }
  const day = new Date().toISOString().slice(0, 10);
  const sig = crypto.createHmac("sha256", secret).update("daily-run:" + day).digest("hex");
  const r = await fetch(`${base}/.netlify/functions/daily-run`, { method: "POST", headers: { "x-arisebet-cron": sig } });
  console.log("daily-run lancé :", r.status);
};

export const config = { schedule: "0 7,12,17,22 * * *" };
