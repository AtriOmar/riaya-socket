import { DefaultAzureCredential } from "@azure/identity";
import axios from "axios";
import { config } from "dotenv";
import type { Logger } from "pino";
import { type RawData, WebSocket } from "ws";
import type {
	BestFitDoctor,
	DashboardMessage,
	SystemMessage,
	TwilioMediaMessage,
} from "./types.js";

config();

const {
	BACKEND,
	OPENAI_API_KEY,
	OPENAI_ENDPOINT,
	OPENAI_MODEL,
	OPENAI_API_VERSION,
	NEXTJS_API_URL,
} = process.env as Record<string, string>;

// ==================== Session Config ====================

const SESSION_CONFIG = {
	modalities: ["text", "audio"],
	voice: "ash",
	input_audio_format: "g711_ulaw",
	output_audio_format: "g711_ulaw",
	input_audio_transcription: { model: "whisper-1" },
	turn_detection: {
		type: "server_vad",
		threshold: parseFloat(process.env.VAD_THRESHOLD || "0.5"),
		silence_duration_ms: parseInt(process.env.SILENCE_DURATION_MS || "600", 10),
	},
	tool_choice: "auto",
	max_response_output_tokens: parseInt(
		process.env.MAX_OUTPUT_TOKENS || "4096",
		10,
	),
};

// ==================== OpenAI Realtime Event Types ====================

const EVENTS = {
	SessionCreated: "session.created",
	SessionUpdated: "session.updated",
	InputAudioBufferSpeechStarted: "input_audio_buffer.speech_started",
	InputAudioBufferSpeechStopped: "input_audio_buffer.speech_stopped",
	InputAudioBufferCommitted: "input_audio_buffer.committed",
	ResponseAudioDelta: "response.audio.delta",
	ResponseAudioDone: "response.audio.done",
	ResponseAudioTranscriptDelta: "response.audio_transcript.delta",
	ResponseAudioTranscriptDone: "response.audio_transcript.done",
	ResponseFunctionCallArgumentsDone: "response.function_call_arguments.done",
	ResponseDone: "response.done",
	Error: "error",
	ConversationItemCreated: "conversation.item.created",
	ConversationItemInputAudioTranscriptionCompleted:
		"conversation.item.input_audio_transcription.completed",
	ConversationItemInputAudioTranscriptionFailed:
		"conversation.item.input_audio_transcription.failed",
	RateLimitsUpdated: "rate_limits.updated",
	ResponseOutputItemDone: "response.output_item.done",
};

// ==================== TwilioSession ====================

export class TwilioSession {
	// Azure auth token cache (shared across sessions)
	private static tokenCache: { token: string; expires: number } | null = null;
	private static readonly TOKEN_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

	// Connection state
	private openAIWs!: WebSocket;
	private streamSid: string | null = null;
	private callSid: string | null = null;

	// Audio playback tracking (for interruption handling)
	private latestMediaTimestamp = 0;
	private responseStartTimestampTwilio: number | null = null;
	private lastAssistantItem: string | null = null;
	private markQueue: string[] = [];

	// AI transcript accumulator (per response)
	private currentAiTranscript = "";

	constructor(
		private readonly twilioWs: WebSocket,
		private readonly logger: Logger,
		private readonly systemMessage: SystemMessage,
		private readonly dashboardClients: Set<WebSocket>,
	) {
		this.logger.info("🟢 TwilioSession created");
		this.initialize().catch((error) =>
			this.logger.error({ error }, "🔥 Failed to initialize TwilioSession"),
		);
	}

	// ==================== Initialization ====================

	private async initialize() {
		// Set up Twilio handlers FIRST so we don't miss early events (start, connected)
		// that Twilio sends immediately after the WebSocket is established
		this.setupTwilioHandlers();
		this.openAIWs = await this.connectToOpenAI();
		this.setupOpenAIHandlers();
	}

	private connectToOpenAI(): Promise<WebSocket> {
		const url =
			BACKEND === "azure"
				? `${OPENAI_ENDPOINT.replace("https://", "wss://")}/openai/realtime?deployment=${OPENAI_MODEL}&api-version=${OPENAI_API_VERSION}`
				: `wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL || "gpt-4o-realtime-preview"}`;

		this.logger.info(`🔌 Connecting to OpenAI at ${url}`);

		// biome-ignore lint/suspicious/noAsyncPromiseExecutor: I found the code already like this and it seems to be working fine --- IGNORE ---
		return new Promise(async (resolve, reject) => {
			const headers = await this.getHeaders();
			const ws = new WebSocket(url, { headers });

			ws.on("open", () => {
				this.logger.info("🟢 OpenAI WebSocket connected");
				resolve(ws);
			});

			ws.on("error", (error) => {
				this.logger.error({ error }, "🔥 OpenAI WebSocket connection error");
				reject(error);
			});
		});
	}

	private async getHeaders(): Promise<Record<string, string>> {
		if (BACKEND === "azure") {
			if (OPENAI_API_KEY) {
				this.logger.info("✅ Using Azure API key");
				return { "api-key": OPENAI_API_KEY };
			}

			// Managed identity fallback
			const now = Date.now();
			if (
				TwilioSession.tokenCache &&
				TwilioSession.tokenCache.expires >
					now + TwilioSession.TOKEN_REFRESH_THRESHOLD_MS
			) {
				return { Authorization: `Bearer ${TwilioSession.tokenCache.token}` };
			}

			const token = await new DefaultAzureCredential().getToken(
				"https://cognitiveservices.azure.com/.default",
			);
			if (!token?.token)
				throw new Error("Failed to retrieve Azure access token");

			TwilioSession.tokenCache = {
				token: token.token,
				expires: token.expiresOnTimestamp,
			};
			return { Authorization: `Bearer ${token.token}` };
		}

		if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
		return {
			Authorization: `Bearer ${OPENAI_API_KEY}`,
			"OpenAI-Beta": "realtime=v1",
		};
	}

	private sendSessionConfig() {
		if (this.openAIWs?.readyState !== WebSocket.OPEN) return;

		this.openAIWs.send(
			JSON.stringify({
				type: "session.update",
				session: {
					instructions: this.systemMessage.message,
					tools: this.systemMessage.tools,
					...SESSION_CONFIG,
				},
			}),
		);
		this.logger.info("✅ Session config sent to OpenAI");
	}

	private sendInitialGreeting() {
		if (this.openAIWs?.readyState !== WebSocket.OPEN) return;

		this.openAIWs.send(
			JSON.stringify({
				type: "response.create",
				response: {
					modalities: ["text", "audio"],
					instructions: this.systemMessage.initialInstructions,
				},
			}),
		);
		this.logger.info("🗣️ Initial greeting triggered");
	}

	// ==================== OpenAI Event Handlers ====================

	private setupOpenAIHandlers() {
		this.openAIWs.on("message", (data: RawData) =>
			this.handleOpenAIMessage(data),
		);
		this.openAIWs.on("close", () => {
			this.logger.info("🔴 OpenAI WebSocket closed");
			this.dispose();
		});
		this.openAIWs.on("error", (error) =>
			this.logger.error({ error }, "🔥 OpenAI WebSocket error"),
		);
	}

	private handleOpenAIMessage(data: RawData) {
		try {
			const event = JSON.parse(data.toString());
			console.log("-------------------- event --------------------");
			console.log(event);

			// biome-ignore lint/suspicious/noExplicitAny: screw this
			const handlers: Record<string, (e: any) => void> = {
				[EVENTS.SessionCreated]: () => {
					this.logger.info("✅ OpenAI session created");
					this.sendSessionConfig();
				},

				[EVENTS.SessionUpdated]: () => {
					this.logger.info("✅ Session config updated");
					this.sendInitialGreeting();
				},

				[EVENTS.ResponseAudioDelta]: (e) => this.handleAudioDelta(e),

				[EVENTS.ResponseAudioTranscriptDelta]: (e) => {
					if (e.delta && this.callSid) {
						this.currentAiTranscript += e.delta;
						this.broadcastDashboard({
							type: "ai_transcript",
							callSid: this.callSid,
							text: this.currentAiTranscript,
							delta: e.delta,
							isFinal: false,
						});
					}
				},

				[EVENTS.ResponseAudioTranscriptDone]: (e) => {
					if (this.callSid) {
						this.broadcastDashboard({
							type: "ai_transcript",
							callSid: this.callSid,
							text: e.transcript || this.currentAiTranscript,
							delta: "",
							isFinal: true,
						});
						this.currentAiTranscript = "";
					}
				},

				[EVENTS.InputAudioBufferSpeechStarted]: () =>
					this.handleSpeechStarted(),

				[EVENTS.ConversationItemInputAudioTranscriptionCompleted]: (e) => {
					if (e.transcript && this.callSid) {
						this.logger.info({ transcript: e.transcript }, "📝 Patient said");
						this.broadcastDashboard({
							type: "patient_transcript",
							callSid: this.callSid,
							text: e.transcript,
							isFinal: true,
						});
					}
				},

				[EVENTS.ConversationItemInputAudioTranscriptionFailed]: (e) =>
					this.logger.error({ error: e.error }, "🔥 Transcription failed"),

				[EVENTS.ResponseFunctionCallArgumentsDone]: (e) =>
					this.handleFunctionCall(e),

				[EVENTS.ResponseDone]: () => this.logger.debug("✅ Response complete"),

				[EVENTS.Error]: (e) => {
					this.logger.error({ error: e.error }, "🔥 OpenAI error");
					if (this.callSid) {
						this.broadcastDashboard({
							type: "error",
							callSid: this.callSid,
							message: e.error?.message || "OpenAI error",
						});
					}
				},

				[EVENTS.RateLimitsUpdated]: (e) =>
					this.logger.info({ rateLimits: e.rate_limits }, "📊 Rate limits"),
			};

			const handler = handlers[event.type];
			if (handler) {
				handler(event);
			}
		} catch (error) {
			this.logger.error({ error }, "🔥 Error processing OpenAI message");
		}
	}

	// ==================== Twilio Event Handlers ====================

	private setupTwilioHandlers() {
		this.twilioWs.on("message", (data: RawData) =>
			this.handleTwilioMessage(data),
		);
		this.twilioWs.on("close", () => {
			this.logger.info("🔴 Twilio WebSocket closed");
			if (this.callSid) {
				this.broadcastDashboard({
					type: "call_end",
					callSid: this.callSid,
					timestamp: new Date().toISOString(),
				});
			}
			this.dispose();
		});
		this.twilioWs.on("error", (error) =>
			this.logger.error({ error }, "🔥 Twilio WebSocket error"),
		);
	}

	private handleTwilioMessage(data: RawData) {
		try {
			const msg: TwilioMediaMessage = JSON.parse(data.toString());

			console.log("-------------------- msg --------------------");
			console.log(msg);
			switch (msg.event) {
				case "connected":
					this.logger.info(
						{ protocol: msg.protocol, version: msg.version },
						"📞 Twilio WebSocket connected",
					);
					break;

				case "start":
					this.streamSid = msg.streamSid;
					this.callSid = msg.start.callSid;
					this.logger.info(
						{ streamSid: this.streamSid, callSid: this.callSid },
						"📞 Twilio stream started",
					);
					this.broadcastDashboard({
						type: "call_start",
						callSid: this.callSid,
						timestamp: new Date().toISOString(),
					});
					break;

				case "media":
					this.latestMediaTimestamp = parseInt(msg.media.timestamp, 10);

					// Forward audio to OpenAI
					if (this.openAIWs?.readyState === WebSocket.OPEN) {
						this.openAIWs.send(
							JSON.stringify({
								type: "input_audio_buffer.append",
								audio: msg.media.payload,
							}),
						);
					}

					// Forward audio to dashboard clients listening to this call
					if (this.callSid) {
						this.broadcastDashboard({
							type: "patient_audio",
							callSid: this.callSid,
							payload: msg.media.payload,
						});
					}
					break;

				case "mark":
					if (this.markQueue.length > 0) {
						this.markQueue.shift();
					}
					break;

				case "stop":
					this.logger.info("📞 Twilio stream stopped");
					break;

				default:
					break;
			}
		} catch (error) {
			this.logger.error({ error }, "🔥 Error parsing Twilio message");
		}
	}

	// ==================== Audio Handling ====================

	// biome-ignore lint/suspicious/noExplicitAny: ignore
	private handleAudioDelta(event: any) {
		if (!event.delta || !this.streamSid) return;

		// Send audio back to Twilio
		this.twilioWs.send(
			JSON.stringify({
				event: "media",
				streamSid: this.streamSid,
				media: {
					payload: Buffer.from(event.delta, "base64").toString("base64"),
				},
			}),
		);

		// Track playback timing for interruption handling
		if (this.responseStartTimestampTwilio === null) {
			this.responseStartTimestampTwilio = this.latestMediaTimestamp;
		}

		if (event.item_id) {
			this.lastAssistantItem = event.item_id;
		}

		// Send mark to track playback progress
		this.sendMark();

		// Forward AI audio to dashboard
		if (this.callSid) {
			this.broadcastDashboard({
				type: "ai_audio",
				callSid: this.callSid,
				payload: event.delta,
			});
		}
	}

	private sendMark() {
		if (!this.streamSid) return;

		const markEvent = {
			event: "mark",
			streamSid: this.streamSid,
			mark: { name: "responsePart" },
		};
		this.twilioWs.send(JSON.stringify(markEvent));
		this.markQueue.push("responsePart");
	}

	/** Handle interruption: patient starts speaking while AI is responding */
	private handleSpeechStarted() {
		if (
			this.markQueue.length > 0 &&
			this.responseStartTimestampTwilio != null
		) {
			const elapsedTime =
				this.latestMediaTimestamp - this.responseStartTimestampTwilio;

			// Tell OpenAI to truncate the current response
			if (this.lastAssistantItem) {
				this.openAIWs.send(
					JSON.stringify({
						type: "conversation.item.truncate",
						item_id: this.lastAssistantItem,
						content_index: 0,
						audio_end_ms: elapsedTime,
					}),
				);
			}

			// Tell Twilio to clear its audio buffer
			this.twilioWs.send(
				JSON.stringify({
					event: "clear",
					streamSid: this.streamSid,
				}),
			);

			// Reset tracking state
			this.markQueue = [];
			this.lastAssistantItem = null;
			this.responseStartTimestampTwilio = null;
		}
	}

	// ==================== Function Calling ====================

	private async handleFunctionCall(event: {
		call_id: string;
		name?: string;
		arguments: string;
	}) {
		const { call_id, name, arguments: args } = event;

		this.logger.info({ call_id, name, args }, "🔧 Function call received");

		if (!args || !name) {
			this.logger.warn({ call_id }, "🟠 Missing function name or arguments");
			return;
		}

		// Broadcast to dashboard
		if (this.callSid) {
			this.broadcastDashboard({
				type: "function_call",
				callSid: this.callSid,
				name,
				args,
				status: "calling",
			});
		}

		try {
			let result: string;

			switch (name) {
				case "find_available_slots":
					result = await this.findAvailableSlots(JSON.parse(args));
					break;
				case "book_appointment":
					result = await this.bookAppointment(JSON.parse(args));
					break;
				default:
					result = JSON.stringify({ error: `Unknown function: ${name}` });
			}

			this.logger.info({ call_id, name, result }, "✅ Function call result");

			// Broadcast success to dashboard
			if (this.callSid) {
				this.broadcastDashboard({
					type: "function_call",
					callSid: this.callSid,
					name,
					args,
					status: "success",
					result,
				});
			}

			// Send result back to OpenAI
			this.openAIWs.send(
				JSON.stringify({
					type: "conversation.item.create",
					item: {
						type: "function_call_output",
						call_id,
						output: result,
					},
				}),
			);

			// Trigger OpenAI to continue the conversation based on the result
			this.openAIWs.send(JSON.stringify({ type: "response.create" }));
			// biome-ignore lint/suspicious/noExplicitAny: ignore
		} catch (error: any) {
			this.logger.error({ error, call_id, name }, "🔥 Function call failed");

			// Broadcast error to dashboard
			if (this.callSid) {
				this.broadcastDashboard({
					type: "function_call",
					callSid: this.callSid,
					name,
					args,
					status: "error",
					result: error.message,
				});
			}

			// Send error back to OpenAI so it can inform the patient
			this.openAIWs.send(
				JSON.stringify({
					type: "conversation.item.create",
					item: {
						type: "function_call_output",
						call_id,
						output: JSON.stringify({
							error: true,
							message: `Failed to ${name}: ${error.message}`,
						}),
					},
				}),
			);

			this.openAIWs.send(JSON.stringify({ type: "response.create" }));
		}
	}

	private async findAvailableSlots(params: {
		speciality: string;
		latitude: number;
		longitude: number;
		preferred_time?: string;
	}): Promise<string> {
		this.logger.info({ params }, "🔍 Finding available slots");

		const { data } = await axios.get<BestFitDoctor[]>(
			`http://localhost:3000/api/doctors/best-fit`,
			{
				params: {
					speciality: params.speciality,
					lat: params.latitude,
					long: params.longitude,
					time: params.preferred_time,
				},
			},
		);

		if (!data || data.length === 0) {
			return JSON.stringify({
				found: false,
				message:
					"No doctors with available slots were found for this speciality and location.",
			});
		}

		// Return top 3 for the AI to present
		const top = data.slice(0, 3).map((doc) => ({
			doctor_id: doc._id,
			name: `Dr. ${doc.firstName} ${doc.lastName}`,
			cabinet: doc.cabinetName,
			distance_km: Math.round(doc.distance * 10) / 10,
			slot_start: doc.nextSlot.start,
			slot_end: doc.nextSlot.end,
		}));

		return JSON.stringify({ found: true, doctors: top });
	}

	private async bookAppointment(params: {
		doctor_id: string;
		patient_name: string;
		phone_number: string;
		illness: string;
		start: string;
		end: string;
	}): Promise<string> {
		this.logger.info({ params }, "📅 Booking appointment");

		const { data } = await axios.post(
			`${NEXTJS_API_URL}/api/appointments/external`,
			{
				doctor: params.doctor_id,
				name: params.patient_name,
				phoneNumber: params.phone_number,
				illness: params.illness,
				start: params.start,
				end: params.end,
			},
		);

		// Broadcast to dashboard
		if (this.callSid) {
			this.broadcastDashboard({
				type: "appointment_booked",
				callSid: this.callSid,
				data,
			});
		}

		return JSON.stringify({
			success: true,
			appointment_id: data._id,
			status: data.status,
			message: "Appointment created successfully with pending status.",
		});
	}

	// ==================== Dashboard Broadcasting ====================

	private broadcastDashboard(message: DashboardMessage) {
		const json = JSON.stringify(message);
		this.dashboardClients.forEach((client) => {
			if (client.readyState === WebSocket.OPEN) {
				client.send(json);
			}
		});
	}

	// ==================== Cleanup ====================

	dispose() {
		this.logger.info("🗑️ Disposing TwilioSession");

		if (this.openAIWs) {
			this.openAIWs.removeAllListeners();
			if (
				this.openAIWs.readyState !== WebSocket.CLOSED &&
				this.openAIWs.readyState !== WebSocket.CLOSING
			) {
				this.openAIWs.close();
			}
		}

		if (this.twilioWs) {
			this.twilioWs.removeAllListeners();
		}

		this.logger.info("🔴 TwilioSession disposed");
	}
}
