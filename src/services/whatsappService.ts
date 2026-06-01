import { EventEmitter } from "node:events";
import path from "node:path";
import type { Boom } from "@hapi/boom";
import makeWASocket, {
	DisconnectReason,
	useMultiFileAuthState,
	type WASocket,
} from "@whiskeysockets/baileys";
import { pino } from "pino";
import { toDataURL } from "qrcode";

export type WhatsappStatus =
	| { type: "qr"; data: string }
	| { type: "connected"; phone?: string }
	| { type: "disconnected"; reason?: string }
	| { type: "connecting" };

const AUTH_FOLDER = path.resolve("./whatsapp-auth");

const silentLogger = pino({ level: "silent" });

export class WhatsappService extends EventEmitter {
	private sock: WASocket | null = null;
	private connected = false;
	private phone: string | undefined = undefined;
	private lastQr: string | null = null;
	private logger = pino({
		level: process.env.LOG_LEVEL || "debug",
		transport: { target: "pino-pretty", options: { colorize: true } },
	});

	async connect() {
		this.logger.info("[WhatsApp] Starting Baileys connection...");
		await this.startSocket();
	}

	getStatus(): { connected: boolean; phone?: string } {
		return { connected: this.connected, phone: this.phone };
	}

	getLastQr(): string | null {
		return this.lastQr;
	}

	async sendMessage(phone: string, text: string): Promise<void> {
		if (!this.sock || !this.connected) {
			throw new Error("WhatsApp is not connected");
		}
		const jid = `${phone.replace(/\D/g, "")}@s.whatsapp.net`;
		await this.sock.sendMessage(jid, { text });
		this.logger.info({ jid }, "[WhatsApp] Message sent");
	}

	/** End the current Baileys socket so a new one can own auth writes (avoids races / corrupt creds). */
	private async destroySocket(): Promise<void> {
		const sock = this.sock;
		if (!sock) return;
		this.sock = null;
		try {
			sock.ev.removeAllListeners("creds.update");
			sock.ev.removeAllListeners("connection.update");
			sock.ev.removeAllListeners("messages.upsert");
			await sock.end(undefined);
		} catch (err) {
			this.logger.warn({ err }, "[WhatsApp] Error while closing socket");
		}
	}

	private async startSocket() {
		// Always tear down first: reconnect used to stack sockets, both calling saveCreds → bad files.
		await this.destroySocket();

		const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

		this.sock = makeWASocket({
			auth: state,
			logger: silentLogger,
			printQRInTerminal: false,
			browser: ["Riaya", "Chrome", "1.0.0"],
		});

		this.sock.ev.on("creds.update", saveCreds);

		this.sock.ev.on("connection.update", async (update) => {
			const { connection, lastDisconnect, qr } = update;

			if (qr) {
				this.logger.info("[WhatsApp] New QR code received");
				try {
					const dataUrl = await toDataURL(qr);
					this.lastQr = dataUrl;
					this.connected = false;
					this.phone = undefined;
					const payload: WhatsappStatus = { type: "qr", data: dataUrl };
					this.emit("status", payload);
				} catch (err) {
					this.logger.error({ err }, "[WhatsApp] Failed to generate QR image");
				}
			}

			if (connection === "open") {
				this.connected = true;
				this.lastQr = null;
				this.phone = this.sock?.user?.id?.split(":")[0];
				this.logger.info({ phone: this.phone }, "[WhatsApp] Connected");
				const payload: WhatsappStatus = {
					type: "connected",
					phone: this.phone,
				};
				this.emit("status", payload);
			}

			if (connection === "close") {
				this.connected = false;
				this.phone = undefined;
				const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
				const reason =
					DisconnectReason[statusCode as DisconnectReason] ??
					String(statusCode);
				this.logger.warn({ reason }, "[WhatsApp] Connection closed");

				const payload: WhatsappStatus = { type: "disconnected", reason };
				this.emit("status", payload);

				const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
				if (shouldReconnect) {
					this.logger.info("[WhatsApp] Reconnecting...");
					await this.startSocket();
				} else {
					this.logger.warn("[WhatsApp] Logged out - manual re-link required");
				}
			}
		});

		this.sock.ev.on("messages.upsert", ({ messages, type }) => {
			console.log(
				"-------------------- messages, type, rest --------------------",
			);
			console.log(JSON.stringify(messages, null, 2), type);
			if (type !== "notify") return;
			for (const msg of messages) {
				if (msg.key.fromMe) continue;
				const from = msg.key.remoteJidAlt;
				const text =
					msg.message?.conversation ??
					msg.message?.extendedTextMessage?.text ??
					"[media / unsupported]";
				this.logger.info({ from, text }, "[WhatsApp] Incoming message");
			}
		});
	}
}
