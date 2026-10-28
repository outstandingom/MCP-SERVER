# GitHub Lifetime Model Context Protocol (MCP) Server

A production-ready, lifetime-reusable MCP gateway built with **Express**, **TypeScript**, **@modelcontextprotocol/sdk**, and **Octokit**.

It enables any AI agent (Claude Desktop, Cursor, Antigravity, Open-source LLM agents) to securely read, write, branch, commit, pull request, and merge code across your GitHub repositories.

---

## 🔒 Security Architecture

### 1. Zero Account Permissions
- The server does **not** require nor request account administration permissions.
- Recommended token: **GitHub Fine-Grained Personal Access Token (Beta)** scoped only to target repositories with:
  - **Contents**: `Read and write`
  - **Pull requests**: `Read and write`
  - **Account permissions**: `0 / None` (Protecting personal profile, SSH keys, billing, and org settings).

### 2. Two-Step Deletion Safety Lock (Destructive Operations Guard)
- To prevent accidental data loss from AI hallucinations, destructive operations (`delete_file`, `delete_branch`, `delete_repo`) are locked behind a two-step human approval flow:
  1. **Step 1 (`request_deletion`)**: The agent initiates a deletion request. The server generates a cryptographically secure 6-digit confirmation code with a 5-minute TTL.
  2. **Step 2 (`confirm_deletion`)**: The human reviews the action and provides the 6-digit code. The agent passes the code back to the server to execute the deletion.

### 3. API Key Protection (`MCP_API_KEY`)
- All incoming MCP traffic (`/sse` and `/messages`) is guarded by your private `MCP_API_KEY`.
- Supports `Authorization: Bearer <key>`, `X-MCP-API-KEY: <key>`, or `?apiKey=<key>`.

---

## 🛠️ MCP Tools Overview

| Tool Name | Type | Description |
|---|---|---|
| `list_repositories` | Query | List repositories accessible to the user (filtered by visibility/sort) |
| `get_repository` | Query | Get complete repo details, stars, forks, default branch |
| `create_repository` | Action | Create a new private/public GitHub repository |
| `list_branches` | Query | List branches and head commit SHAs |
| `create_branch` | Action | Create a new branch from a base branch or commit SHA |
| `read_file` | Query | Read file content from any branch/tag/ref (utf-8 decoded) |
| `list_directory` | Query | Inspect folder structure and file sizes |
| `create_or_update_file` | Action | Commit a single file change to a branch |
| `batch_commit_files` | Action | Atomically commit multiple file changes via Git Database API |
| `list_pull_requests` | Query | List open, closed, or all pull requests |
| `create_pull_request` | Action | Open a pull request between branches |
| `merge_pull_request` | Action | Merge or squash a pull request |
| `request_deletion` | Safety Lock (Step 1) | Request deletion of file/branch/repo and receive a 6-digit code |
| `confirm_deletion` | Safety Lock (Step 2) | Provide 6-digit code to execute permanent deletion |

---

## ⚙️ Environment Variables

Create a `.env` file in the project root:

```env
# GitHub Token (Fine-Grained PAT with Contents: R/W, Pull Requests: R/W)
GITHUB_TOKEN=github_pat_xxxx

# GitHub Username
GITHUB_USERNAME=outstandingom

# Secret API Key to authenticate MCP clients
MCP_API_KEY=your-secure-mcp-api-key-here

# Server Port (default: 3000)
PORT=3000

# Base URL (default: http://localhost:3000)
BASE_URL=http://localhost:3000
```

---

## 🚀 Local Development & Testing

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Run in development mode with hot reload (`tsx`)**:
   ```bash
   npm run dev
   ```

3. **Verify the server is running**:
   ```bash
   curl http://localhost:3000/health
   ```

4. **Build for production**:
   ```bash
   npm run build
   npm start
   ```

---

## ☁️ Deployment

### Deploy to Railway
1. Push this repository to GitHub.
2. Log in to [Railway.app](https://railway.app/) and click **New Project** > **Deploy from GitHub repo**.
3. Select this repository.
4. Add the Environment Variables:
   - `GITHUB_TOKEN`
   - `GITHUB_USERNAME`
   - `MCP_API_KEY`
   - `PORT=3000`
5. Railway will automatically build and deploy using the included `Dockerfile` or Node buildpack.

### Deploy to Render
1. Log in to [Render.com](https://render.com/) and create a **New Web Service**.
2. Connect your GitHub repository.
3. Build Command: `npm install && npm run build`
4. Start Command: `npm start`
5. Set Health Check Path: `/health`
6. Add the Environment Variables (`GITHUB_TOKEN`, `GITHUB_USERNAME`, `MCP_API_KEY`).

---

## 🔌 Connecting MCP Clients

For clients supporting MCP Server-Sent Events (SSE) transport:

- **SSE URL**: `https://your-deployment.railway.app/sse?apiKey=YOUR_MCP_API_KEY`
- **Or Headers**:
  ```json
  {
    "Authorization": "Bearer YOUR_MCP_API_KEY"
  }
  ```
