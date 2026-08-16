import type { Json } from "./types.js";

const TOKEN_ENDPOINT = "https://login.uber.com/oauth/v2/token";
const SCOPE = "guests.trips";

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

function getEnv(name: string): string | undefined {
  return process.env[name]?.trim();
}

/**
 * Acquire an Uber OAuth 2.0 access token using the client credentials flow.
 * Caches the token in memory until expiry.
 * Never logs or writes credentials to disk.
 */
export async function acquireAccessToken(): Promise<string> {
  // 1. Check for direct access token
  const directToken = getEnv("UBER_ACCESS_TOKEN");
  if (directToken) {
    return directToken;
  }

  // 2. Check for cached token
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  // 3. OAuth client credentials flow
  const clientId = getEnv("UBER_CLIENT_ID");
  const clientSecret = getEnv("UBER_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    throw new Error(
      "Uber authentication requires either UBER_ACCESS_TOKEN (Bearer) or both UBER_CLIENT_ID and UBER_CLIENT_SECRET (OAuth client credentials).",
    );
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: SCOPE,
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const text = await response.text();
  let payload: Json;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const errPayload = payload as { error?: string; error_description?: string };
    const errCode = errPayload.error ?? `HTTP_${response.status}`;
    const errDesc = errPayload.error_description ?? "";

    // Provide actionable error messages for known failure modes
    if (errCode === "access_denied" && errDesc.includes("client secret mismatch")) {
      throw new Error(
        `Uber OAuth failed: client secret mismatch. The provided UBER_CLIENT_SECRET does not match UBER_CLIENT_ID. ` +
        `Please verify both values in the Uber Developer Dashboard (https://developer.uber.com/dashboard). ` +
        `If the app was recently created, ensure it is activated/published. ` +
        `If the secret was regenerated, use the new value.`,
      );
    }
    if (errCode === "unauthorized_client" && errDesc.includes("environment")) {
      throw new Error(
        `Uber OAuth failed: environment mismatch. The credentials may be for a different environment ` +
        `(sandbox vs production). Please verify the app environment in the Uber Developer Dashboard.`,
      );
    }
    if (errCode === "invalid_scope") {
      throw new Error(
        `Uber OAuth failed: invalid scope 'guests.trips'. ` +
        `Please ensure the app has the 'Guest Rides Estimates' scope enabled in the Uber Developer Dashboard.`,
      );
    }

    throw new Error(
      `Uber OAuth token endpoint returned ${response.status} (${errCode}): ${errDesc}`,
    );
  }

  const tokenData = payload as TokenResponse;
  cachedToken = {
    token: tokenData.access_token,
    expiresAt: Date.now() + (tokenData.expires_in - 60) * 1000, // 60s buffer
  };

  return tokenData.access_token;
}

/**
 * Clear the cached token (useful for testing or token revocation).
 */
export function clearCachedToken(): void {
  cachedToken = null;
}
