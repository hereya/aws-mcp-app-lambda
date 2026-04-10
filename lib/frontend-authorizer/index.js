const crypto = require("crypto");
const https = require("https");

// ---------------------------------------------------------------------------
// Cognito JWKS caching
// ---------------------------------------------------------------------------

let cachedJwks = null;
let jwksCachedAt = 0;
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

async function getJwks() {
  const now = Date.now();
  if (cachedJwks && now - jwksCachedAt < JWKS_CACHE_TTL_MS) return cachedJwks;
  const region = process.env.COGNITO_REGION;
  const poolId = process.env.COGNITO_USER_POOL_ID;
  const jwks = await fetchJson(
    `https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`
  );
  cachedJwks = jwks;
  jwksCachedAt = now;
  return jwks;
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

function base64urlDecode(str) {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function verifyRS256(token, jwk) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  const key = crypto.createPublicKey({
    key: { kty: jwk.kty, n: jwk.n, e: jwk.e },
    format: "jwk",
  });
  const signature = base64urlDecode(signatureB64);
  const isValid = crypto.verify(
    "sha256",
    Buffer.from(`${headerB64}.${payloadB64}`),
    { key, padding: crypto.constants.RSA_PKCS1_PADDING },
    signature
  );
  if (!isValid) return null;
  return JSON.parse(base64urlDecode(payloadB64).toString());
}

// ---------------------------------------------------------------------------
// Cookie parsing
// ---------------------------------------------------------------------------

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(";").forEach((pair) => {
    const [name, ...rest] = pair.trim().split("=");
    if (name) cookies[name.trim()] = rest.join("=").trim();
  });
  return cookies;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

exports.handler = async function (event) {
  // Extract hereya_id_token from Cookie header
  const cookieHeader =
    event.headers?.cookie ?? event.headers?.Cookie ?? "";
  const cookies = parseCookies(cookieHeader);
  const token = cookies["hereya_id_token"];

  if (token) {
    try {
      const headerB64 = token.split(".")[0];
      const header = JSON.parse(base64urlDecode(headerB64).toString());
      if (header.alg !== "RS256") {
        // Invalid algorithm — allow as public (Org Lambda checks public flag)
        return {
          isAuthorized: true,
          context: { email: "", cognito_sub: "", public: "true" },
        };
      }

      const jwks = await getJwks();
      const jwk = header.kid
        ? jwks.keys.find((k) => k.kid === header.kid)
        : jwks.keys[0];
      if (!jwk) {
        return {
          isAuthorized: true,
          context: { email: "", cognito_sub: "", public: "true" },
        };
      }

      const payload = verifyRS256(token, jwk);
      if (!payload) {
        return {
          isAuthorized: true,
          context: { email: "", cognito_sub: "", public: "true" },
        };
      }

      // Check expiration
      const now = Math.floor(Date.now() / 1000);
      if (typeof payload.exp === "number" && payload.exp < now) {
        return {
          isAuthorized: true,
          context: { email: "", cognito_sub: "", public: "true" },
        };
      }

      // Valid JWT — extract user info
      return {
        isAuthorized: true,
        context: {
          email: String(payload.email ?? ""),
          cognito_sub: String(payload.sub ?? ""),
          public: "false",
        },
      };
    } catch {
      // JWT validation failed — allow as public
      return {
        isAuthorized: true,
        context: { email: "", cognito_sub: "", public: "true" },
      };
    }
  }

  // No cookie — allow as public (Org Lambda checks public flag per endpoint)
  return {
    isAuthorized: true,
    context: { email: "", cognito_sub: "", public: "true" },
  };
};
