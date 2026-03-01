export type WSMessage =
  | { id: string; type: "text_delta"; delta: string }
  | { id?: string; type: "transcription"; text: string }
  | { id: string; type: "user_message"; text: string }
  | {
      type: "control";
      action:
        | "speech_started"
        | "connected"
        | "text_done"
        | "function_call_output";
      functionCallParams?: string;
      id?: string;
    }
  | { type: "control"; action: "session_created"; id?: string }
  | { type: "control"; action: "error"; error: OpenAIError; id?: string }
  | {
      type: "control";
      action: "rate_limits_updated";
      rateLimits: RateLimits;
      id?: string;
    };

export type FunctionCallResponse = {
  type: "function_call_output";
  call_id: string;
  output: string;
};

export type SystemMessageTool = {
  type?: string;
  name?: string;
  description?: string;
  parameters?: any;
};

export type SystemMessage = {
  type: "car-controller";
  initialInstructions: string;
  message: string;
  tools?: SystemMessageTool[];
};

export type AudioMetrics = {
  totalBytesSent: number;
  totalBatchesSent: number;
  maxBatchSize: number;
  lastSendTime: number;
  droppedChunks: number;
  avgLatency: number;
  lastResponseTime: number;
  sessionStartTime: number;
  totalResponses: number;
};

export type OpenAIError = {
  type: string;
  code?: string;
  message: string;
  event_id?: string;
};

export type RateLimits = {
  name: string;
  limit: number;
  remaining: number;
  reset_seconds: number;
};

// ==================== COMPACT COMMAND PROTOCOL ====================
/*
 * Compact array format: [msg, type, ...params]
 *
 * Type codes: 1=move, 2=led, 3=beep, 4=play
 *
 * Move (type=1): [msg, 1, action, speed, duration?]
 *   Actions: 0=stop, 1=forward, 2=backward, 3=left, 4=right, 5=fl, 6=fr, 7=bl, 8=br
 *
 * LED (type=2): [msg, 2, led_num, on_off]
 *
 * Beep (type=3): [msg, 3, on_off, duration?]
 *
 * Play (type=4): [msg, 4, song]
 *   Songs: 0=stop, 1=pirates, 2=got, 3=squid
 */
export type CompactCommand = (string | number)[];

export type CompactCommandMessage = {
  c: CompactCommand[];
};

// Message from frontend to directly control car (bypasses AI)
export type CarDirectControl = {
  type: "car_direct_control";
  c: CompactCommand[];
};

// Message sent to ESP32 (compact format)
export type CarControlMessage = {
  type: "car_control";
  c: CompactCommand[];
};
