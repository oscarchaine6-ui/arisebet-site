// POST /.netlify/functions/auth
//  - { credential }            → connexion : vérifie le jeton Google, crée la session Arisebet
//  - {} + Authorization Bearer → rafraîchit la session et revérifie le paiement
const { json, bearer, verifyGoogleCredential, signSession, verifySession, isPaid } = require("./lib/access");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });
  if (!process.env.SESSION_SECRET) return json(500, { error: "server_not_configured" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) {}

  let user = null;
  if (body.credential) user = await verifyGoogleCredential(body.credential);
  else if (bearer(event)) user = verifySession(bearer(event));
  if (!user) return json(401, { error: "invalid_credentials" });

  let paid;
  try { paid = await isPaid(user.email); }
  catch (e) { return json(502, { error: "payment_check_unavailable" }); }

  const { token, exp } = signSession(user);
  return json(200, { token, exp, paid, email: user.email, name: user.name, picture: user.picture, sub: user.sub });
};
