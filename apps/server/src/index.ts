import "./load-env";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { defaultRecordingsDir } from "./paths";
import { env } from "@my-better-t-app/env/server";
import cors from "cors";
import express from "express";
import { Server as SocketIOServer } from "socket.io";
import type { Socket } from "socket.io";

const SERVER_PORT = Number(process.env.PORT) || 3001;

const RECORDINGS_DIR = process.env.RECORDINGS_DIR
  ? path.resolve(process.env.RECORDINGS_DIR)
  : defaultRecordingsDir();
function allowedBrowserOrigins(): string[] {
  const listed = process.env.CORS_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (listed && listed.length > 0) {
    return [...new Set(listed)];
  }
  const devExtras =
    env.NODE_ENV === "development"
      ? [
          env.CORS_ORIGIN,
          "http://localhost:3000",
          "http://127.0.0.1:3000",
          "http://[::1]:3000",
        ]
      : [env.CORS_ORIGIN];
  return [...new Set(devExtras)];
}

const BROWSER_ORIGINS = allowedBrowserOrigins();

type AudioSession = {
  mimeType?: string;
  chunkCount: number;
  totalBytes: number;
  lastSeq: number;
  buffers: Buffer[];
  /** Text from Web Speech `isFinal` segments. */
  transcriptCommitted: string;
  /** Latest non-final (interim) text — browsers often never send finals before stop. */
  transcriptInterim: string;
};

const sessions = new Map<string, AudioSession>();

function transcriptToSave(session: AudioSession): string {
  const parts = [session.transcriptCommitted, session.transcriptInterim]
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.join(" ").trim();
}

function extFromMime(mime?: string): string {
  if (!mime) {
    return "webm";
  }
  if (mime.includes("mp4")) {
    return "m4a";
  }
  if (mime.includes("webm")) {
    return "webm";
  }
  return "bin";
}

const app = express();
app.use(
  cors({
    origin: BROWSER_ORIGINS,
    methods: ["GET", "POST", "OPTIONS"],
  }),
);
app.get("/", (_req, res) => {
  res.type("text/plain").send("OK");
});

app.use(
  "/recordings",
  express.static(RECORDINGS_DIR, {
    etag: true,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".webm")) {
        res.setHeader("Content-Type", "audio/webm");
      } else if (filePath.endsWith(".m4a")) {
        res.setHeader("Content-Type", "audio/mp4");
      } else if (filePath.endsWith(".txt")) {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
    },
  }),
);

const server = createServer(app);

const io = new SocketIOServer(server, {
  cors: {
    origin: BROWSER_ORIGINS,
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
  connectTimeout: 20_000,
  maxHttpBufferSize: 50e6,
});

function handleAudioStart(
  socket: Socket,
  msg: { audioSessionId?: string; mimeType?: string },
): void {
  const audioSessionId = msg.audioSessionId;
  if (!audioSessionId) {
    socket.emit("audio:error", { code: "MISSING_AUDIO_SESSION_ID" });
    return;
  }
  sessions.set(audioSessionId, {
    mimeType: msg.mimeType,
    chunkCount: 0,
    totalBytes: 0,
    lastSeq: -1,
    buffers: [],
    transcriptCommitted: "",
    transcriptInterim: "",
  });
  socket.emit("audio:ack", {
    phase: "started",
    audioSessionId,
    mimeType: msg.mimeType ?? null,
  });
}

function handleAudioChunk(
  socket: Socket,
  msg: { audioSessionId?: string; seq?: number; base64?: string },
): void {
  const audioSessionId = msg.audioSessionId;
  const seq = msg.seq;
  const base64 = msg.base64;
  if (!audioSessionId || typeof seq !== "number" || typeof base64 !== "string") {
    socket.emit("audio:error", { code: "INVALID_CHUNK" });
    return;
  }
  const session = sessions.get(audioSessionId);
  if (!session) {
    socket.emit("audio:error", {
      code: "UNKNOWN_AUDIO_SESSION",
      audioSessionId,
    });
    return;
  }
  if (seq !== session.lastSeq + 1) {
    socket.emit("audio:error", {
      code: "SEQ_GAP",
      audioSessionId,
      expected: session.lastSeq + 1,
      got: seq,
    });
    return;
  }
  let chunk: Buffer;
  try {
    chunk = Buffer.from(base64, "base64");
  } catch {
    socket.emit("audio:error", { code: "INVALID_BASE64", audioSessionId });
    return;
  }
  session.buffers.push(chunk);
  const approxBytes = chunk.length;
  session.lastSeq = seq;
  session.chunkCount += 1;
  session.totalBytes += approxBytes;
  console.log("[audio:chunk]", {
    audioSessionId,
    seq,
    base64Chars: base64.length,
    bytes: approxBytes,
    chunkCount: session.chunkCount,
    totalBytes: session.totalBytes,
  });
  socket.emit("audio:ack", {
    phase: "chunk",
    audioSessionId,
    seq,
    chunkCount: session.chunkCount,
  });
}

function handleAudioEnd(socket: Socket, msg: { audioSessionId?: string; lastSeq?: number }): void {
  const audioSessionId = msg.audioSessionId;
  const lastSeq = msg.lastSeq;
  console.log("[audio:end] received", { audioSessionId, lastSeq });
  if (!audioSessionId || typeof lastSeq !== "number") {
    socket.emit("audio:error", { code: "INVALID_END" });
    return;
  }
  const session = sessions.get(audioSessionId);
  if (!session) {
    console.log("[audio:end] no session", { audioSessionId });
    socket.emit("audio:error", {
      code: "UNKNOWN_AUDIO_SESSION",
      audioSessionId,
    });
    return;
  }
  if (lastSeq !== session.lastSeq) {
    console.log("[audio:end] seq mismatch", {
      audioSessionId,
      expectedLastSeq: session.lastSeq,
      gotLastSeq: lastSeq,
    });
    socket.emit("audio:error", {
      code: "END_SEQ_MISMATCH",
      audioSessionId,
      expectedLastSeq: session.lastSeq,
      gotLastSeq: lastSeq,
    });
    return;
  }

  const merged = Buffer.concat(session.buffers);
  console.log("[audio:end] merged", {
    audioBytes: merged.length,
    audioSessionId,
    lastSeq,
    chunkCount: session.chunkCount,
    totalBytes: session.totalBytes,
  });

  try {
    mkdirSync(RECORDINGS_DIR, { recursive: true });
  } catch (e) {
    socket.emit("audio:error", {
      code: "RECORDINGS_DIR_MKDIR_FAILED",
      message: e instanceof Error ? e.message : String(e),
      recordingsDir: RECORDINGS_DIR,
    });
    sessions.delete(audioSessionId);
    return;
  }

  const ext = extFromMime(session.mimeType);
  const baseName = path.join(RECORDINGS_DIR, audioSessionId);
  const audioPath = `${baseName}.${ext}`;
  const transcriptPath = `${baseName}.txt`;

  const transcriptText = transcriptToSave(session);

  try {
    if (merged.length > 0) {
      writeFileSync(audioPath, merged);
    }
    writeFileSync(transcriptPath, transcriptText, "utf8");
  } catch (e) {
    socket.emit("audio:error", {
      code: "SAVE_FAILED",
      message: e instanceof Error ? e.message : String(e),
      recordingsDir: RECORDINGS_DIR,
    });
    sessions.delete(audioSessionId);
    return;
  }

  const absAudio = merged.length > 0 ? path.resolve(audioPath) : null;
  const absTranscript = path.resolve(transcriptPath);
  console.log("[audio:end] saved", {
    audioBytes: merged.length,
    audioFile: absAudio,
    transcriptFile: absTranscript,
    transcriptChars: transcriptText.length,
  });

  const audioBasename = merged.length > 0 ? path.basename(audioPath) : null;
  const transcriptBasename = path.basename(transcriptPath);

  socket.emit("audio:ack", {
    phase: "ended",
    audioSessionId,
    chunkCount: session.chunkCount,
    totalBytes: session.totalBytes,
    savedAudioBytes: merged.length,
    savedAudioFile: audioBasename,
    savedTranscriptFile: transcriptBasename,
    recordingsDir: RECORDINGS_DIR,
    savedAudioPath: absAudio,
    savedTranscriptPath: absTranscript,
    recordingAudioUrl: audioBasename ? `/recordings/${audioBasename}` : null,
    recordingTranscriptUrl: `/recordings/${transcriptBasename}`,
  });
  sessions.delete(audioSessionId);
}

function handleTranscript(
  socket: Socket,
  msg: { audioSessionId?: string; text?: string; isFinal?: boolean; seq?: number },
): void {
  const audioSessionId = msg.audioSessionId;
  if (!audioSessionId || typeof msg.text !== "string") {
    socket.emit("transcript:error", { code: "INVALID_TRANSCRIPT" });
    return;
  }
  const session = sessions.get(audioSessionId);
  if (!session) {
    socket.emit("transcript:error", {
      code: "UNKNOWN_AUDIO_SESSION",
      audioSessionId,
    });
    return;
  }

  const piece = msg.text.trim();
  if (piece !== "") {
    if (msg.isFinal) {
      session.transcriptCommitted =
        session.transcriptCommitted === ""
          ? piece
          : `${session.transcriptCommitted} ${piece}`;
      session.transcriptInterim = "";
    } else {
      session.transcriptInterim = piece;
    }
  }

  socket.emit("transcript:ack", {
    audioSessionId,
    seq: msg.seq ?? 0,
    isFinal: Boolean(msg.isFinal),
    charLength: msg.text.length,
    savedPreviewChars: transcriptToSave(session).length,
  });
}

io.on("connection", (socket) => {
  socket.on("audio:start", (msg: { audioSessionId?: string; mimeType?: string }) => {
    handleAudioStart(socket, msg);
  });
  socket.on(
    "audio:chunk",
    (msg: { audioSessionId?: string; seq?: number; base64?: string }) => {
      handleAudioChunk(socket, msg);
    },
  );
  socket.on("audio:end", (msg: { audioSessionId?: string; lastSeq?: number }) => {
    handleAudioEnd(socket, msg);
  });
  socket.on(
    "transcript",
    (msg: { audioSessionId?: string; text?: string; isFinal?: boolean; seq?: number }) => {
      handleTranscript(socket, msg);
    },
  );
});

server.listen(SERVER_PORT, () => {
  console.log(`HTTP + Socket.IO on http://localhost:${SERVER_PORT}`);
  console.log(`CORS allowed origins → ${BROWSER_ORIGINS.join(", ")}`);
  console.log(`Recordings → ${RECORDINGS_DIR}`);
});
