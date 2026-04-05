"use client";

import { env } from "@my-better-t-app/env/web";
import { Button } from "@my-better-t-app/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@my-better-t-app/ui/components/card";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

const CHUNK_INTERVAL_MS = 2000;

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: { isFinal: boolean; 0: { transcript: string } };
  };
};

type SpeechRecognitionErrorLike = { error: string };

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") {
    return null;
  }
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Expected data URL string"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("FileReader failed"));
    };
    reader.readAsDataURL(blob);
  });
}

function formatLine(payload: unknown): string {
  const short = JSON.stringify(payload);
  return short.length > 200 ? `${short.slice(0, 200)}…` : short;
}

function joinApiUrl(apiBase: string, pathname: string): string {
  const base = apiBase.replace(/\/$/, "");
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${base}${path}`;
}

export default function StreamToServer() {
  const [ready, setReady] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [socketLine, setSocketLine] = useState("Idle.");
  const [committedTranscript, setCommittedTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [speechOk, setSpeechOk] = useState(false);
  const [chunkCount, setChunkCount] = useState(0);
  const [localChunkCount, setLocalChunkCount] = useState(0);
  /**
   * After Stop: true until server merge + save completes and final transcript is fetched.
   * No live merged audio preview — only this gate before showing final URLs + player.
   */
  const [isProcessingFinal, setIsProcessingFinal] = useState(false);
  const [savedRecording, setSavedRecording] = useState<{
    audioUrl: string | null;
    transcriptUrl: string;
  } | null>(null);
  const [savedTranscriptText, setSavedTranscriptText] = useState<string | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const seqRef = useRef(-1);
  const chunkSendChainRef = useRef(Promise.resolve());
  const transcriptSeqRef = useRef(0);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const recordingActiveRef = useRef(false);
  /** Mirrors speech results so we can flush interim as `final` on Stop (API often omits finals). */
  const latestInterimRef = useRef("");
  const latestCommittedRef = useRef("");

  useEffect(() => {
    setSpeechOk(getSpeechRecognitionCtor() !== null);
  }, []);

  useEffect(() => {
    const socket = io(env.NEXT_PUBLIC_SERVER_URL, {
      transports: ["websocket", "polling"],
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 1000,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setReady(true);
      setSocketLine("Socket.IO connected.");
    });
    socket.on("disconnect", () => {
      setReady(false);
      setSocketLine("Socket.IO disconnected.");
    });
    socket.on("connect_error", (err) => {
      setReady(false);
      setSocketLine(
        `Cannot reach API at ${env.NEXT_PUBLIC_SERVER_URL} (${err.message}). Start the server on 3001, set CORS_ORIGIN (or CORS_ORIGINS) to match how you open the app — http://localhost:3000 and http://127.0.0.1:3000 are different.`,
      );
    });
    socket.on("audio:ack", (p: unknown) => {
      if (p && typeof p === "object" && "phase" in p) {
        const phase = (p as { phase: string }).phase;
        if (phase === "chunk") {
          const o = p as { chunkCount?: number };
          if (typeof o.chunkCount === "number") {
            setChunkCount(o.chunkCount);
          }
        }
        if (phase === "ended") {
          const o = p as {
            chunkCount?: number;
            savedAudioBytes?: number;
            recordingAudioUrl?: string | null;
            recordingTranscriptUrl?: string;
          };
          setSocketLine(
            `Done — ${o.chunkCount ?? 0} chunks, ${o.savedAudioBytes ?? 0} bytes saved.`,
          );
          const tPath = o.recordingTranscriptUrl;
          if (typeof tPath === "string") {
            const transcriptUrl = joinApiUrl(env.NEXT_PUBLIC_SERVER_URL, tPath);
            const audioUrl = o.recordingAudioUrl
              ? joinApiUrl(env.NEXT_PUBLIC_SERVER_URL, o.recordingAudioUrl)
              : null;
            setSavedRecording({ audioUrl, transcriptUrl });
            setSavedTranscriptText(null);
            void fetch(transcriptUrl)
              .then((r) => {
                if (!r.ok) {
                  throw new Error(String(r.status));
                }
                return r.text();
              })
              .then((txt) => {
                setSavedTranscriptText(txt.trim() === "" ? "(empty transcript)" : txt);
              })
              .catch(() => {
                setSavedTranscriptText("(Could not load transcript — check API CORS and URL.)");
              })
              .finally(() => {
                setIsProcessingFinal(false);
              });
          } else {
            setIsProcessingFinal(false);
          }
        } else {
          setSocketLine(formatLine(p));
        }
      } else {
        setSocketLine(formatLine(p));
      }
    });
    socket.on("audio:error", (p: unknown) => {
      setIsProcessingFinal(false);
      setSocketLine(formatLine(p));
    });
    socket.on("transcript:error", (p: unknown) => {
      setSocketLine(formatLine(p));
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  /**
   * Stops Web Speech. Before tearing it down, emits one last Socket.IO `transcript` with
   * `isFinal: true` when there is still interim text (so the server can persist it).
   */
  const stopSpeechRecognition = useCallback(() => {
    const sid = sessionIdRef.current;
    const sock = socketRef.current;
    const interimFlush = latestInterimRef.current.trim();
    if (interimFlush && sid && sock?.connected) {
      transcriptSeqRef.current += 1;
      sock.emit("transcript", {
        audioSessionId: sid,
        text: interimFlush,
        isFinal: true,
        seq: transcriptSeqRef.current,
      });
    }
    latestInterimRef.current = "";

    recordingActiveRef.current = false;
    const r = recognitionRef.current;
    recognitionRef.current = null;
    if (r) {
      try {
        r.stop();
      } catch {
        try {
          r.abort();
        } catch {
          /* ignore */
        }
      }
    }
    setInterimTranscript("");
  }, []);

  /**
   * Stop order (all Socket.IO → same `audioSessionId` until cleared):
   * 1. `transcript` (optional final flush) — see stopSpeechRecognition
   * 2. Last `audio:chunk`(s) from MediaRecorder `stop` / `requestData`
   * 3. `audio:end` — after in-flight chunk emits finish (recorder.onstop chain)
   */
  const stop = useCallback(() => {
    stopSpeechRecognition();
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      try {
        if (rec.state === "recording") {
          rec.requestData();
        }
      } catch {
        /* ignore */
      }
      rec.stop();
    } else {
      streamRef.current?.getTracks().forEach((t) => {
        t.stop();
      });
      streamRef.current = null;
      sessionIdRef.current = null;
      seqRef.current = -1;
      chunkSendChainRef.current = Promise.resolve();
      recorderRef.current = null;
      setStreaming(false);
      setChunkCount(0);
      setLocalChunkCount(0);
      setIsProcessingFinal(false);
    }
  }, [stopSpeechRecognition]);

  const start = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket) {
      setSocketLine("No socket — refresh the page.");
      return;
    }
    if (!socket.connected) {
      setSocketLine(
        `Not connected yet. Open ${env.NEXT_PUBLIC_SERVER_URL} in a browser (should say OK). That must be the API (e.g. :3001), not the Next app (e.g. :3000).`,
      );
      socket.connect();
      return;
    }

    setCommittedTranscript("");
    setInterimTranscript("");
    latestInterimRef.current = "";
    latestCommittedRef.current = "";
    transcriptSeqRef.current = 0;
    setChunkCount(0);
    setLocalChunkCount(0);
    setSavedRecording(null);
    setSavedTranscriptText(null);
    setIsProcessingFinal(false);

    const mimeCandidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m));

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;

    const audioSessionId = crypto.randomUUID();
    sessionIdRef.current = audioSessionId;
    seqRef.current = -1;
    chunkSendChainRef.current = Promise.resolve();

    socket.emit("audio:start", {
      audioSessionId,
      mimeType,
    });

    const Ctor = getSpeechRecognitionCtor();
    if (Ctor) {
      recordingActiveRef.current = true;
      const recognition = new Ctor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || "en-US";

      recognition.onresult = (event: SpeechRecognitionEventLike) => {
        const sid = sessionIdRef.current;
        const sock = socketRef.current;
        if (!sid || !sock?.connected) {
          return;
        }

        let interim = "";
        let newFinal = "";
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const row = event.results[i];
          const piece = row[0]?.transcript ?? "";
          if (row.isFinal) {
            newFinal += piece;
          } else {
            interim += piece;
          }
        }

        setInterimTranscript(interim);
        latestInterimRef.current = interim;
        if (newFinal) {
          latestCommittedRef.current += newFinal;
          setCommittedTranscript(latestCommittedRef.current);
        }

        const textToSend = newFinal || interim;
        if (textToSend.trim() === "") {
          return;
        }

        transcriptSeqRef.current += 1;
        sock.emit("transcript", {
          audioSessionId: sid,
          text: textToSend,
          isFinal: newFinal.length > 0,
          seq: transcriptSeqRef.current,
        });
      };

      recognition.onerror = (ev: SpeechRecognitionErrorLike) => {
        setSocketLine(`Speech: ${ev.error}`);
      };

      recognition.onend = () => {
        if (recordingActiveRef.current && recognitionRef.current) {
          try {
            recognitionRef.current.start();
          } catch {
            /* already running */
          }
        }
      };

      recognitionRef.current = recognition;
      try {
        recognition.start();
      } catch (e) {
        setSocketLine(`Speech start failed: ${e instanceof Error ? e.message : String(e)}`);
        recognitionRef.current = null;
        recordingActiveRef.current = false;
      }
    }

    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorderRef.current = recorder;

    recorder.ondataavailable = (ev) => {
      if (ev.data.size === 0) {
        return;
      }
      setLocalChunkCount((n) => n + 1);

      const s = socketRef.current;
      const sid = sessionIdRef.current;
      if (!s?.connected || !sid) {
        setSocketLine("Chunk captured but not sent — reconnect and start again.");
        return;
      }

      const blob = ev.data;
      chunkSendChainRef.current = chunkSendChainRef.current
        .then(async () => {
          seqRef.current += 1;
          const seq = seqRef.current;
          const base64 = await blobToBase64(blob);
          const sock = socketRef.current;
          if (!sock?.connected || sessionIdRef.current !== sid) {
            return;
          }
          sock.emit("audio:chunk", {
            audioSessionId: sid,
            seq,
            base64,
          });
        })
        .catch(() => {
          /* keep chain alive */
        });
    };

    recorder.onstop = () => {
      void chunkSendChainRef.current.then(() => {
        const s = socketRef.current;
        const sid = sessionIdRef.current;
        const lastSeq = seqRef.current;
        if (s?.connected && sid) {
          setIsProcessingFinal(true);
          setSavedRecording(null);
          setSavedTranscriptText(null);
          // Merge + save on server → `audio:ack` phase "ended"
          s.emit("audio:end", {
            audioSessionId: sid,
            lastSeq,
          });
          setSocketLine(
            "Processing — merging all chunks on the server, writing files, preparing transcript…",
          );
        } else if (sid) {
          setIsProcessingFinal(false);
          setSocketLine(
            "Recording stopped but socket was offline — server did not merge files. Reconnect before stopping next time.",
          );
        }
        sessionIdRef.current = null;
        seqRef.current = -1;
        chunkSendChainRef.current = Promise.resolve();
        streamRef.current?.getTracks().forEach((t) => {
          t.stop();
        });
        streamRef.current = null;
        recorderRef.current = null;
        setStreaming(false);
      });
    };

    recorder.start(CHUNK_INTERVAL_MS);
    setStreaming(true);
    setSocketLine(`Recording — chunks every ${CHUNK_INTERVAL_MS / 1000}s (sent to server only).`);
  }, []);

  const hasTranscript = committedTranscript.length > 0 || interimTranscript.length > 0;

  const showFinalResult = Boolean(savedRecording && !isProcessingFinal);

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Stream to server</CardTitle>
        <CardDescription>
          API: <code className="text-xs">{env.NEXT_PUBLIC_SERVER_URL}</code> — audio chunks every{" "}
          {CHUNK_INTERVAL_MS / 1000}s. The server buffers and merges them into one file after you
          stop. Live captions use the Web Speech API (Chrome/Edge).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!speechOk ? (
          <p className="text-amber-600 text-sm dark:text-amber-400">
            Web Speech API not available — audio still streams; use Chrome for transcript.
          </p>
        ) : null}

        <div className="rounded-lg border bg-muted/20 p-3">
          <h3 className="mb-1 font-medium text-sm">Transcript (live)</h3>
          <p
            aria-live="polite"
            className="min-h-16 text-base leading-relaxed text-foreground"
          >
            {hasTranscript ? (
              <>
                <span>{committedTranscript}</span>
                {interimTranscript ? (
                  <span className="text-muted-foreground italic"> {interimTranscript}</span>
                ) : null}
              </>
            ) : streaming ? (
              <span className="text-muted-foreground">Listening…</span>
            ) : (
              <span className="text-muted-foreground text-sm">
                Start stream and speak — text appears as you talk.
              </span>
            )}
          </p>
        </div>

        <div className="rounded-lg border bg-muted/20 p-3">
          <h3 className="mb-2 font-medium text-sm">Final audio</h3>
          <p className="text-muted-foreground text-sm leading-relaxed">
            There is no preview while recording. Chunks are buffered on the server and merged into
            one file when you press <strong>Stop</strong>. After that you will see processing, then
            the final player, links, and saved transcript below.
          </p>
          <p className="mt-3 text-muted-foreground text-xs">
            Chunks captured: {localChunkCount} · Confirmed by server: {chunkCount}
          </p>
        </div>

        {isProcessingFinal ? (
          <div
            aria-busy="true"
            aria-live="polite"
            className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-primary/40 bg-muted/30 px-4 py-8"
          >
            <Loader2 aria-hidden className="size-8 animate-spin text-primary" />
            <p className="max-w-md text-center font-medium text-sm">Processing your recording</p>
            <p className="max-w-md text-center text-muted-foreground text-xs leading-relaxed">
              Merging chunk buffers on the API, writing audio and transcript files, then loading the
              final text. This usually takes a moment after the last chunk is sent.
            </p>
          </div>
        ) : null}

        {showFinalResult && savedRecording ? (
          <div className="rounded-lg border border-primary/30 bg-muted/20 p-3">
            <h3 className="mb-2 font-medium text-sm">Saved recording</h3>
            {savedRecording.audioUrl ? (
              <audio className="mb-3 w-full" controls preload="metadata" src={savedRecording.audioUrl} />
            ) : (
              <p className="mb-3 text-muted-foreground text-sm">No audio file (0 bytes merged).</p>
            )}
            <p className="mb-2 break-all text-muted-foreground text-xs">
              <span className="font-medium text-foreground">Transcript URL: </span>
              <a
                className="text-primary underline"
                href={savedRecording.transcriptUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                {savedRecording.transcriptUrl}
              </a>
              {savedRecording.audioUrl ? (
                <>
                  {" "}
                  ·{" "}
                  <a
                    className="text-primary underline"
                    href={savedRecording.audioUrl}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    Audio URL
                  </a>
                </>
              ) : null}
            </p>
            <div className="rounded-md border bg-background p-3">
              <p className="mb-1 font-medium text-muted-foreground text-xs">Transcript (from API)</p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">
                {savedTranscriptText ?? "—"}
              </p>
            </div>
          </div>
        ) : null}

        <p className="text-muted-foreground text-xs break-all">{socketLine}</p>

        <div className="flex flex-wrap gap-2">
          {!streaming ? (
            <>
              <Button onClick={() => void start()} type="button">
                Start stream
              </Button>
              {!ready ? (
                <Button
                  onClick={() => {
                    socketRef.current?.connect();
                    setSocketLine("Reconnecting…");
                  }}
                  type="button"
                  variant="outline"
                >
                  Retry connection
                </Button>
              ) : null}
            </>
          ) : (
            <Button onClick={stop} type="button" variant="destructive">
              Stop
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
