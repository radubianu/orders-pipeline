import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

// Single shared pool. Neon's connection string already carries sslmode=require,
// so no Neon-specific client config is needed here -- this is a plain pg Pool.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
