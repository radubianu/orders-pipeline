import { pool } from "../db/pool";
import { requireEnv } from "./requireEnv";

const SCOPE = "com.intuit.quickbooks.accounting";
const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

// Refresh proactively this long before the access token's real expiry, so
// an in-flight request never gets caught using an already-dead token.
const ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 120;

function basicAuthHeader(): string {
  const id = requireEnv("QBO_CLIENT_ID");
  const secret = requireEnv("QBO_CLIENT_SECRET");
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: requireEnv("QBO_CLIENT_ID"),
    scope: SCOPE,
    redirect_uri: requireEnv("QBO_REDIRECT_URI"),
    response_type: "code",
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // access token lifetime, seconds (QBO: 3600)
  x_refresh_token_expires_in: number; // refresh token lifetime, seconds (QBO: ~100 days)
}

async function requestToken(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QBO token request failed (${res.status}): ${text}`);
  }

  return (await res.json()) as TokenResponse;
}

interface StoredTokenRow {
  realm_id: string;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: Date;
  refresh_token_expires_at: Date;
}

async function saveTokens(
  realmId: string,
  token: TokenResponse
): Promise<StoredTokenRow> {
  const now = Date.now();
  const accessTokenExpiresAt = new Date(now + token.expires_in * 1000);
  const refreshTokenExpiresAt = new Date(
    now + token.x_refresh_token_expires_in * 1000
  );

  await pool.query(
    `INSERT INTO qbo_tokens
       (realm_id, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (realm_id) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       access_token_expires_at = EXCLUDED.access_token_expires_at,
       refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
       updated_at = now()`,
    [
      realmId,
      token.access_token,
      token.refresh_token,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
    ]
  );

  return {
    realm_id: realmId,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    access_token_expires_at: accessTokenExpiresAt,
    refresh_token_expires_at: refreshTokenExpiresAt,
  };
}

/** Exchanges an authorization code (from the /quickbooks/callback redirect) for tokens and persists them. */
export async function exchangeCodeForTokens(
  code: string,
  realmId: string
): Promise<void> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: requireEnv("QBO_REDIRECT_URI"),
  });
  const token = await requestToken(body);
  await saveTokens(realmId, token);
}

/**
 * Refreshes the access token using the stored refresh token. QBO rotates
 * the refresh token on every use (the previous one stops working
 * immediately), so the new refresh_token from the response must be
 * persisted too, not just the new access_token.
 */
async function refreshTokens(
  realmId: string,
  refreshToken: string
): Promise<StoredTokenRow> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const token = await requestToken(body);
  return saveTokens(realmId, token);
}

/**
 * Returns a valid (realmId, accessToken) pair for calling the QBO API,
 * refreshing first if the stored access token is expired or close to it.
 * This is the only function callers should use -- never read qbo_tokens
 * directly, since that bypasses the refresh check.
 */
export async function getValidAccessToken(): Promise<{
  realmId: string;
  accessToken: string;
}> {
  const { rows } = await pool.query<StoredTokenRow>(
    `SELECT realm_id, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at
     FROM qbo_tokens
     ORDER BY updated_at DESC
     LIMIT 1`
  );

  const row = rows[0];
  if (!row) {
    throw new Error(
      "no QuickBooks connection found -- complete the OAuth flow at /quickbooks/connect first"
    );
  }

  if (new Date(row.refresh_token_expires_at).getTime() <= Date.now()) {
    throw new Error(
      "QuickBooks refresh token has expired (100-day absolute lifetime) -- reconnect at /quickbooks/connect"
    );
  }

  const skewedExpiry =
    new Date(row.access_token_expires_at).getTime() -
    ACCESS_TOKEN_REFRESH_SKEW_SECONDS * 1000;
  if (Date.now() < skewedExpiry) {
    return { realmId: row.realm_id, accessToken: row.access_token };
  }

  const refreshed = await refreshTokens(row.realm_id, row.refresh_token);
  return { realmId: refreshed.realm_id, accessToken: refreshed.access_token };
}
