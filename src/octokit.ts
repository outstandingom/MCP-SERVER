import { Octokit } from "@octokit/rest";
import { config } from "./config.js";

export function getOctokit(): Octokit {
  if (!config.GITHUB_TOKEN) {
    throw new Error(
      "GITHUB_TOKEN is not configured. Please set GITHUB_TOKEN in your .env or environment."
    );
  }

  return new Octokit({
    auth: config.GITHUB_TOKEN,
  });
}

export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
