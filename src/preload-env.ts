/**
 * Load .env before any other app modules read process.env (import order matters).
 */
import dotenv from "dotenv";
import path from "node:path";

const appRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(appRoot, ".env") });
