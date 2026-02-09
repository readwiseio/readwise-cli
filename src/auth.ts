import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { URL } from "node:url";
import open from "open";
import { loadConfig, saveConfig, type Config } from "./config.js";

const DISCOVERY_URL = "https://readwise.io/o/.well-known/oauth-authorization-server";
const REDIRECT_URI = "http://localhost:6274/callback";
const SCOPES = "openid read write";

interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

async function discover(): Promise<OAuthMetadata> {
  const res = await fetch(DISCOVERY_URL);
  if (!res.ok) throw new Error(`OAuth discovery failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as OAuthMetadata;
}

async function registerClient(registrationEndpoint: string): Promise<{ client_id: string; client_secret: string }> {
  const res = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "readwise-cli",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "client_secret_basic",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Client registration failed: ${res.status} ${body}`);
  }
  return (await res.json()) as { client_id: string; client_secret: string };
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function waitForCallback(state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout;

    const cleanup = () => {
      clearTimeout(timeout);
      server.close();
    };

    const server = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:6274`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body><h1>Login failed</h1><p>${error}</p><p>You can close this tab.</p></body></html>`);
        cleanup();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<html><body><h1>Invalid callback</h1><p>You can close this tab.</p></body></html>`);
        cleanup();
        reject(new Error("Invalid callback: missing code or state mismatch"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><h1>Login successful!</h1><p>You can close this tab and return to the terminal.</p></body></html>`);
      cleanup();
      resolve(code);
    });

    server.listen(6274, () => {
      // Server ready
    });

    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start callback server: ${err.message}`));
    });

    // Timeout after 2 minutes
    timeout = setTimeout(() => {
      server.close();
      reject(new Error("Login timed out — no callback received within 2 minutes"));
    }, 120_000);
  });
}

async function exchangeToken(
  tokenEndpoint: string,
  code: string,
  clientId: string,
  clientSecret: string,
  codeVerifier: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${body}`);
  }
  return (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
}

export async function login(): Promise<void> {
  console.log("Discovering OAuth endpoints...");
  const metadata = await discover();

  let config = await loadConfig();

  // Register client if needed
  if (!config.client_id || !config.client_secret) {
    console.log("Registering client...");
    const { client_id, client_secret } = await registerClient(metadata.registration_endpoint);
    config.client_id = client_id;
    config.client_secret = client_secret;
    await saveConfig(config);
  }

  const { verifier, challenge } = generatePKCE();
  const state = randomBytes(16).toString("hex");

  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", config.client_id);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  // Start callback server before opening browser
  const codePromise = waitForCallback(state);

  console.log("Opening browser for authentication...");
  await open(authUrl.toString());

  const code = await codePromise;

  console.log("Exchanging authorization code for tokens...");
  const tokens = await exchangeToken(
    metadata.token_endpoint,
    code,
    config.client_id,
    config.client_secret!,
    verifier,
  );

  config.access_token = tokens.access_token;
  config.refresh_token = tokens.refresh_token;
  config.expires_at = Date.now() + tokens.expires_in * 1000;
  config.auth_type = "oauth";
  await saveConfig(config);

  console.log("Login successful! Tokens saved to ~/.readwise-cli.json");
}

export async function loginWithToken(token: string): Promise<void> {
  const config = await loadConfig();
  config.access_token = token;
  config.auth_type = "token";
  delete config.refresh_token;
  delete config.expires_at;
  delete config.client_id;
  delete config.client_secret;
  await saveConfig(config);

  console.log("Token saved to ~/.readwise-cli.json");
}

export async function ensureValidToken(): Promise<{ token: string; authType: "oauth" | "token" }> {
  const config = await loadConfig();

  if (!config.access_token) {
    throw new Error("Not logged in. Run `readwise-cli login` or `readwise-cli login-with-token <token>` first.");
  }

  const authType = config.auth_type ?? "oauth";

  // Access tokens don't expire and don't need refresh
  if (authType === "token") {
    return { token: config.access_token, authType };
  }

  // Refresh if expired or expiring within 60s
  if (config.expires_at && Date.now() > config.expires_at - 60_000) {
    if (!config.refresh_token || !config.client_id || !config.client_secret) {
      throw new Error("Cannot refresh token — missing credentials. Run `readwise-cli login` again.");
    }

    console.error("Refreshing access token...");
    const metadata = await discover();

    const res = await fetch(metadata.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${config.client_id}:${config.client_secret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: config.refresh_token,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Token refresh failed: ${res.status} ${body}. Run \`readwise-cli login\` again.`);
    }

    const tokens = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    config.access_token = tokens.access_token;
    if (tokens.refresh_token) config.refresh_token = tokens.refresh_token;
    config.expires_at = Date.now() + tokens.expires_in * 1000;
    await saveConfig(config);
  }

  return { token: config.access_token, authType };
}
