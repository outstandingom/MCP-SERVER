import dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  PORT: number;
  GITHUB_TOKEN: string;
  GITHUB_USERNAME: string;
  MCP_API_KEY: string;
  BASE_URL: string;
}

export function loadConfig(): AppConfig {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim() || "";
  const GITHUB_USERNAME = process.env.GITHUB_USERNAME?.trim() || "";
  const MCP_API_KEY = process.env.MCP_API_KEY?.trim() || "";
  const PORT = parseInt(process.env.PORT || "3000", 10);
  const BASE_URL = process.env.BASE_URL?.trim() || `http://localhost:${PORT}`;

  const missing: string[] = [];
  if (!GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  if (!GITHUB_USERNAME) missing.push("GITHUB_USERNAME");
  if (!MCP_API_KEY) missing.push("MCP_API_KEY");

  if (missing.length > 0) {
    console.warn(
      `\x1b[33m[CONFIG WARNING]\x1b[0m Missing recommended environment variables: ${missing.join(
        ", "
      )}.`
    );
    console.warn(
      `Please configure your .env file or host environment variables before production usage.\n`
    );
  }

  return {
    PORT,
    GITHUB_TOKEN,
    GITHUB_USERNAME,
    MCP_API_KEY,
    BASE_URL,
  };
}

export const config = loadConfig();
