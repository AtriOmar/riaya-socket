import express, { Request, Response, NextFunction } from "express";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import { pino } from "pino";
import { RTSession } from "./session.js";
import { getSystemMessage } from "./systemMessages.js";
import { CarControlMessage, CompactCommand } from "./types.js";

const PORT = process.env.PORT || 8080;

const logger = pino({
  level: process.env.LOG_LEVEL || "debug",
  transport: { target: "pino-pretty", options: { colorize: true } },
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Store for ESP32 car connections
const carConnections = new Map<string, WebSocket>();

/*
 * COMPACT COMMAND PROTOCOL
 *
 * Commands are arrays: [msg, type, ...params]
 * Type codes: 1=move, 2=led, 3=beep, 4=play
 *
 * Move actions: 0=stop, 1=forward, 2=backward, 3=left, 4=right, 5=fl, 6=fr, 7=bl, 8=br
 * Songs: 0=stop, 1=pirates, 2=got, 3=squid
 */

// Function to broadcast compact commands to all connected cars
export function broadcastCompactCommands(compactCommands: CompactCommand[]) {
  const message: CarControlMessage = {
    type: "car_control",
    c: compactCommands,
  };
  const messageStr = JSON.stringify(message);

  let sentCount = 0;
  carConnections.forEach((ws, carId) => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(messageStr, (err) => {
          if (err) {
            logger.error({ carId, error: err }, "🔥 Error sending to car");
          }
        });
        sentCount++;
      } catch (err) {
        logger.error({ carId, error: err }, "🔥 Exception sending to car");
      }
    }
  });

  if (sentCount === 0) {
    logger.warn("🟠 No car devices connected to receive commands");
  }

  return sentCount;
}

app.use(express.json()); // Middleware to parse JSON bodies

server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url!, `http://${request.headers.host}`);
  if (pathname === "/realtime") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws: WebSocket) => {
  logger.info("🟢 New Client websocket connection opened");
  let rtSession: RTSession | null = null;
  let carId: string | null = null;

  const handleSocketEvent = (
    eventType: string,
    data?: any,
    isBinary?: boolean,
  ) => {
    switch (eventType) {
      case "message":
        if (!data) {
          logger.warn("Received empty message");
          return;
        }

        // Skip binary audio data - let RTSession handle it
        if (isBinary && rtSession) {
          return;
        }

        try {
          const messageText = data.toString();

          // Skip non-JSON messages (likely audio data)
          if (!messageText.startsWith("{") && !messageText.startsWith("[")) {
            return;
          }

          const parsedMessage = JSON.parse(messageText);

          // Handle ESP32 car device registration
          if (parsedMessage.type === "car_register") {
            const newCarId = parsedMessage.carId || `car_${Date.now()}`;
            carId = newCarId;
            carConnections.set(newCarId, ws);
            logger.info({ carId: newCarId }, "🚗 Car registered");
            ws.send(
              JSON.stringify({ type: "car_registered", carId: newCarId }),
            );
            return;
          }

          // Handle direct car control from frontend (bypass AI)
          if (parsedMessage.type === "car_direct_control") {
            const sentCount = broadcastCompactCommands(parsedMessage.c);
            ws.send(
              JSON.stringify({
                type: "car_control_sent",
                success: sentCount > 0,
                deviceCount: sentCount,
              }),
            );
            return; // Don't pass to RTSession
          }

          // Handle AI session initialization
          if (parsedMessage.type === "init") {
            if (rtSession) {
              logger.warn(
                "🟠 RTSession already exists - ignoring duplicate init",
              );
              return;
            }

            const systemMessage = getSystemMessage(
              parsedMessage.systemMessageType,
            );

            rtSession = new RTSession(ws, logger, systemMessage);
            // NOTE: We keep the message handler to handle car_direct_control
            // The RTSession will also receive messages via its own handler
          }
        } catch (error) {
          logger.error(
            { error, message: data.toString() },
            "🔥 Failed to process message",
          );
        }
        break;

      case "error":
        logger.error({ error: data }, "🔥 WebSocket error occurred");
        rtSession?.dispose();
        rtSession = null;
        break;

      case "close":
        logger.info("🔴 WebSocket connection closed");
        rtSession?.dispose();
        rtSession = null;

        // Remove car from connections if it was a car device
        if (carId) {
          carConnections.delete(carId);
          logger.info({ carId }, "🚗 ESP32 car device disconnected");
        }
        break;
    }
  };

  const messageHandler = (message: any, isBinary: boolean) =>
    handleSocketEvent("message", message, isBinary);

  ws.on("message", messageHandler);
  ws.on("error", (error: Error) => handleSocketEvent("error", error));
  ws.on("close", () => handleSocketEvent("close"));
});

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error(err, "🔥 Unhandled error");
  res.status(500).json({ error: "🔥 Internal server error" });
});

server.listen(PORT, () =>
  logger.info(`🟢 WebSocket server started on http://localhost:${PORT}`),
);

server.on("close", () => {
  logger.info("🔴 WebSocket server stopped");
});
