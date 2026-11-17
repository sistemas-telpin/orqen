// Loads api/.env when it exists (orqen passes these variables itself when it starts the API).
import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");
