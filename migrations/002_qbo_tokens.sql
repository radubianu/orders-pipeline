-- Stores the OAuth2 token set for the connected QuickBooks Online company.
-- realm_id is QBO's company identifier; PK'd on it since this integration
-- targets a single company, but the table supports more if ever needed.
CREATE TABLE qbo_tokens (
  realm_id                  TEXT PRIMARY KEY,
  access_token              TEXT NOT NULL,
  refresh_token             TEXT NOT NULL,
  access_token_expires_at   TIMESTAMPTZ NOT NULL,
  refresh_token_expires_at  TIMESTAMPTZ NOT NULL,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
