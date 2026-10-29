import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { config } from "./config.js";
import { createGitHubMcpServer, executeGitHubTool } from "./mcp-server.js";

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());

// Serve static frontend files from /public
const publicDir = path.resolve(process.cwd(), "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

// Session store for active SSE connections
interface ActiveSession {
  transport: SSEServerTransport;
  server: ReturnType<typeof createGitHubMcpServer>;
}

const activeSessions = new Map<string, ActiveSession>();

/**
 * Authentication Middleware
 * Validates MCP_API_KEY via:
 * 1. Authorization: Bearer <key>
 * 2. X-MCP-API-KEY: <key>
 * 3. Query string ?apiKey=<key> or ?token=<key>
 */
function authMiddleware(req: Request, res: Response, next: NextFunction) {
  // If no MCP_API_KEY is configured in development, allow requests
  if (!config.MCP_API_KEY) {
    return next();
  }

  // Strip accidental surrounding quotes from env var (e.g., if set as "value" in Render)
  const expectedKey = config.MCP_API_KEY.replace(/^["']|["']$/g, "").trim();

  const authHeader = req.headers.authorization;
  const customHeader = req.headers["x-mcp-api-key"] as string | undefined;
  const queryKey = (req.query.apiKey || req.query.token) as string | undefined;

  let providedKey: string | undefined;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    providedKey = authHeader.slice(7).trim();
  } else if (customHeader) {
    providedKey = customHeader.trim();
  } else if (queryKey) {
    try {
      providedKey = decodeURIComponent(queryKey.trim());
    } catch {
      providedKey = queryKey.trim();
    }
  }

  // Strip potential surrounding quotes from provided key
  if (providedKey) {
    providedKey = providedKey.replace(/^["']|["']$/g, "").trim();
  }

  if (!providedKey || providedKey !== expectedKey) {
    return res.status(401).json({
      error: "Unauthorized",
      message:
        "Invalid or missing MCP_API_KEY. Provide it via Authorization Bearer token, X-MCP-API-KEY header, or apiKey query parameter.",
    });
  }

  next();
}

// Health check endpoint for host platforms (Railway, Render, Fly.io, etc.)
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "healthy",
    service: "github-mcp-server",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    configured: {
      githubUsername: !!config.GITHUB_USERNAME,
      githubToken: !!config.GITHUB_TOKEN,
      authEnabled: !!config.MCP_API_KEY,
      keepAlive: !!config.KEEP_ALIVE_URL,
    },
  });
});

// Lightweight ping endpoint for keep-alive services
app.get("/ping", (_req: Request, res: Response) => {
  res.status(200).send("pong");
});

// Root endpoint - serves UI Dashboard if requested by browser, or JSON if API client
app.get("/", (req: Request, res: Response) => {
  const indexPath = path.join(publicDir, "index.html");
  if (req.accepts("html") && fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }

  res.status(200).json({
    name: "GitHub Lifetime MCP Gateway",
    version: "1.0.0",
    protocol: "Model Context Protocol (MCP) via SSE",
    endpoints: {
      dashboard: "/",
      health: "/health",
      ping: "/ping",
      sse: "/sse",
      messages: "/messages",
      testTool: "/api/test-tool",
    },
  });
});

// Explicit dashboard route
app.get("/dashboard", (_req: Request, res: Response) => {
  const indexPath = path.join(publicDir, "index.html");
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  res.redirect("/");
});

// Test tool API for frontend playground
app.post("/api/test-tool", authMiddleware, async (req: Request, res: Response) => {
  try {
    const { tool, params } = req.body;
    if (!tool) {
      return res.status(400).json({ error: "Missing tool name in request body" });
    }
    const result = await executeGitHubTool(tool, params || {});
    res.status(200).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// SSE endpoint to initiate client connection
app.get("/sse", authMiddleware, async (req: Request, res: Response) => {
  try {
    console.log(`[MCP-SSE] New SSE connection incoming from ${req.ip}`);

    // Create a new SSE Transport pointing to /messages
    const transport = new SSEServerTransport("/messages", res);
    const mcpServer = createGitHubMcpServer();

    activeSessions.set(transport.sessionId, { transport, server: mcpServer });

    // Handle connection closure
    res.on("close", () => {
      console.log(`[MCP-SSE] Session closed: ${transport.sessionId}`);
      activeSessions.delete(transport.sessionId);
    });

    await mcpServer.connect(transport);
    console.log(`[MCP-SSE] Session initialized: ${transport.sessionId}`);
  } catch (err) {
    console.error("[MCP-SSE] Failed to establish SSE transport:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to initialize MCP SSE connection" });
    }
  }
});

// Messages endpoint for client RPC JSON-RPC payloads
app.post("/messages", authMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;

  if (!sessionId) {
    return res.status(400).json({ error: "Missing sessionId query parameter" });
  }

  const session = activeSessions.get(sessionId);
  if (!session) {
    return res.status(404).json({
      error: "Session not found or expired. Re-connect via /sse.",
    });
  }

  try {
    await session.transport.handlePostMessage(req, res);
  } catch (err) {
    console.error(`[MCP-RPC] Error processing message for session ${sessionId}:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal error processing MCP RPC message" });
    }
  }
});

/**
 * Self-ping keep-alive loop to prevent Render / cloud host from sleeping.
 * Render automatically provides RENDER_EXTERNAL_URL in production.
 */
function startKeepAlive() {
  if (!config.KEEP_ALIVE_URL) {
    console.log(
      "[KEEP-ALIVE] Inactive (No KEEP_ALIVE_URL or RENDER_EXTERNAL_URL detected)."
    );
    return;
  }

  const pingUrl = `${config.KEEP_ALIVE_URL.replace(/\/+$/, "")}/ping`;
  const intervalMs = config.KEEP_ALIVE_INTERVAL_MINUTES * 60 * 1000;

  console.log(
    `[KEEP-ALIVE] Active: Pinging ${pingUrl} every ${config.KEEP_ALIVE_INTERVAL_MINUTES} minutes.`
  );

  setInterval(async () => {
    try {
      const res = await fetch(pingUrl);
      if (res.ok) {
        console.log(
          `[KEEP-ALIVE] Ping successful (${res.status}) at ${new Date().toISOString()}`
        );
      } else {
        console.warn(`[KEEP-ALIVE] Ping returned HTTP ${res.status}`);
      }
    } catch (err: any) {
      console.warn(`[KEEP-ALIVE] Ping error: ${err.message || err}`);
    }
  }, intervalMs).unref();
}

// Start Express Server
const server = app.listen(config.PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 GitHub Lifetime MCP Server running on port ${config.PORT}`);
  console.log(`   Health Check:     http://localhost:${config.PORT}/health`);
  console.log(`   Ping Endpoint:    http://localhost:${config.PORT}/ping`);
  console.log(`   SSE Endpoint:     http://localhost:${config.PORT}/sse`);
  console.log(`   Messages (POST):  http://localhost:${config.PORT}/messages`);
  console.log(`   Auth Protection:  ${config.MCP_API_KEY ? "ENABLED (MCP_API_KEY required)" : "DISABLED (Dev mode)"}`);
  console.log(`======================================================\n`);

  startKeepAlive();
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, closing server...");
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  console.log("SIGINT received, closing server...");
  server.close(() => process.exit(0));
});
