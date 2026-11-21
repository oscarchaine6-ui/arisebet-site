// GET /.netlify/functions/track : bilan public de l'IA + combiné du jour (lecture seule).
import { getStore } from "@netlify/blobs";

export default async () => {
  const st = getStore("arisebet-track");
  const day = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
  let summary = null, today = null;
  try { summary = await st.get("summary", { type: "json" }); } catch (e) {}
  try { today = await st.get(`daily/${day}`, { type: "json" }); } catch (e) {}
  return Response.json({ summary, today }, { headers: { "cache-control": "public, max-age=120" } });
};
