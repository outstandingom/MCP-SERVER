import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "./config.js";
import { getOctokit, formatError } from "./octokit.js";
import { safetyLock, DeletionType } from "./safety-lock.js";

const getOwner = (specifiedOwner?: string) => {
  const owner = specifiedOwner?.trim() || config.GITHUB_USERNAME;
  if (!owner) {
    throw new Error(
      "Owner not specified and GITHUB_USERNAME is not set in environment."
    );
  }
  return owner;
};

export type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/**
 * Universal Tool Dispatcher.
 * Executes any tool whether invoked via MCP protocol or frontend testing REST API.
 */
export async function executeGitHubTool(
  toolName: string,
  args: Record<string, any> = {}
): Promise<ToolResponse> {
  const textContent = (text: string, isError = false): ToolResponse => ({
    isError,
    content: [{ type: "text" as const, text }],
  });
  try {
    switch (toolName) {
      case "list_repositories": {
        const octokit = getOctokit();
        const response = await octokit.repos.listForAuthenticatedUser({
          visibility: args.visibility || "all",
          sort: args.sort || "updated",
          direction: args.direction || "desc",
          per_page: args.per_page || 30,
          page: args.page || 1,
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
          content: [{ type: "text" as const, text: JSON.stringify(repos, null, 2) }],
        };
      }

      case "get_repository": {
        const octokit = getOctokit();
        const targetOwner = getOwner(args.owner);
        const { data } = await octokit.repos.get({
          owner: targetOwner,
          repo: args.repo,
        });

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
          content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }],
        };
      }

      case "create_repository": {
        const octokit = getOctokit();
        const { data } = await octokit.repos.createForAuthenticatedUser({
          name: args.name,
          description: args.description,
          private: args.is_private ?? true,
          auto_init: args.auto_init ?? true,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Repository created successfully:\nURL: ${data.html_url}\nClone: ${data.clone_url}\nDefault Branch: ${data.default_branch}`,
            },
          ],
        };
      }

      case "list_branches": {
        const octokit = getOctokit();
        const targetOwner = getOwner(args.owner);
        const { data } = await octokit.repos.listBranches({
          owner: targetOwner,
          repo: args.repo,
          per_page: args.per_page || 30,
        });

        const branches = data.map((b) => ({
          name: b.name,
          sha: b.commit.sha,
          protected: b.protected,
        }));

        return {
          content: [{ type: "text" as const, text: JSON.stringify(branches, null, 2) }],
        };
      }

      case "create_branch": {
        const octokit = getOctokit();
        const targetOwner = getOwner(args.owner);

        let baseBranch = args.from_branch;
        if (!baseBranch) {
          const repoInfo = await octokit.repos.get({
            owner: targetOwner,
            repo: args.repo,
          });
          baseBranch = repoInfo.data.default_branch;
        }

        const refData = await octokit.git.getRef({
          owner: targetOwner,
          repo: args.repo,
          ref: `heads/${baseBranch}`,
        });

        const sha = refData.data.object.sha;

        await octokit.git.createRef({
          owner: targetOwner,
          repo: args.repo,
          ref: `refs/heads/${args.branch}`,
          sha,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Branch "${args.branch}" created successfully on ${targetOwner}/${args.repo} from "${baseBranch}" (Commit SHA: ${sha}).`,
            },
          ],
        };
      }

      case "read_file": {
        const octokit = getOctokit();
        const targetOwner = getOwner(args.owner);

        const { data } = await octokit.repos.getContent({
          owner: targetOwner,
          repo: args.repo,
          path: args.path,
          ref: args.ref,
        });

        if (Array.isArray(data)) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Path "${args.path}" is a directory. Use "list_directory" to view contents.`,
              },
            ],
          };
        }

        if (!("content" in data) || data.type !== "file") {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Path "${args.path}" is not a readable file.`,
              },
            ],
          };
        }

        const decodedContent = Buffer.from(data.content, "base64").toString(
          "utf-8"
        );

        return {
          content: [{ type: "text" as const, text: decodedContent }],
        };
      }

      case "list_directory": {
        const octokit = getOctokit();
        const targetOwner = getOwner(args.owner);

        const { data } = await octokit.repos.getContent({
          owner: targetOwner,
          repo: args.repo,
          path: args.path || "",
          ref: args.ref,
        });

        if (!Array.isArray(data)) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Path "${args.path}" is a file, not a directory.`,
              },
            ],
          };
        }

        const items = data.map((item) => ({
          name: item.name,
          path: item.path,
          type: item.type,
          size: item.size,
          sha: item.sha,
        }));

        return {
          content: [{ type: "text" as const, text: JSON.stringify(items, null, 2) }],
        };
      }

      case "create_or_update_file": {
        const octokit = getOctokit();
        const targetOwner = getOwner(args.owner);

        let fileSha = args.sha;
        if (!fileSha) {
          try {
            const existing = await octokit.repos.getContent({
              owner: targetOwner,
              repo: args.repo,
              path: args.path,
              ref: args.branch,
            });
            if (!Array.isArray(existing.data) && "sha" in existing.data) {
              fileSha = existing.data.sha;
            }
          } catch {
            // File doesn't exist yet, creating new file
          }
        }

        const base64Content = Buffer.from(args.content, "utf-8").toString(
          "base64"
        );

        const { data } = await octokit.repos.createOrUpdateFileContents({
          owner: targetOwner,
          repo: args.repo,
          path: args.path,
          message: args.message,
          content: base64Content,
          branch: args.branch,
          sha: fileSha,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `File "${args.path}" committed successfully.\nCommit SHA: ${
                data.commit.sha
              }\nBranch: ${args.branch || "default"}`,
            },
          ],
        };
      }

      case "batch_commit_files": {
        const octokit = getOctokit();
        const targetOwner = getOwner(args.owner);

        const refResp = await octokit.git.getRef({
          owner: targetOwner,
          repo: args.repo,
          ref: `heads/${args.branch}`,
        });
        const latestCommitSha = refResp.data.object.sha;

        const commitResp = await octokit.git.getCommit({
          owner: targetOwner,
          repo: args.repo,
          commit_sha: latestCommitSha,
        });
        const baseTreeSha = commitResp.data.tree.sha;

        const treeItems: Array<{
          path: string;
          mode: "100644";
          type: "blob";
          sha: string;
        }> = [];

        for (const f of args.files) {
          const blobResp = await octokit.git.createBlob({
            owner: targetOwner,
            repo: args.repo,
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

        const newTreeResp = await octokit.git.createTree({
          owner: targetOwner,
          repo: args.repo,
          base_tree: baseTreeSha,
          tree: treeItems,
        });

        const newCommitResp = await octokit.git.createCommit({
          owner: targetOwner,
          repo: args.repo,
          message: args.message,
          tree: newTreeResp.data.sha,
          parents: [latestCommitSha],
        });

        await octokit.git.updateRef({
          owner: targetOwner,
          repo: args.repo,
          ref: `heads/${args.branch}`,
          sha: newCommitResp.data.sha,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Atomic commit successful!\nBranch: ${args.branch}\nFiles changed: ${args.files.length}\nCommit SHA: ${newCommitResp.data.sha}`,
            },
          ],
        };
      }

      case "list_pull_requests": {
        const octokit = getOctokit();
        const targetOwner = getOwner(args.owner);

        const { data } = await octokit.pulls.list({
          owner: targetOwner,
          repo: args.repo,
          state: args.state || "open",
          per_page: args.per_page || 30,
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
          content: [{ type: "text" as const, text: JSON.stringify(prs, null, 2) }],
        };
      }

      case "create_pull_request": {
        const octokit = getOctokit();
        const targetOwner = getOwner(args.owner);

        let baseBranch = args.base;
        if (!baseBranch) {
          const repoData = await octokit.repos.get({
            owner: targetOwner,
            repo: args.repo,
          });
          baseBranch = repoData.data.default_branch;
        }

        const { data } = await octokit.pulls.create({
          owner: targetOwner,
          repo: args.repo,
          title: args.title,
          body: args.body,
          head: args.head,
          base: baseBranch,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Pull Request #${data.number} created successfully!\nTitle: ${data.title}\nURL: ${data.html_url}\nState: ${data.state}`,
            },
          ],
        };
      }

      case "merge_pull_request": {
        const octokit = getOctokit();
        const targetOwner = getOwner(args.owner);

        const { data } = await octokit.pulls.merge({
          owner: targetOwner,
          repo: args.repo,
          pull_number: args.pull_number,
          commit_title: args.commit_title,
          merge_method: args.merge_method || "squash",
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Pull Request #${args.pull_number} merged successfully!\nMerged: ${data.merged}\nMessage: ${data.message}\nSHA: ${data.sha}`,
            },
          ],
        };
      }

      case "request_deletion": {
        const targetOwner = getOwner(args.owner);

        const result = safetyLock.createPendingDeletion({
          type: args.type as DeletionType,
          owner: targetOwner,
          repo: args.repo,
          target: args.target,
          branch: args.branch,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "PENDING_CONFIRMATION",
                  message: result.warning,
                  pendingId: result.pendingId,
                  confirmationCode: result.confirmationCode,
                  expiresInSeconds: result.expiresInSeconds,
                  instruction: `To proceed, confirm with code "${result.confirmationCode}", then invoke "confirm_deletion" with pending_id "${result.pendingId}" and confirmation_code "${result.confirmationCode}".`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "confirm_deletion": {
        const result = await safetyLock.executePendingDeletion(
          args.pending_id,
          args.confirmation_code
        );

        return {
          content: [
            {
              type: "text" as const,
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
      }

      default:
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Unknown tool: "${toolName}"` }],
        };
    }
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Error executing "${toolName}": ${formatError(err)}`,
        },
      ],
    };
  }
}

/**
 * Creates and configures a fresh McpServer instance with all GitHub tools.
 */
export function createGitHubMcpServer(): McpServer {
  const server = new McpServer({
    name: "github-lifetime-gateway",
    version: "1.0.0",
  });

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
      per_page: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Results per page (default: 30)"),
      page: z.number().min(1).optional().describe("Page number (default: 1)"),
    },
    async (args) => executeGitHubTool("list_repositories", args)
  );

  server.tool(
    "get_repository",
    "Get detailed metadata about a specific GitHub repository",
    {
      owner: z
        .string()
        .optional()
        .describe("Owner/organization name (defaults to GITHUB_USERNAME)"),
      repo: z.string().describe("Repository name"),
    },
    async (args) => executeGitHubTool("get_repository", args)
  );

  server.tool(
    "create_repository",
    "Create a new GitHub repository under your personal account",
    {
      name: z.string().describe("Repository name"),
      description: z.string().optional().describe("Repository description"),
      is_private: z
        .boolean()
        .optional()
        .describe("Whether repository should be private (default: true)"),
      auto_init: z
        .boolean()
        .optional()
        .describe("Initialize repository with README (default: true)"),
    },
    async (args) => executeGitHubTool("create_repository", args)
  );

  server.tool(
    "list_branches",
    "List all branches in a repository",
    {
      owner: z
        .string()
        .optional()
        .describe("Owner name (defaults to GITHUB_USERNAME)"),
      repo: z.string().describe("Repository name"),
      per_page: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Results per page (default: 30)"),
    },
    async (args) => executeGitHubTool("list_branches", args)
  );

  server.tool(
    "create_branch",
    "Create a new branch in a repository from an existing branch or commit SHA",
    {
      owner: z
        .string()
        .optional()
        .describe("Owner name (defaults to GITHUB_USERNAME)"),
      repo: z.string().describe("Repository name"),
      branch: z.string().describe("Name of the new branch to create"),
      from_branch: z
        .string()
        .optional()
        .describe(
          "Base branch name (defaults to repository default branch)"
        ),
    },
    async (args) => executeGitHubTool("create_branch", args)
  );

  server.tool(
    "read_file",
    "Read the content of a file from a repository",
    {
      owner: z
        .string()
        .optional()
        .describe("Owner name (defaults to GITHUB_USERNAME)"),
      repo: z.string().describe("Repository name"),
      path: z.string().describe("Path to the file in the repository"),
      ref: z
        .string()
        .optional()
        .describe(
          "The name of the commit/branch/tag (defaults to default branch)"
        ),
    },
    async (args) => executeGitHubTool("read_file", args)
  );

  server.tool(
    "list_directory",
    "List the contents of a directory in a repository",
    {
      owner: z
        .string()
        .optional()
        .describe("Owner name (defaults to GITHUB_USERNAME)"),
      repo: z.string().describe("Repository name"),
      path: z.string().optional().describe("Directory path (defaults to root)"),
      ref: z.string().optional().describe("Commit/branch/tag ref"),
    },
    async (args) => executeGitHubTool("list_directory", args)
  );

  server.tool(
    "create_or_update_file",
    "Create or update a single file in a repository",
    {
      owner: z
        .string()
        .optional()
        .describe("Owner name (defaults to GITHUB_USERNAME)"),
      repo: z.string().describe("Repository name"),
      path: z.string().describe("Path to the file"),
      content: z.string().describe("Text content of the file"),
      message: z.string().describe("Commit message"),
      branch: z
        .string()
        .optional()
        .describe(
          "Branch to commit to (defaults to repository default branch)"
        ),
      sha: z
        .string()
        .optional()
        .describe(
          "Blob SHA of file being replaced (auto-resolved if omitted)"
        ),
    },
    async (args) => executeGitHubTool("create_or_update_file", args)
  );

  server.tool(
    "batch_commit_files",
    "Commit multiple file changes atomically in a single commit using Git Database API",
    {
      owner: z
        .string()
        .optional()
        .describe("Owner name (defaults to GITHUB_USERNAME)"),
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
    async (args) => executeGitHubTool("batch_commit_files", args)
  );

  server.tool(
    "list_pull_requests",
    "List pull requests for a repository",
    {
      owner: z
        .string()
        .optional()
        .describe("Owner name (defaults to GITHUB_USERNAME)"),
      repo: z.string().describe("Repository name"),
      state: z
        .enum(["open", "closed", "all"])
        .optional()
        .describe("PR state filter (default: open)"),
      per_page: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Results per page (default: 30)"),
    },
    async (args) => executeGitHubTool("list_pull_requests", args)
  );

  server.tool(
    "create_pull_request",
    "Create a new pull request in a repository",
    {
      owner: z
        .string()
        .optional()
        .describe("Owner name (defaults to GITHUB_USERNAME)"),
      repo: z.string().describe("Repository name"),
      title: z.string().describe("Title of the pull request"),
      body: z
        .string()
        .optional()
        .describe("Description/body of the pull request"),
      head: z
        .string()
        .describe("Name of branch where your changes are implemented"),
      base: z
        .string()
        .optional()
        .describe(
          "Name of branch you want changes pulled into (defaults to default branch)"
        ),
    },
    async (args) => executeGitHubTool("create_pull_request", args)
  );

  server.tool(
    "merge_pull_request",
    "Merge an existing pull request",
    {
      owner: z
        .string()
        .optional()
        .describe("Owner name (defaults to GITHUB_USERNAME)"),
      repo: z.string().describe("Repository name"),
      pull_number: z.number().describe("Pull request number"),
      commit_title: z.string().optional().describe("Title for merge commit"),
      merge_method: z
        .enum(["merge", "squash", "rebase"])
        .optional()
        .describe("Merge method (default: squash)"),
    },
    async (args) => executeGitHubTool("merge_pull_request", args)
  );

  server.tool(
    "request_deletion",
    "STEP 1 OF SAFETY LOCK: Initiates a deletion request for a file, branch, or repository. Generates a secure, temporary 6-digit confirmation code required for execution.",
    {
      type: z
        .enum(["file", "branch", "repository"])
        .describe("Type of resource to delete"),
      owner: z
        .string()
        .optional()
        .describe("Owner name (defaults to GITHUB_USERNAME)"),
      repo: z.string().describe("Repository name"),
      target: z
        .string()
        .describe(
          "Target identifier (File path, branch name, or repository name)"
        ),
      branch: z
        .string()
        .optional()
        .describe(
          "Branch name (only needed if deleting a file on a non-default branch)"
        ),
    },
    async (args) => executeGitHubTool("request_deletion", args)
  );

  server.tool(
    "confirm_deletion",
    "STEP 2 OF SAFETY LOCK: Confirms and permanently executes the destructive deletion using the 6-digit confirmation code generated in Step 1.",
    {
      pending_id: z
        .string()
        .describe("The pendingId returned from request_deletion"),
      confirmation_code: z
        .string()
        .length(6)
        .describe("The 6-digit confirmation code"),
    },
    async (args) => executeGitHubTool("confirm_deletion", args)
  );

  return server;
}
