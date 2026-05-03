import http from "node:http";
import express, {
	type NextFunction,
	type Request,
	type Response,
} from "express";
import { pino } from "pino";
import { type WebSocket, WebSocketServer } from "ws";
import { ensureCallRow } from "./callsApi.js";
import { getSystemMessage } from "./systemMessages.js";
import { TwilioSession } from "./twilioSession.js";

const PORT = process.env.PORT || 8080;

const logger = pino({
	level: process.env.LOG_LEVEL || "debug",
	transport: { target: "pino-pretty", options: { colorize: true } },
});

const app = express();
const server = http.createServer(app);

/** Escape for use inside TwiML double-quoted attribute values */
function escapeXmlAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

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
app.all("/incoming-call", (req: Request, res: Response) => {
	// Host for wss://…/media-stream must reach THIS realtime server (ngrok/tunnel), not Next.js.
	const fromEnv = process.env.PUBLIC_SOCKET_HOST?.trim()
		.replace(/^https?:\/\//i, "")
		.replace(/\/$/, "");
	const host = fromEnv || req.get("host")?.trim() || "localhost:8080";

	const pickStr = (key: string): string => {
		const v =
			typeof req.body?.[key] === "string"
				? req.body[key]
				: typeof req.query?.[key] === "string"
					? (req.query[key] as string)
					: "";
		return v.trim();
	};

	const from = pickStr("From");
	const to = pickStr("To");
	const direction = pickStr("Direction");
	const callSid = pickStr("CallSid");

	const callerParameter =
		from.length > 0
			? `\n    <Parameter name="callerPhone" value="${escapeXmlAttr(from)}" />`
			: "";

	logger.info(
		{ host, hasCallerPhone: from.length > 0, callSid },
		"📞 Incoming call webhook",
	);

	// Fire-and-forget: create the call row in Next.js. TwilioSession will
	// await the same promise (cached by callSid) before persisting events.
	if (callSid) {
		console.log(
			"-------------------- callSid ensureCallRow --------------------",
		);
		console.log(callSid);
		ensureCallRow({ callSid, from, to, direction }).catch((err) =>
			logger.error({ err }, "🔥 Failed to create call row"),
		);
	}

	const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream">${callerParameter}
    </Stream>
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
