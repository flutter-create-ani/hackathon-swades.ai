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
import { cn } from "@my-better-t-app/ui/lib/utils";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

const CHUNK_INTERVAL_MS = 2000;

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

type DiarizedSegment = {
  speakerNumber: number;
  timeRangeLabel: string;
  text: string;
};

function assemblySpeakerToNumberClient(label: string): number {
  const t = label.trim().toUpperCase();
  if (/^[A-Z]$/.test(t)) {
    return t.charCodeAt(0) - 64;
  }
  const digits = label.match(/\d+/);
  if (digits) {
    const n = Number.parseInt(digits[0], 10);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  return 1;
}

function segmentsFromDiarizationJson(data: unknown): DiarizedSegment[] | null {
  if (!data || typeof data !== "object" || !("utterances" in data)) {
    return null;
  }
  const raw = (data as { utterances?: unknown }).utterances;
  if (!Array.isArray(raw)) {
    return null;
  }
  const out: DiarizedSegment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const o = item as {
      text?: unknown;
      start?: unknown;
      end?: unknown;
      speaker?: unknown;
      speakerNumber?: unknown;
    };
    if (typeof o.text !== "string") {
      continue;
    }
    const startMs = typeof o.start === "number" ? o.start : 0;
    const endMs = typeof o.end === "number" ? o.end : 0;
    const speakerNumber =
      typeof o.speakerNumber === "number" && o.speakerNumber > 0
        ? o.speakerNumber
        : typeof o.speaker === "string"
          ? assemblySpeakerToNumberClient(o.speaker)
          : 1;
    const t0 = (startMs / 1000).toFixed(1);
    const t1 = (endMs / 1000).toFixed(1);
    out.push({
      speakerNumber,
      timeRangeLabel: `${t0}s–${t1}s`,
      text: o.text.trim(),
    });
  }
  return out.length > 0 ? out : null;
}

type CapabilitiesState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; assemblyAiEnabled: boolean };

export default function StreamToServer() {
  const [capabilities, setCapabilities] = useState<CapabilitiesState>({
    status: "loading",
  });

  const [ready, setReady] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [socketLine, setSocketLine] = useState("Idle.");
  const [chunkCount, setChunkCount] = useState(0);
  const [localChunkCount, setLocalChunkCount] = useState(0);
  /**
   * After Stop: true until server merge completes and the initial transcript file is fetched.
   */
  const [isProcessingFinal, setIsProcessingFinal] = useState(false);
  const [savedRecording, setSavedRecording] = useState<{
    audioUrl: string | null;
    transcriptUrl: string;
    audioSessionId: string;
  } | null>(null);
  const [savedTranscriptText, setSavedTranscriptText] = useState<string | null>(null);

  type DiarizationUi =
    | { kind: "none" }
    | { kind: "pending" }
    | {
        kind: "ready";
        speakersUrl: string;
        jsonUrl: string;
        speakersText: string | null;
        segments: DiarizedSegment[] | null;
      }
    | { kind: "error"; message: string };

  const [diarizationUi, setDiarizationUi] = useState<DiarizationUi>({ kind: "none" });
  /** Matches `diarization:done` to the recording the user just saved (same tab). */
  const diarizationSessionIdRef = useRef<string | null>(null);
  /** Refetch main `.txt` after AssemblyAI overwrites it (avoid stale cache). */
  const transcriptUrlRef = useRef<string | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const seqRef = useRef(-1);
  const chunkSendChainRef = useRef(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    const url = joinApiUrl(env.NEXT_PUBLIC_SERVER_URL, "/capabilities");
    void fetch(url)
      .then((r) => {
        if (!r.ok) {
          throw new Error(`HTTP ${r.status}`);
        }
        return r.json() as Promise<{
          assemblyAiTranscription?: boolean;
          speakerDiarization?: boolean;
        }>;
      })
      .then((j) => {
        if (cancelled) {
          return;
        }
        const on = Boolean(
          j.assemblyAiTranscription ?? j.speakerDiarization,
        );
        setCapabilities({
          status: "ready",
          assemblyAiEnabled: on,
        });
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setCapabilities({
          status: "error",
          message: `Could not load ${url}. Is the API running?`,
        });
      });
    return () => {
      cancelled = true;
    };
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
            audioSessionId?: string;
            chunkCount?: number;
            savedAudioBytes?: number;
            recordingAudioUrl?: string | null;
            recordingTranscriptUrl?: string;
            diarizationQueued?: boolean;
          };
          setSocketLine(
            `Done — ${o.chunkCount ?? 0} chunks, ${o.savedAudioBytes ?? 0} bytes saved.`,
          );
          const tPath = o.recordingTranscriptUrl;
          const sid =
            typeof o.audioSessionId === "string" ? o.audioSessionId : "";
          if (typeof tPath === "string" && sid) {
            const transcriptUrl = joinApiUrl(env.NEXT_PUBLIC_SERVER_URL, tPath);
            const audioUrl = o.recordingAudioUrl
              ? joinApiUrl(env.NEXT_PUBLIC_SERVER_URL, o.recordingAudioUrl)
              : null;
            diarizationSessionIdRef.current = sid;
            transcriptUrlRef.current = transcriptUrl;
            setSavedRecording({ audioUrl, transcriptUrl, audioSessionId: sid });
            setSavedTranscriptText(null);
            if (o.diarizationQueued) {
              setDiarizationUi({ kind: "pending" });
            } else {
              setDiarizationUi({ kind: "none" });
            }
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

    socket.on("diarization:done", (raw: unknown) => {
      if (!raw || typeof raw !== "object") {
        return;
      }
      const d = raw as {
        audioSessionId?: string;
        ok?: boolean;
        error?: string;
        recordingSpeakersUrl?: string;
        recordingDiarizationJsonUrl?: string;
      };
      if (
        typeof d.audioSessionId !== "string" ||
        d.audioSessionId !== diarizationSessionIdRef.current
      ) {
        return;
      }
      if (d.ok) {
        const sPath = d.recordingSpeakersUrl;
        const jPath = d.recordingDiarizationJsonUrl;
        if (typeof sPath !== "string" || typeof jPath !== "string") {
          setDiarizationUi({
            kind: "error",
            message: "Invalid diarization response from server.",
          });
          return;
        }
        const speakersUrl = joinApiUrl(env.NEXT_PUBLIC_SERVER_URL, sPath);
        const jsonUrl = joinApiUrl(env.NEXT_PUBLIC_SERVER_URL, jPath);
        setDiarizationUi({
          kind: "ready",
          speakersUrl,
          jsonUrl,
          speakersText: null,
          segments: null,
        });
        void (async () => {
          const [jsonBody, txtBody] = await Promise.all([
            fetch(jsonUrl)
              .then(async (r) => (r.ok ? r.json() : null))
              .catch(() => null),
            fetch(speakersUrl)
              .then(async (r) => (r.ok ? r.text() : null))
              .catch(() => null),
          ]);

          const segments =
            jsonBody !== null ? segmentsFromDiarizationJson(jsonBody) : null;

          let speakersText: string | null = null;
          if (typeof txtBody === "string") {
            speakersText =
              txtBody.trim() === "" ? "(empty diarization)" : txtBody;
          } else if (!segments?.length) {
            speakersText =
              "(Could not load speaker transcript — check API CORS and URL.)";
          }

          setDiarizationUi((prev) =>
            prev.kind === "ready" && prev.jsonUrl === jsonUrl
              ? { ...prev, segments, speakersText }
              : prev,
          );

          const tUrl = transcriptUrlRef.current;
          if (tUrl) {
            const bust = `${tUrl}${tUrl.includes("?") ? "&" : "?"}t=${Date.now()}`;
            void fetch(bust)
              .then((r) => {
                if (!r.ok) {
                  throw new Error(String(r.status));
                }
                return r.text();
              })
              .then((txt) => {
                const s = txt.trim();
                setSavedTranscriptText(
                  s === "" ? "(empty transcript)" : s,
                );
              })
              .catch(() => {
                /* keep existing placeholder text */
              });
          }
        })();
      } else {
        setDiarizationUi({
          kind: "error",
          message: d.error ?? "AssemblyAI processing failed.",
        });
        setSavedTranscriptText(
          `(AssemblyAI error: ${d.error ?? "unknown"})`,
        );
      }
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  /**
   * Stop: last `audio:chunk`(s) from MediaRecorder, then `audio:end` after the emit chain.
   */
  const stop = useCallback(() => {
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
  }, []);

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

    setChunkCount(0);
    setLocalChunkCount(0);
    setSavedRecording(null);
    setSavedTranscriptText(null);
    setIsProcessingFinal(false);
    setDiarizationUi({ kind: "none" });
    diarizationSessionIdRef.current = null;
    transcriptUrlRef.current = null;

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
            "Processing — merging chunks on the server; transcript comes from AssemblyAI when configured…",
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

  const showFinalResult = Boolean(savedRecording && !isProcessingFinal);

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Stream to server</CardTitle>
        <CardDescription>
          API: <code className="text-xs">{env.NEXT_PUBLIC_SERVER_URL}</code> — audio chunks every{" "}
          {CHUNK_INTERVAL_MS / 1000}s. After <strong>Stop</strong>, the server merges audio and sends
          it to <strong>AssemblyAI</strong> for transcription and speaker labels (when the API key is
          set). There is no live captioning in the browser.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div
          aria-live="polite"
          className="rounded-lg border bg-muted/15 px-3 py-2 text-xs leading-relaxed"
        >
          <span className="font-medium text-foreground">API features: </span>
          {capabilities.status === "loading" ? (
            <span className="text-muted-foreground">Checking…</span>
          ) : null}
          {capabilities.status === "error" ? (
            <span className="text-amber-700 dark:text-amber-400">{capabilities.message}</span>
          ) : null}
          {capabilities.status === "ready" ? (
            <>
              <span className="text-muted-foreground">AssemblyAI (transcript + speakers) — </span>
              {capabilities.assemblyAiEnabled ? (
                <span className="font-medium text-green-700 dark:text-green-400">enabled</span>
              ) : (
                <span className="text-muted-foreground">
                  off (set <code className="text-[11px]">ASSEMBLYAI_API_KEY</code> on the server and
                  restart)
                </span>
              )}
            </>
          ) : null}
        </div>

        <div className="rounded-lg border bg-muted/20 p-3">
          <h3 className="mb-1 font-medium text-sm">Transcription</h3>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Text is <strong>not</strong> shown while you record. After you stop, the merged file is
            transcribed on the server via AssemblyAI (full text in the{" "}
            <code className="text-xs">.txt</code> file; per-speaker lines appear below when the key is
            set).
          </p>
        </div>

        <div className="rounded-lg border bg-muted/20 p-3">
          <h3 className="mb-2 font-medium text-sm">Final audio</h3>
          <p className="text-muted-foreground text-sm leading-relaxed">
            There is no preview while recording. Chunks are buffered on the server and merged into
            one file when you press <strong>Stop</strong>. Then the API saves audio and runs
            AssemblyAI when configured.
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
              Merging chunk buffers and saving files on the API. This usually finishes quickly after
              the last chunk is sent.
            </p>
            {capabilities.status === "ready" && capabilities.assemblyAiEnabled ? (
              <p className="max-w-md text-center text-muted-foreground text-xs leading-relaxed">
                AssemblyAI then transcribes the audio and detects speakers; the main transcript and
                per-speaker blocks update when that job completes (often slower than the merge).
              </p>
            ) : null}
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
              <p className="mb-1 font-medium text-muted-foreground text-xs">
                Full transcript (AssemblyAI, <code className="text-[11px]">.txt</code>)
              </p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">
                {savedTranscriptText ?? "—"}
              </p>
            </div>

            {diarizationUi.kind === "pending" ? (
              <div
                aria-busy="true"
                aria-live="polite"
                className="mt-3 flex flex-col gap-2 rounded-md border border-dashed border-primary/30 bg-muted/20 p-3"
              >
                <div className="flex items-center gap-2 text-sm">
                  <Loader2 aria-hidden className="size-4 animate-spin text-primary" />
                  <span className="font-medium">AssemblyAI: transcription &amp; speakers</span>
                </div>
                <p className="text-muted-foreground text-xs leading-relaxed">
                  Running on the server. The full transcript above refreshes when the job finishes;
                  per-speaker lines appear below.
                </p>
              </div>
            ) : null}

            {diarizationUi.kind === "ready" ? (
              <div className="mt-3 rounded-md border border-primary/20 bg-background p-3">
                <p className="mb-2 font-medium text-sm">Per-speaker transcript (AssemblyAI)</p>
                <p className="mb-2 break-all text-muted-foreground text-xs">
                  <a
                    className="text-primary underline"
                    href={diarizationUi.speakersUrl}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    Speakers (.txt)
                  </a>
                  {" · "}
                  <a
                    className="text-primary underline"
                    href={diarizationUi.jsonUrl}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    Full JSON
                  </a>
                </p>
                {diarizationUi.segments && diarizationUi.segments.length > 0 ? (
                  <>
                    <p className="mb-3 text-muted-foreground text-xs leading-relaxed">
                      {(() => {
                        const n = new Set(
                          diarizationUi.segments.map((s) => s.speakerNumber),
                        ).size;
                        return `Detected ${n} distinct speaker${n === 1 ? "" : "s"}. Each block is one stretch of speech (AssemblyAI may split overlaps into turns).`;
                      })()}
                    </p>
                    <ul className="m-0 flex list-none flex-col gap-2 p-0">
                      {diarizationUi.segments.map((seg, i) => (
                        <li
                          className={cn(
                            "rounded-lg border p-3",
                            seg.speakerNumber % 2 === 1
                              ? "border-primary/20 bg-primary/5"
                              : "border-border bg-muted/25",
                          )}
                          key={`${seg.speakerNumber}-${i}-${seg.timeRangeLabel}`}
                        >
                          <p className="text-xs">
                            <span className="font-semibold text-foreground">
                              Speaker {seg.speakerNumber} says
                            </span>
                            <span className="text-muted-foreground">
                              {" "}
                              ({seg.timeRangeLabel})
                            </span>
                          </p>
                          <p className="mt-1.5 text-sm leading-relaxed">
                            {seg.text}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}

                {diarizationUi.segments?.length ? (
                  <details className="mt-3 rounded-md border bg-muted/10 p-2">
                    <summary className="cursor-pointer font-medium text-muted-foreground text-xs">
                      Plain text export (same as .txt file)
                    </summary>
                    <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed">
                      {diarizationUi.speakersText ?? "Loading…"}
                    </p>
                  </details>
                ) : (
                  <>
                    <p className="mb-1 font-medium text-muted-foreground text-xs">
                      Labeled lines (preview)
                    </p>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">
                      {diarizationUi.speakersText ?? "Loading…"}
                    </p>
                  </>
                )}
              </div>
            ) : null}

            {diarizationUi.kind === "error" ? (
              <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                <p className="font-medium text-destructive text-sm">AssemblyAI failed</p>
                <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
                  {diarizationUi.message}
                </p>
              </div>
            ) : null}
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
