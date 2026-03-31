const crypto = require("crypto");
const https = require("https");

let cachedJwks = null;
let jwksCachedAt = 0;
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

async function getJwks() {
  const now = Date.now();
  if (cachedJwks && now - jwksCachedAt < JWKS_CACHE_TTL_MS) return cachedJwks;
  const jwks = await fetchJson(`${process.env.OAUTH_SERVER_URL}/.well-known/jwks.json`);
  cachedJwks = jwks;
  jwksCachedAt = now;
  return jwks;
}

function base64urlDecode(str) {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function verifyRS256(token, jwk) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  const key = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" });
  const signature = base64urlDecode(signatureB64);
  const isValid = crypto.verify("sha256", Buffer.from(`${headerB64}.${payloadB64}`), { key, padding: crypto.constants.RSA_PKCS1_PADDING }, signature);
  if (!isValid) return null;
  return JSON.parse(base64urlDecode(payloadB64).toString());
}

exports.handler = async function (event) {
  const authHeader = event.headers?.authorization ?? event.headers?.Authorization;
  if (!authHeader?.startsWith("Bearer ")) return { isAuthorized: false };

  const token = authHeader.slice(7);
  try {
    const headerB64 = token.split(".")[0];
    const header = JSON.parse(base64urlDecode(headerB64).toString());
    if (header.alg !== "RS256") return { isAuthorized: false };

    const jwks = await getJwks();
    const jwk = header.kid ? jwks.keys.find((k) => k.kid === header.kid) : jwks.keys[0];
    if (!jwk) return { isAuthorized: false };

    const payload = verifyRS256(token, jwk);
    if (!payload) return { isAuthorized: false };

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === "number" && payload.exp < now) return { isAuthorized: false };
    if (payload.iss !== process.env.OAUTH_SERVER_URL) return { isAuthorized: false };
    if (payload.org_id !== process.env.BOUND_ORG_ID) return { isAuthorized: false };

    return {
      isAuthorized: true,
      context: {
        userId: String(payload.sub ?? ""),
        orgId: String(payload.org_id ?? ""),
        orgRole: String(payload.org_role ?? ""),
      },
    };
  } catch {
    return { isAuthorized: false };
  }
};
