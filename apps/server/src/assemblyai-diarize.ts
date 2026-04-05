import { readFileSync } from "node:fs";

const API_BASE = "https://api.assemblyai.com/v2";

export type DiarizeUtterance = {
  speaker: string;
  start: number;
  end: number;
  text: string;
};

export type DiarizeResult = {
  utterances: DiarizeUtterance[];
  fullText: string;
};

/**
 * AssemblyAI returns speakers as "A", "B", "C" — map to 1, 2, 3 for display.
 */
export function assemblySpeakerToNumber(label: string): number {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function diarizeWithAssemblyAI(
  audioFilePath: string,
  apiKey: string,
): Promise<DiarizeResult> {
  const audioBuffer = readFileSync(audioFilePath);

  const uploadRes = await fetch(`${API_BASE}/upload`, {
    method: "POST",
    headers: {
      authorization: apiKey,
    },
    body: audioBuffer,
  });

  if (!uploadRes.ok) {
    const body = await uploadRes.text();
    throw new Error(`AssemblyAI upload ${uploadRes.status}: ${body}`);
  }

  const { upload_url: uploadUrl } = (await uploadRes.json()) as { upload_url: string };

  const createRes = await fetch(`${API_BASE}/transcript`, {
    method: "POST",
    headers: {
      authorization: apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      audio_url: uploadUrl,
      speech_models: ["universal-2"],
      speaker_labels: true,
    }),
  });

  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`AssemblyAI create transcript ${createRes.status}: ${body}`);
  }

  const { id: transcriptId } = (await createRes.json()) as { id: string };

  const deadline = Date.now() + 15 * 60_000;

  while (Date.now() < deadline) {
    await sleep(2500);

    const pollRes = await fetch(`${API_BASE}/transcript/${transcriptId}`, {
      headers: { authorization: apiKey },
    });

    if (!pollRes.ok) {
      const body = await pollRes.text();
      throw new Error(`AssemblyAI poll ${pollRes.status}: ${body}`);
    }

    const data = (await pollRes.json()) as {
      status: string;
      error?: string;
      utterances?: Array<{
        speaker: string;
        start: number;
        end: number;
        text: string;
      }>;
      text?: string;
    };

    if (data.status === "completed") {
      const utterances: DiarizeUtterance[] =
        data.utterances?.map((u) => ({
          speaker: u.speaker,
          start: u.start,
          end: u.end,
          text: u.text.trim(),
        })) ?? [];

      const fullText =
        data.text?.trim() ?? utterances.map((u) => u.text).join(" ").trim();

      return { utterances, fullText };
    }

    if (data.status === "error") {
      throw new Error(data.error ?? "AssemblyAI transcript failed");
    }
  }

  throw new Error("AssemblyAI diarization timed out (15 min)");
}

export function formatSpeakersTxt(utterances: DiarizeUtterance[]): string {
  const lines: string[] = [];
  for (const u of utterances) {
    const n = assemblySpeakerToNumber(u.speaker);
    const t0 = (u.start / 1000).toFixed(1);
    const t1 = (u.end / 1000).toFixed(1);
    lines.push(`Speaker ${n} [${t0}s–${t1}s]: ${u.text}`);
  }
  return lines.join("\n");
}
