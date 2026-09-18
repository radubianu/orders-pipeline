// Import this first (side-effect only) in every entrypoint so DATABASE_URL
// etc. are populated from .env before anything else reads process.env.
import dotenv from "dotenv";

dotenv.config();
