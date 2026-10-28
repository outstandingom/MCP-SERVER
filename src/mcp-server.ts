import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "./config.js";
import { getOctokit, formatError } from "./octokit.js";
import { safetyLock, DeletionType } from "./safety-lock.js";

/**
 * Creates and configures a fresh McpServer instance with all GitHub tools.
 */
export function createGitHubMcpServer(): McpServer {
  const server = new McpServer({
    name: "github-lifetime-gateway",
    version: "1.0.0",
  });

  const getOwner = (specifiedOwner?: string) => {
    const owner = specifiedOwner?.trim() || config.GITHUB_USERNAME;
    if (!owner) {
      throw new Error(
        "Owner not specified and GITHUB_USERNAME is not set in environment."
      );
    }
    return owner;
  };

  // ==========================================
  // REPOSITORY & BRANCH TOOLS
  // ==========================================

  server.tool(
    "list_repositories",
    "List repositories accessible to the configured user or organization",
    {
      visibility: z
        .enum(["all", "public", "private"])
        .optional()
        .describe("Filter by visibility (default: all)"),
      sort: z
        .enum(["created", "updated", "pushed", "full_name"])
        .optional()
        .describe("Sort field (default: updated)"),
      direction: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
      per_page: z.number().min(1).max(100).optional().describe("Results per page (default: 30)"),
      page: z.number().min(1).optional().describe("Page number (default: 1)"),
    },
    async ({ visibility, sort, direction, per_page, page }) => {
      try {
        const octokit = getOctokit();
        const response = await octokit.repos.listForAuthenticatedUser({
          visibility: visibility || "all",
          sort: sort || "updated",
          direction: direction || "desc",
          per_page: per_page || 30,
          page: page || 1,
        });

        const repos = response.data.map((r) => ({
          name: r.name,
          full_name: r.full_name,
          private: r.private,
          description: r.description,
          default_branch: r.default_branch,
          html_url: r.html_url,
          updated_at: r.updated_at,
          open_issues_count: r.open_issues_count,
        }));

        return {
          content: [{ type: "text", text: JSON.stringify(repos, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to list repositories: ${formatError(err)}` }],
        };
      }
    }
  );

  server.tool(
    "get_repository",
    "Get detailed metadata about a specific GitHub repository",
    {
      owner: z.string().optional().describe("Owner/organization name (defaults to GITHUB_USERNAME)"),
      repo: z.string().describe("Repository name"),
    },
    async ({ owner, repo }) => {
      try {
        const octokit = getOctokit();
        const targetOwner = getOwner(owner);
        const { data } = await octokit.repos.get({ owner: targetOwner, repo });

        const info = {
          name: data.name,
          full_name: data.full_name,
          private: data.private,
          description: data.description,
          default_branch: data.default_branch,
          stars: data.stargazers_count,
          forks: data.forks_count,
          open_issues: data.open_issues_count,
          html_url: data.html_url,
          clone_url: data.clone_url,
          created_at: data.created_at,
          updated_at: data.updated_at,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to get repository: ${formatError(err)}` }],
        };
      }
    }
  );

  server.tool(
    "create_repository",
    "Create a new GitHub repository under your personal account",
    {
      name: z.string().describe("Repository name"),
      description: z.string().optional().describe("Repository description"),
      is_private: z.boolean().optional().describe("Whether repository should be private (default: true)"),
      auto_init: z.boolean().optional().describe("Initialize repository with README (default: true)"),
    },
    async ({ name, description, is_private = true, auto_init = true }) => {
      try {
        const octokit = getOctokit();
        const { data } = await octokit.repos.createForAuthenticatedUser({
          name,
          description,
          private: is_private,
          auto_init,
        });

        return {
          content: [
            {
              type: "text",
              text: `Repository created successfully:\nURL: ${data.html_url}\nClone: ${data.clone_url}\nDefault Branch: ${data.default_branch}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to create repository: ${formatError(err)}` }],
        };
      }
    }
  );

  server.tool(
    "list_branches",
    "List all branches in a repository",
    {
      owner: z.string().optional().describe("Owner name (defaults to GITHUB_USERNAME)"),
      repo: z.string().describe("Repository name"),
      per_page: z.number().min(1).max(100).optional().describe("Results per page (default: 30)"),
    },
    async ({ owner, repo, per_page }) => {
      try {
        const octokit = getOctokit();
        const targetOwner = getOwner(owner);
        const { data } = await octokit.repos.listBranches({
          owner: targetOwner,
          repo,
          per_page: per_page || 30,
        });

        const branches = data.map((b) => ({
          name: b.name,
          sha: b.commit.sha,
          protected: b.protected,
        }));

        return {
          content: [{ type: "text", text: JSON.stringify(branches, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to list branches: ${formatError(err)}` }],
        };
      }
    }
  );

  server.tool(
    "create_branch",
    "Create a new branch in a repository from an existing branch or commit SHA",
    {
      owner: z.string().optional().describe("Owner name (defaults to GITHUB_USERNAME)"),
      repo: z.string().describe("Repository name"),
      branch: z.string().describe("Name of the new branch to create"),
      from_branch: z.string().optional().describe("Base branch name (defaults to repository default branch)"),
    },
    async ({ owner, repo, branch, from_branch }) => {
      try {
        const octokit = getOctokit();
        const targetOwner = getOwner(owner);

        let baseBranch = from_branch;
        if (!baseBranch) {
          const repoInfo = await octokit.repos.get({ owner: targetOwner, repo });
          baseBranch = repoInfo.data.default_branch;
        }

        const refData = await octokit.git.getRef({
          owner: targetOwner,
          repo,
          ref: `heads/${baseBranch}`,
        });

        const sha = refData.data.object.sha;

        const newBranch = await octokit.git.createRef({
          owner: targetOwner,
          repo,
          ref: `refs/heads/${branch}`,
          sha,
        });

        return {
          content: [
            {
              type: "text",
              text: `Branch "${branch}" created successfully on ${targetOwner}/${repo} from "${baseBranch}" (Commit SHA: ${sha}).`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to create branch: ${formatError(err)}` }],
        };
      }
    }
  );

  // ==========================================
  // CODE & FILE OPERATIONS
  // ==========================================

  server.tool(
    "read_file",
    "Read the content of a file from a repository",
    {
      owner: z.string().optional().describe("Owner name (defaults to GITHUB_USERNAME)"),
      repo: z.string().describe("Repository name"),
      path: z.string().describe("Path to the file in the repository"),
      ref: z.string().optional().describe("The name of the commit/branch/tag (defaults to default branch)"),
    },
    async ({ owner, repo, path, ref }) => {
      try {
        const octokit = getOctokit();
        const targetOwner = getOwner(owner);

        const { data } = await octokit.repos.getContent({
          owner: targetOwner,
          repo,
          path,
          ref,
        });

        if (Array.isArray(data)) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Path "${path}" is a directory. Use "list_directory" to view contents.`,
              },
            ],
          };
        }

        if (!("content" in data) || data.type !== "file") {
          return {
            isError: true,
            content: [{ type: "text", text: `Path "${path}" is not a readable file.` }],
          };
        }

        const decodedContent = Buffer.from(data.content, "base64").toString("utf-8");

        return {
          content: [
            {
              type: "text",
              text: decodedContent,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to read file: ${formatError(err)}` }],
        };
      }
    }
  );

  server.tool(
    "list_directory",
    "List the contents of a directory in a repository",
    {
      owner: z.string().optional().describe("Owner name (defaults to GITHUB_USERNAME)"),
      repo: z.string().describe("Repository name"),
      path: z.string().optional().describe("Directory path (defaults to root)"),
      ref: z.string().optional().describe("Commit/branch/tag ref"),
    },
    async ({ owner, repo, path = "", ref }) => {
      try {
        const octokit = getOctokit();
        const targetOwner = getOwner(owner);

        const { data } = await octokit.repos.getContent({
          owner: targetOwner,
          repo,
          path,
          ref,
        });

        if (!Array.isArray(data)) {
          return {
            isError: true,
            content: [{ type: "text", text: `Path "${path}" is a file, not a directory.` }],
          };
        }

        const items = data.map((item) => ({
          name: item.name,
          path: item.path,
          type: item.type, // 'file' | 'dir' | 'submodule' | 'symlink'
          size: item.size,
          sha: item.sha,
        }));

        return {
          content: [{ type: "text", text: JSON.stringify(items, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to list directory: ${formatError(err)}` }],
        };
      }
    }
  );

  server.tool(
    "create_or_update_file",
    "Create or update a single file in a repository",
    {
      owner: z.string().optional().describe("Owner name (defaults to GITHUB_USERNAME)"),
      repo: z.string().describe("Repository name"),
      path: z.string().describe("Path to the file"),
      content: z.string().describe("Text content of the file"),
      message: z.string().describe("Commit message"),
      branch: z.string().optional().describe("Branch to commit to (defaults to repository default branch)"),
      sha: z.string().optional().describe("Blob SHA of file being replaced (auto-resolved if omitted)"),
    },
    async ({ owner, repo, path, content, message, branch, sha }) => {
      try {
        const octokit = getOctokit();
        const targetOwner = getOwner(owner);

        let fileSha = sha;
        if (!fileSha) {
          try {
            const existing = await octokit.repos.getContent({
              owner: targetOwner,
              repo,
              path,
              ref: branch,
            });
            if (!Array.isArray(existing.data) && "sha" in existing.data) {
              fileSha = existing.data.sha;
            }
          } catch {
            // File doesn't exist yet, creating new file
          }
        }

        const base64Content = Buffer.from(content, "utf-8").toString("base64");

        const { data } = await octokit.repos.createOrUpdateFileContents({
          owner: targetOwner,
          repo,
          path,
          message,
          content: base64Content,
          branch,
          sha: fileSha,
        });

        return {
          content: [
            {
              type: "text",
              text: `File "${path}" committed successfully.\nCommit SHA: ${data.commit.sha}\nBranch: ${
                branch || "default"
              }`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to commit file: ${formatError(err)}` }],
        };
      }
    }
  );

  server.tool(
    "batch_commit_files",
    "Commit multiple file changes atomically in a single commit using Git Database API",
    {
      owner: z.string().optional().describe("Owner name (defaults to GITHUB_USERNAME)"),
      repo: z.string().describe("Repository name"),
      branch: z.string().describe("Target branch to commit to"),
      message: z.string().describe("Commit message"),
      files: z
        .array(
          z.object({
            path: z.string().describe("Relative file path"),
            content: z.string().describe("File content string"),
          })
        )
        .describe("Array of files with path and content"),
    },
    async ({ owner, repo, branch, message, files }) => {
      try {
        const octokit = getOctokit();
        const targetOwner = getOwner(owner);

        // 1. Get branch reference
        const refResp = await octokit.git.getRef({
          owner: targetOwner,
          repo,
          ref: `heads/${branch}`,
        });
        const latestCommitSha = refResp.data.object.sha;

        // 2. Get base tree
        const commitResp = await octokit.git.getCommit({
          owner: targetOwner,
          repo,
          commit_sha: latestCommitSha,
        });
        const baseTreeSha = commitResp.data.tree.sha;

        // 3. Create blobs & tree entries
        const treeItems: Array<{
          path: string;
          mode: "100644";
          type: "blob";
          sha: string;
        }> = [];

        for (const f of files) {
          const blobResp = await octokit.git.createBlob({
            owner: targetOwner,
            repo,
            content: Buffer.from(f.content, "utf-8").toString("base64"),
            encoding: "base64",
          });

          treeItems.push({
            path: f.path,
            mode: "100644",
            type: "blob",
            sha: blobResp.data.sha,
          });
        }

        // 4. Create new tree
        const newTreeResp = await octokit.git.createTree({
          owner: targetOwner,
          repo,
          base_tree: baseTreeSha,
          tree: treeItems,
        });

        // 5. Create new commit
        const newCommitResp = await octokit.git.createCommit({
          owner: targetOwner,
          repo,
          message,
          tree: newTreeResp.data.sha,
          parents: [latestCommitSha],
        });

        // 6. Update reference
        await octokit.git.updateRef({
          owner: targetOwner,
          repo,
          ref: `heads/${branch}`,
          sha: newCommitResp.data.sha,
        });

        return {
          content: [
            {
              type: "text",
              text: `Atomic commit successful!\nBranch: ${branch}\nFiles changed: ${files.length}\nCommit SHA: ${newCommitResp.data.sha}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to execute batch commit: ${formatError(err)}` }],
        };
      }
    }
  );

  // ==========================================
  // PULL REQUEST TOOLS
  // ==========================================

  server.tool(
    "list_pull_requests",
    "List pull requests for a repository",
    {
      owner: z.string().optional().describe("Owner name (defaults to GITHUB_USERNAME)"),
      repo: z.string().describe("Repository name"),
      state: z.enum(["open", "closed", "all"]).optional().describe("PR state filter (default: open)"),
      per_page: z.number().min(1).max(100).optional().describe("Results per page (default: 30)"),
    },
    async ({ owner, repo, state = "open", per_page = 30 }) => {
      try {
        const octokit = getOctokit();
        const targetOwner = getOwner(owner);

        const { data } = await octokit.pulls.list({
          owner: targetOwner,
          repo,
          state,
          per_page,
        });

        const prs = data.map((p) => ({
          number: p.number,
          title: p.title,
          state: p.state,
          user: p.user?.login,
          head: p.head.ref,
          base: p.base.ref,
          html_url: p.html_url,
          created_at: p.created_at,
        }));

        return {
          content: [{ type: "text", text: JSON.stringify(prs, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to list pull requests: ${formatError(err)}` }],
        };
      }
    }
  );

  server.tool(
    "create_pull_request",
    "Create a new pull request in a repository",
    {
      owner: z.string().optional().describe("Owner name (defaults to GITHUB_USERNAME)"),
      repo: z.string().describe("Repository name"),
      title: z.string().describe("Title of the pull request"),
      body: z.string().optional().describe("Description/body of the pull request"),
      head: z.string().describe("Name of branch where your changes are implemented"),
      base: z.string().optional().describe("Name of branch you want changes pulled into (defaults to default branch)"),
    },
    async ({ owner, repo, title, body, head, base }) => {
      try {
        const octokit = getOctokit();
        const targetOwner = getOwner(owner);

        let baseBranch = base;
        if (!baseBranch) {
          const repoData = await octokit.repos.get({ owner: targetOwner, repo });
          baseBranch = repoData.data.default_branch;
        }

        const { data } = await octokit.pulls.create({
          owner: targetOwner,
          repo,
          title,
          body,
          head,
          base: baseBranch,
        });

        return {
          content: [
            {
              type: "text",
              text: `Pull Request #${data.number} created successfully!\nTitle: ${data.title}\nURL: ${data.html_url}\nState: ${data.state}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to create pull request: ${formatError(err)}` }],
        };
      }
    }
  );

  server.tool(
    "merge_pull_request",
    "Merge an existing pull request",
    {
      owner: z.string().optional().describe("Owner name (defaults to GITHUB_USERNAME)"),
      repo: z.string().describe("Repository name"),
      pull_number: z.number().describe("Pull request number"),
      commit_title: z.string().optional().describe("Title for merge commit"),
      merge_method: z.enum(["merge", "squash", "rebase"]).optional().describe("Merge method (default: squash)"),
    },
    async ({ owner, repo, pull_number, commit_title, merge_method = "squash" }) => {
      try {
        const octokit = getOctokit();
        const targetOwner = getOwner(owner);

        const { data } = await octokit.pulls.merge({
          owner: targetOwner,
          repo,
          pull_number,
          commit_title,
          merge_method,
        });

        return {
          content: [
            {
              type: "text",
              text: `Pull Request #${pull_number} merged successfully!\nMerged: ${data.merged}\nMessage: ${data.message}\nSHA: ${data.sha}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to merge pull request: ${formatError(err)}` }],
        };
      }
    }
  );

  // ==============================================================
  // TWO-STEP DELETION SAFETY LOCK (DESTRUCTIVE ACTIONS)
  // ==============================================================

  server.tool(
    "request_deletion",
    "STEP 1 OF SAFETY LOCK: Initiates a deletion request for a file, branch, or repository. Generates a secure, temporary 6-digit confirmation code required for execution.",
    {
      type: z.enum(["file", "branch", "repository"]).describe("Type of resource to delete"),
      owner: z.string().optional().describe("Owner name (defaults to GITHUB_USERNAME)"),
      repo: z.string().describe("Repository name"),
      target: z
        .string()
        .describe("Target identifier (File path, branch name, or repository name)"),
      branch: z
        .string()
        .optional()
        .describe("Branch name (only needed if deleting a file on a non-default branch)"),
    },
    async ({ type, owner, repo, target, branch }) => {
      try {
        const targetOwner = getOwner(owner);

        const result = safetyLock.createPendingDeletion({
          type: type as DeletionType,
          owner: targetOwner,
          repo,
          target,
          branch,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "PENDING_CONFIRMATION",
                  message: result.warning,
                  pendingId: result.pendingId,
                  confirmationCode: result.confirmationCode,
                  expiresInSeconds: result.expiresInSeconds,
                  instruction: `To proceed, ask the user to confirm using code "${result.confirmationCode}", then invoke the "confirm_deletion" tool with pendingId "${result.pendingId}" and confirmation_code "${result.confirmationCode}".`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to initiate deletion: ${formatError(err)}` }],
        };
      }
    }
  );

  server.tool(
    "confirm_deletion",
    "STEP 2 OF SAFETY LOCK: Confirms and permanently executes the destructive deletion using the 6-digit confirmation code generated in Step 1.",
    {
      pending_id: z.string().describe("The pendingId returned from request_deletion"),
      confirmation_code: z.string().length(6).describe("The 6-digit confirmation code"),
    },
    async ({ pending_id, confirmation_code }) => {
      try {
        const result = await safetyLock.executePendingDeletion(pending_id, confirmation_code);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "DELETED_SUCCESSFULLY",
                  message: result.message,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Destructive action aborted: ${formatError(err)}` }],
        };
      }
    }
  );

  return server;
}
