import * as crypto from "crypto";
import * as https from "https";

interface AuthorizerEvent {
  headers?: Record<string, string>;
  requestContext?: {
    http?: { method: string; path: string };
  };
}

interface AuthorizerResult {
  isAuthorized: boolean;
  context?: Record<string, string>;
}

interface JWK {
  kty: string;
  n: string;
  e: string;
  alg?: string;
  kid?: string;
  use?: string;
}

interface JWKS {
  keys: JWK[];
}

// Cache JWKS in Lambda memory (persists across warm invocations)
let cachedJwks: JWKS | null = null;
let jwksCachedAt = 0;
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function fetchJson(url: string): Promise<unknown> {
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

async function getJwks(): Promise<JWKS> {
  const now = Date.now();
  if (cachedJwks && now - jwksCachedAt < JWKS_CACHE_TTL_MS) {
    return cachedJwks;
  }

  const jwksUrl = `${process.env.OAUTH_SERVER_URL}/.well-known/jwks.json`;
  const jwks = (await fetchJson(jwksUrl)) as JWKS;
  cachedJwks = jwks;
  jwksCachedAt = now;
  return jwks;
}

function base64urlDecode(str: string): Buffer {
  // Add padding
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function verifyRS256(token: string, jwk: JWK): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;

  // Build the public key from JWK
  const key = crypto.createPublicKey({
    key: { kty: jwk.kty, n: jwk.n, e: jwk.e },
    format: "jwk",
  });

  // Verify signature
  const data = `${headerB64}.${payloadB64}`;
  const signature = base64urlDecode(signatureB64);

  const isValid = crypto.verify(
    "sha256",
    Buffer.from(data),
    { key, padding: crypto.constants.RSA_PKCS1_PADDING },
    signature
  );

  if (!isValid) return null;

  return JSON.parse(base64urlDecode(payloadB64).toString());
}

export async function handler(
  event: AuthorizerEvent
): Promise<AuthorizerResult> {
  const authHeader =
    event.headers?.authorization ?? event.headers?.Authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return { isAuthorized: false };
  }

  const token = authHeader.slice(7);

  try {
    // Decode header to get kid
    const headerB64 = token.split(".")[0];
    const header = JSON.parse(base64urlDecode(headerB64).toString()) as {
      alg: string;
      kid?: string;
    };

    if (header.alg !== "RS256") {
      return { isAuthorized: false };
    }

    // Fetch JWKS
    const jwks = await getJwks();

    // Find matching key
    const jwk = header.kid
      ? jwks.keys.find((k) => k.kid === header.kid)
      : jwks.keys[0];

    if (!jwk) {
      return { isAuthorized: false };
    }

    // Verify signature and decode
    const payload = verifyRS256(token, jwk);
    if (!payload) {
      return { isAuthorized: false };
    }

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === "number" && payload.exp < now) {
      return { isAuthorized: false };
    }

    // Check issuer
    if (payload.iss !== process.env.OAUTH_SERVER_URL) {
      return { isAuthorized: false };
    }

    // Check org_id matches bound org
    if (payload.org_id !== process.env.BOUND_ORG_ID) {
      return { isAuthorized: false };
    }

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
}
