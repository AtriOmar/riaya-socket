import http from "node:http";
import express, {
	type NextFunction,
	type Request,
	type Response,
} from "express";
import { pino } from "pino";
import { type WebSocket, WebSocketServer } from "ws";
import { getSystemMessage } from "./systemMessages.js";
import { TwilioSession } from "./twilioSession.js";

const PORT = process.env.PORT || 8080;

const logger = pino({
	level: process.env.LOG_LEVEL || "debug",
	transport: { target: "pino-pretty", options: { colorize: true } },
});

const app = express();
const server = http.createServer(app);

// Two WebSocket servers: one for Twilio media streams, one for dashboard monitoring
const twilioWss = new WebSocketServer({ noServer: true });
const dashboardWss = new WebSocketServer({ noServer: true });

// Store for dashboard monitoring connections
const dashboardClients = new Set<WebSocket>();

// ==================== HTTP Routes ====================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/", (_req: Request, res: Response) => {
	res.json({ status: "ok", service: "riaya-realtime" });
});

// Twilio webhook: returns TwiML to connect the call to a media stream
app.all("/incoming-call", (_req: Request, res: Response) => {
	// const host = req.headers.host;
	const host =
		process.env.NEXTJS_API_URL?.replace("https://", "") ||
		"rqpwn4z7-8080.euw.devtunnels.ms";
	logger.info({ host }, "📞 Incoming call webhook");

	const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
//   <Say voice="Google.en-US-Chirp3-HD-Aoede">Just a minute</Say>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`;

	res.type("text/xml").send(twiml);
});

// ==================== WebSocket Upgrade ====================

server.on("upgrade", (request, socket, head) => {
	if (!request.url) {
		socket.destroy();
		return;
	}

	const { pathname } = new URL(request.url, `http://${request.headers.host}`);

	if (pathname === "/media-stream") {
		twilioWss.handleUpgrade(request, socket, head, (ws) => {
			twilioWss.emit("connection", ws, request);
		});
	} else if (pathname === "/dashboard") {
		dashboardWss.handleUpgrade(request, socket, head, (ws) => {
			dashboardWss.emit("connection", ws, request);
		});
	} else {
		socket.destroy();
	}
});

// ==================== Twilio Media Stream Connections ====================

twilioWss.on("connection", (ws: WebSocket) => {
	logger.info("📞 Twilio media stream connected");

	const systemMessage = getSystemMessage("doctor-appointment");
	if (!systemMessage) {
		logger.error("🔥 System message 'doctor-appointment' not found");
		ws.close();
		return;
	}

	// Each Twilio call gets its own session that bridges Twilio ↔ OpenAI ↔ Dashboard
	new TwilioSession(ws, logger, systemMessage, dashboardClients);
});

// ==================== Dashboard Monitoring Connections ====================

dashboardWss.on("connection", (ws: WebSocket) => {
	logger.info("🖥️ Dashboard client connected");
	dashboardClients.add(ws);

	ws.on("close", () => {
		dashboardClients.delete(ws);
		logger.info("🖥️ Dashboard client disconnected");
	});

	ws.on("error", (error) => {
		logger.error({ error }, "🔥 Dashboard WebSocket error");
		dashboardClients.delete(ws);
	});

	// Send a welcome message
	ws.send(
		JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }),
	);
});

// ==================== Error Handling ====================

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
	logger.error(err, "🔥 Unhandled error");
	res.status(500).json({ error: "Internal server error" });
});

// ==================== Start Server ====================

server.listen(PORT, () =>
	logger.info(`🟢 Riaya Realtime server started on http://localhost:${PORT}`),
);

server.on("close", () => {
	logger.info("🔴 Server stopped");
});
