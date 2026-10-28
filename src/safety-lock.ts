import crypto from "crypto";
import { getOctokit, formatError } from "./octokit.js";

export type DeletionType = "file" | "branch" | "repository";

export interface PendingDeletion {
  id: string;
  code: string;
  type: DeletionType;
  owner: string;
  repo: string;
  target: string; // file path, branch name, or repo name
  branch?: string; // specific branch for file deletion
  sha?: string;
  createdAt: number;
  expiresAt: number;
}

class SafetyLockManager {
  private pendingRequests: Map<string, PendingDeletion> = new Map();
  private readonly TTL_MS = 5 * 60 * 1000; // 5 minutes TTL

  constructor() {
    // Periodically prune expired requests every 60 seconds
    setInterval(() => this.pruneExpired(), 60000).unref();
  }

  private pruneExpired() {
    const now = Date.now();
    for (const [id, req] of this.pendingRequests.entries()) {
      if (now > req.expiresAt) {
        this.pendingRequests.delete(id);
      }
    }
  }

  /**
   * Generates a 6-digit confirmation code and stores the pending deletion request.
   */
  public createPendingDeletion(params: {
    type: DeletionType;
    owner: string;
    repo: string;
    target: string;
    branch?: string;
    sha?: string;
  }): {
    pendingId: string;
    confirmationCode: string;
    expiresInSeconds: number;
    warning: string;
  } {
    const id = crypto.randomUUID();
    const code = crypto.randomInt(100000, 1000000).toString();
    const now = Date.now();
    const expiresAt = now + this.TTL_MS;

    const record: PendingDeletion = {
      id,
      code,
      type: params.type,
      owner: params.owner,
      repo: params.repo,
      target: params.target,
      branch: params.branch,
      sha: params.sha,
      createdAt: now,
      expiresAt,
    };

    this.pendingRequests.set(id, record);

    return {
      pendingId: id,
      confirmationCode: code,
      expiresInSeconds: Math.floor(this.TTL_MS / 1000),
      warning: `[CRITICAL SAFETY LOCK] You requested the permanent deletion of ${params.type} "${params.target}" in ${params.owner}/${params.repo}. To execute this destructive operation, the user must explicitly confirm with 6-digit code: ${code}. The code expires in 5 minutes.`,
    };
  }

  /**
   * Verifies the 6-digit confirmation code and executes the destructive GitHub operation.
   */
  public async executePendingDeletion(
    pendingId: string,
    confirmationCode: string
  ): Promise<{ success: boolean; message: string; details?: any }> {
    const record = this.pendingRequests.get(pendingId);

    if (!record) {
      throw new Error(
        `Invalid or expired deletion request ID: "${pendingId}". Please generate a new deletion request.`
      );
    }

    if (Date.now() > record.expiresAt) {
      this.pendingRequests.delete(pendingId);
      throw new Error(
        `The deletion confirmation code for request ID "${pendingId}" has expired (5-minute TTL exceeded). Please request deletion again.`
      );
    }

    if (record.code !== confirmationCode.trim()) {
      throw new Error(
        `Incorrect 6-digit confirmation code. Destructive deletion aborted.`
      );
    }

    const octokit = getOctokit();

    try {
      if (record.type === "file") {
        let fileSha = record.sha;
        const branch = record.branch;

        // If SHA wasn't supplied during initial request, fetch it now
        if (!fileSha) {
          const fileResp = await octokit.repos.getContent({
            owner: record.owner,
            repo: record.repo,
            path: record.target,
            ref: branch,
          });

          if (Array.isArray(fileResp.data) || !("sha" in fileResp.data)) {
            throw new Error(`Target path "${record.target}" is a directory, not a file.`);
          }
          fileSha = fileResp.data.sha;
        }

        await octokit.repos.deleteFile({
          owner: record.owner,
          repo: record.repo,
          path: record.target,
          message: `Delete ${record.target} via MCP Safety Lock`,
          sha: fileSha,
          branch,
        });

        this.pendingRequests.delete(pendingId);
        return {
          success: true,
          message: `Successfully deleted file "${record.target}" from ${record.owner}/${record.repo}${
            branch ? ` on branch "${branch}"` : ""
          }.`,
        };
      } else if (record.type === "branch") {
        await octokit.git.deleteRef({
          owner: record.owner,
          repo: record.repo,
          ref: `heads/${record.target.replace(/^refs\/heads\//, "")}`,
        });

        this.pendingRequests.delete(pendingId);
        return {
          success: true,
          message: `Successfully deleted branch "${record.target}" from repository ${record.owner}/${record.repo}.`,
        };
      } else if (record.type === "repository") {
        await octokit.repos.delete({
          owner: record.owner,
          repo: record.repo,
        });

        this.pendingRequests.delete(pendingId);
        return {
          success: true,
          message: `Successfully deleted repository ${record.owner}/${record.repo}.`,
        };
      } else {
        throw new Error(`Unknown deletion type: ${(record as any).type}`);
      }
    } catch (err: any) {
      throw new Error(`Deletion execution failed: ${formatError(err)}`);
    }
  }
}

export const safetyLock = new SafetyLockManager();
