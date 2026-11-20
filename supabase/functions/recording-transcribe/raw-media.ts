import {
  ALL_FORMATS, AdtsOutputFormat, BufferSource, BufferTarget, Conversion, FlacOutputFormat,
  Input, Mp3OutputFormat, OggOutputFormat, Output, UrlSource, WavOutputFormat,
} from "npm:mediabunny@1.65.0";
import type { AudioCodec, OutputFormat } from "npm:mediabunny@1.65.0";
import { maxRecordingSeconds } from "./audio-plan.ts";
import type { partWindow } from "./audio-plan.ts";

type Window = ReturnType<typeof partWindow>;
export const maxRawPieceBytes = 8 * 1024 * 1024;

export class AudioSourceError extends Error {
  constructor(readonly code: string, readonly status = 422) {
    super(code);
  }
}

function outputFormat(codec: AudioCodec | null): { format: OutputFormat; mimeType: string } {
  if (codec === "aac") return { format: new AdtsOutputFormat(), mimeType: "audio/aac" };
  if (codec === "mp3") return { format: new Mp3OutputFormat(), mimeType: "audio/mpeg" };
  if (codec === "opus" || codec === "vorbis") return { format: new OggOutputFormat(), mimeType: "audio/ogg" };
  if (codec === "flac") return { format: new FlacOutputFormat(), mimeType: "audio/flac" };
  if (codec?.startsWith("pcm-") || codec === "ulaw" || codec === "alaw") {
    return { format: new WavOutputFormat(), mimeType: "audio/wav" };
  }
  throw new AudioSourceError("audio_codec");
}

export async function openRawAudio(source: string | Uint8Array) {
  let transportError: AudioSourceError | null = null;
  const input = new Input({
    source: typeof source === "string"
      ? new UrlSource(source, {
        maxCacheSize: 4 * 1024 * 1024,
        parallelism: 1,
        getRetryDelay: () => null,
        requestInit: { redirect: "error", cache: "no-store" },
        fetchFn: async (url, init) => {
          try {
            const response = await fetch(url, init);
            if (response.status === 429 || response.status >= 500) {
              await response.body?.cancel();
              throw new AudioSourceError("source_unavailable", response.status);
            }
            return response;
          } catch (error) {
            transportError = error instanceof AudioSourceError ? error : new AudioSourceError("source_unavailable", 502);
            throw transportError;
          }
        },
      })
      : new BufferSource(source),
    formats: ALL_FORMATS,
  });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new AudioSourceError("decode_audio");
    const codec = await track.getCodec();
    outputFormat(codec);
    const firstTimestamp = Math.max(0, await track.getFirstTimestamp());
    const length = await track.computeDuration() - firstTimestamp;
    if (!Number.isFinite(length) || length <= 0) throw new AudioSourceError("decode_audio");
    // AAC packet padding may extend a three-hour recording by a fraction of a second.
    if (length > maxRecordingSeconds + 0.25) throw new AudioSourceError("duration");
    const duration = Math.min(length, maxRecordingSeconds);
    const channels = await track.getNumberOfChannels();
    const rate = await track.getSampleRate();
    const uncompressed = codec?.startsWith("pcm-") || codec === "ulaw" || codec === "alaw";
    const bits = Number(codec?.match(/^pcm-[suf](\d+)/)?.[1] ?? 8);
    const pcmBytesPerSecond = rate * channels * bits / 8;
    return {
      duration,
      codec,
      close: () => input.dispose(),
      async extract(wanted: Window) {
        try {
        let seconds = wanted.end - wanted.boundary;
        let overlap = wanted.boundary - wanted.start;
        if (uncompressed) {
          const safeDuration = maxRawPieceBytes / pcmBytesPerSecond / 1.1;
          overlap = Math.min(overlap, safeDuration / 4);
          seconds = Math.min(seconds, safeDuration - overlap);
        }
        for (let attempt = 0; attempt < 12; attempt++) {
          const window = {
            boundary: wanted.boundary,
            start: Math.max(0, wanted.boundary - overlap),
            end: Math.min(wanted.end, wanted.boundary + seconds),
          };
          const target = new BufferTarget();
          const { format, mimeType } = outputFormat(codec);
          const output = new Output({ format, target });
          const conversion = await Conversion.init({
            input, output,
            tracks: "primary",
            video: { discard: true },
            trim: { start: firstTimestamp + window.start, end: firstTimestamp + window.end },
            copy: { mode: "forced", shiftTolerance: 1 },
            tags: () => ({}),
            showWarnings: false,
          });
          if (!conversion.isValid) throw new AudioSourceError("audio_codec");
          await conversion.execute();
          if (!target.buffer?.byteLength) throw new AudioSourceError("decode_audio");
          if (target.buffer.byteLength <= maxRawPieceBytes) {
            return { bytes: new Uint8Array(target.buffer), mimeType, window };
          }
          seconds /= 2;
          overlap /= 2;
        }
        throw new AudioSourceError("audio_codec");
        } catch (error) {
          throw transportError ?? error;
        }
      },
    };
  } catch (error) {
    input.dispose();
    throw transportError ?? (error instanceof AudioSourceError ? error : new AudioSourceError("decode_audio"));
  }
}
