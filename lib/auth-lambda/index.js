const {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
} = require("@aws-sdk/client-cognito-identity-provider");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const https = require("https");

const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.COGNITO_REGION,
});
const secretsClient = new SecretsManagerClient({});

const USER_POOL_CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const CUSTOM_DOMAIN = process.env.CUSTOM_DOMAIN;

function getSenderEmail() {
  // customDomain = "jnj-space.hereyalab.dev" → "auth.jnj-space@hereyalab.dev"
  const parts = (CUSTOM_DOMAIN || "").split(".");
  const org = parts[0];
  const rootDomain = parts.slice(1).join(".");
  return `auth.${org}@${rootDomain}`;
}

// ---------------------------------------------------------------------------
// Secrets resolution (same pattern as main handler)
// ---------------------------------------------------------------------------

let secretsResolved = false;

async function resolveSecrets() {
  if (secretsResolved) return;
  const keys = (process.env.SECRET_KEYS || "").split(",").filter(Boolean);
  for (const key of keys) {
    const secretName = process.env[key];
    if (!secretName) continue;
    try {
      const result = await secretsClient.send(
        new GetSecretValueCommand({ SecretId: secretName })
      );
      process.env[key] = result.SecretString;
    } catch (err) {
      console.error(`Failed to resolve secret ${key}:`, err);
    }
  }
  secretsResolved = true;
}

// ---------------------------------------------------------------------------
// Postmark email sending
// ---------------------------------------------------------------------------

function sendPostmarkEmail(to, subject, htmlBody) {
  const serverKey = process.env.postmarkServerKey || process.env.POSTMARK_SERVER_KEY;
  if (!serverKey) {
    console.error("No Postmark server key available");
    return Promise.resolve();
  }

  const payload = JSON.stringify({
    From: getSenderEmail(),
    To: to,
    Subject: subject,
    HtmlBody: htmlBody,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.postmarkapp.com",
        path: "/email",
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": serverKey,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// HTML templates
// ---------------------------------------------------------------------------

function loginPage(returnUrl, error) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f8f9fa;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.08);
            padding: 40px; width: 100%; max-width: 400px; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; color: #111; }
    p { color: #666; margin-bottom: 24px; font-size: 0.9rem; }
    label { display: block; font-size: 0.85rem; font-weight: 500; color: #333; margin-bottom: 6px; }
    input[type=email] { width: 100%; padding: 10px 14px; border: 1px solid #ddd; border-radius: 8px;
                         font-size: 1rem; outline: none; }
    input[type=email]:focus { border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79,70,229,.1); }
    button { width: 100%; padding: 12px; background: #4f46e5; color: #fff; border: none;
             border-radius: 8px; font-size: 1rem; font-weight: 500; cursor: pointer; margin-top: 16px; }
    button:hover { background: #4338ca; }
    .error { color: #dc2626; font-size: 0.85rem; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Sign in</h1>
    <p>Enter your email to receive a one-time code.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="POST" action="send-otp">
      <input type="hidden" name="return_url" value="${escapeHtml(returnUrl || "")}">
      <label for="email">Email address</label>
      <input type="email" id="email" name="email" required autofocus placeholder="you@example.com">
      <button type="submit">Continue</button>
    </form>
  </div>
</body>
</html>`;
}

function otpPage(session, email, returnUrl, error) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Enter code</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f8f9fa;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.08);
            padding: 40px; width: 100%; max-width: 400px; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; color: #111; }
    p { color: #666; margin-bottom: 24px; font-size: 0.9rem; }
    label { display: block; font-size: 0.85rem; font-weight: 500; color: #333; margin-bottom: 6px; }
    input[type=text] { width: 100%; padding: 10px 14px; border: 1px solid #ddd; border-radius: 8px;
                        font-size: 1.5rem; text-align: center; letter-spacing: 0.3em; outline: none; }
    input[type=text]:focus { border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79,70,229,.1); }
    button { width: 100%; padding: 12px; background: #4f46e5; color: #fff; border: none;
             border-radius: 8px; font-size: 1rem; font-weight: 500; cursor: pointer; margin-top: 16px; }
    button:hover { background: #4338ca; }
    .error { color: #dc2626; font-size: 0.85rem; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Check your email</h1>
    <p>We sent a 6-digit code to <strong>${escapeHtml(email)}</strong>.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="POST" action="verify">
      <input type="hidden" name="session" value="${escapeHtml(session)}">
      <input type="hidden" name="email" value="${escapeHtml(email)}">
      <input type="hidden" name="return_url" value="${escapeHtml(returnUrl || "")}">
      <label for="otp">Verification code</label>
      <input type="text" id="otp" name="otp" required autofocus maxlength="6" pattern="[0-9]{6}"
             inputmode="numeric" autocomplete="one-time-code" placeholder="000000">
      <button type="submit">Verify</button>
    </form>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseBody(event) {
  const body = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString()
    : event.body || "";
  return Object.fromEntries(new URLSearchParams(body).entries());
}

function htmlResponse(statusCode, html) {
  return {
    statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: html,
  };
}

// Extract the app name from path: /{app}/auth/... → app
function extractApp(rawPath) {
  const match = rawPath.match(/^\/([a-z][a-z0-9_-]*)\/auth\//i);
  return match ? match[1] : null;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(";").forEach((pair) => {
    const [name, ...rest] = pair.trim().split("=");
    if (name) cookies[name.trim()] = rest.join("=").trim();
  });
  return cookies;
}

function isValidJwt(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const padded = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    return !(typeof payload.exp === "number" && payload.exp < now);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleLogin(event) {
  const returnUrl = event.queryStringParameters?.return_url || "";

  // If user already has a valid JWT cookie, redirect to return_url or root
  const cookieHeader = event.headers?.cookie ?? event.headers?.Cookie ?? "";
  const cookies = parseCookies(cookieHeader);
  if (cookies["hereya_id_token"] && isValidJwt(cookies["hereya_id_token"])) {
    return {
      statusCode: 302,
      headers: { Location: returnUrl || "/" },
      body: "",
    };
  }

  return htmlResponse(200, loginPage(returnUrl));
}

async function handleSendOtp(event) {
  const params = parseBody(event);
  const email = params.email;
  const returnUrl = params.return_url || "";

  if (!email) {
    return htmlResponse(400, loginPage(returnUrl, "Email is required."));
  }

  try {
    // No auto-signup — only pre-registered users can log in.
    // Users are added by the agent via the add-user MCP tool.
    const result = await cognitoClient.send(
      new InitiateAuthCommand({
        AuthFlow: "CUSTOM_AUTH",
        ClientId: USER_POOL_CLIENT_ID,
        AuthParameters: {
          USERNAME: email,
        },
      })
    );

    // aws/cognito returns OTP in ChallengeParameters — we send it via Postmark
    const otp = result.ChallengeParameters?.otp;
    if (otp) {
      await sendPostmarkEmail(
        email,
        "Your verification code",
        `<p>Your verification code is: <strong>${otp}</strong></p><p>This code expires in 5 minutes.</p>`
      );
    }

    const session = result.Session;
    return htmlResponse(200, otpPage(session, email, returnUrl));
  } catch (err) {
    console.error("InitiateAuth error:", err);
    if (err.name === "UserNotFoundException" || err.name === "NotAuthorizedException") {
      return htmlResponse(200, loginPage(returnUrl, "No account found for this email. Contact the app owner to get access."));
    }
    return htmlResponse(500, loginPage(returnUrl, "Failed to send code. Please try again."));
  }
}

async function handleVerify(event) {
  const params = parseBody(event);
  const { session, otp, email, return_url: returnUrl } = params;
  const app = extractApp(event.rawPath);

  if (!session || !otp || !email) {
    return htmlResponse(400, otpPage(session || "", email || "", returnUrl, "Missing required fields."));
  }

  try {
    const result = await cognitoClient.send(
      new RespondToAuthChallengeCommand({
        ChallengeName: "CUSTOM_CHALLENGE",
        ClientId: USER_POOL_CLIENT_ID,
        Session: session,
        ChallengeResponses: {
          USERNAME: email,
          ANSWER: otp,
        },
      })
    );

    if (result.AuthenticationResult?.IdToken) {
      const idToken = result.AuthenticationResult.IdToken;

      // Redirect path — no app prefix (CloudFront adds it from subdomain)
      const redirectPath = returnUrl || "/";

      return {
        statusCode: 302,
        headers: {
          Location: redirectPath,
          "Set-Cookie": `hereya_id_token=${idToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Domain=.${CUSTOM_DOMAIN}; Max-Age=86400`,
        },
        body: "",
      };
    }

    // Challenge not yet complete (shouldn't happen with correct OTP)
    if (result.Session) {
      return htmlResponse(
        200,
        otpPage(result.Session, email, returnUrl, "Incorrect code. Please try again.")
      );
    }

    return htmlResponse(500, loginPage(returnUrl, "Authentication failed."));
  } catch (err) {
    console.error("RespondToAuthChallenge error:", err);
    return htmlResponse(
      200,
      otpPage(session, email, returnUrl, "Incorrect code or session expired. Please try again.")
    );
  }
}

async function handleLogout(event) {
  return {
    statusCode: 302,
    headers: {
      Location: "/auth/login",
      "Set-Cookie": `hereya_id_token=; HttpOnly; Secure; SameSite=Strict; Path=/; Domain=.${CUSTOM_DOMAIN}; Max-Age=0`,
    },
    body: "",
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

exports.handler = async function (event) {
  const method = event.requestContext?.http?.method || "GET";
  const rawPath = event.rawPath || "";

  // Strip the /{app}/auth prefix to get the action
  const authMatch = rawPath.match(/\/[a-z][a-z0-9_-]*\/auth\/(.+)$/i);
  const action = authMatch ? authMatch[1] : "";

  await resolveSecrets();

  try {
    if (method === "GET" && action === "login") {
      return await handleLogin(event);
    }
    if (method === "POST" && action === "send-otp") {
      return await handleSendOtp(event);
    }
    if (method === "POST" && action === "verify") {
      return await handleVerify(event);
    }
    if (method === "GET" && action === "logout") {
      return await handleLogout(event);
    }

    return htmlResponse(404, "<h1>Not Found</h1>");
  } catch (err) {
    console.error("Auth Lambda error:", err);
    return htmlResponse(500, "<h1>Internal Server Error</h1>");
  }
};
