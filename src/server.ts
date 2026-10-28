import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { config } from "./config.js";
import { createGitHubMcpServer } from "./mcp-server.js";

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());

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
 * 3. Query string ?apiKey=<key> or ?token=<key> (useful for EventSource clients)
 */
function authMiddleware(req: Request, res: Response, next: NextFunction) {
  // If no MCP_API_KEY is configured in development, allow requests with a warning
  if (!config.MCP_API_KEY) {
    return next();
  }

  const authHeader = req.headers.authorization;
  const customHeader = req.headers["x-mcp-api-key"] as string | undefined;
  const queryKey = (req.query.apiKey || req.query.token) as string | undefined;

  let providedKey: string | undefined;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    providedKey = authHeader.slice(7).trim();
  } else if (customHeader) {
    providedKey = customHeader.trim();
  } else if (queryKey) {
    providedKey = queryKey.trim();
  }

  if (!providedKey || providedKey !== config.MCP_API_KEY) {
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
    },
  });
});

// Root endpoint with service info
app.get("/", (_req: Request, res: Response) => {
  res.status(200).json({
    name: "GitHub Lifetime MCP Gateway",
    version: "1.0.0",
    protocol: "Model Context Protocol (MCP) via SSE",
    endpoints: {
      health: "/health",
      sse: "/sse",
      messages: "/messages",
    },
  });
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

// Start Express Server
const server = app.listen(config.PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 GitHub Lifetime MCP Server running on port ${config.PORT}`);
  console.log(`   Health Check:     http://localhost:${config.PORT}/health`);
  console.log(`   SSE Endpoint:     http://localhost:${config.PORT}/sse`);
  console.log(`   Messages (POST):  http://localhost:${config.PORT}/messages`);
  console.log(`   Auth Protection:  ${config.MCP_API_KEY ? "ENABLED (MCP_API_KEY required)" : "DISABLED (Dev mode)"}`);
  console.log(`======================================================\n`);
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
