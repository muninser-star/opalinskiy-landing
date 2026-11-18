import { overlapSeconds, partWindow } from "./audio-plan.ts";

type AudioWindow = ReturnType<typeof partWindow>;
type Frame = { offset: number; time: number };

const rates = [44100, 48000, 32000];
const mpeg1Bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const mpeg2Bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

function firstFrameOffset(bytes: Uint8Array) {
  if (bytes.length < 10 || bytes[0] !== 73 || bytes[1] !== 68 || bytes[2] !== 51) return 0;
  const size = bytes[6] * 2 ** 21 + bytes[7] * 2 ** 14 + bytes[8] * 2 ** 7 + bytes[9];
  const footer = bytes[3] === 4 && (bytes[5] & 16) ? 10 : 0;
  return 10 + size + footer;
}

function frames(bytes: Uint8Array) {
  const packets: Frame[] = [];
  let time = 0;
  let offset = firstFrameOffset(bytes);
  let first = true;
  while (offset + 4 <= bytes.length) {
    const b = bytes[offset + 1];
    const c = bytes[offset + 2];
    const version = (b >> 3) & 3;
    const layer = (b >> 1) & 3;
    if (bytes[offset] !== 255 || (b & 224) !== 224 || version === 1 || layer !== 1) break;
    const mpeg1 = version === 3;
    const sampleRate = rates[(c >> 2) & 3] / (mpeg1 ? 1 : version === 2 ? 2 : 4);
    const bitrate = (mpeg1 ? mpeg1Bitrates : mpeg2Bitrates)[c >> 4];
    if (!sampleRate || !bitrate) break;
    const length = Math.floor((mpeg1 ? 144 : 72) * bitrate * 1000 / sampleRate) + ((c >> 1) & 1);
    if (offset + length > bytes.length) break;
    const mono = (bytes[offset + 3] >> 6) === 3;
    const sideInfo = mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17);
    const tagAt = offset + 4 + ((b & 1) ? 0 : 2) + sideInfo;
    const tag = first ? String.fromCharCode(...bytes.subarray(tagAt, tagAt + 4)) : "";
    if (tag !== "Xing" && tag !== "Info") {
      packets.push({ offset, time });
      time += (mpeg1 ? 1152 : 576) / sampleRate;
    }
    first = false;
    offset += length;
  }
  return { packets, duration: time, endOffset: offset };
}

export function splitMp3(bytes: Uint8Array, window: AudioWindow, seconds: number) {
  const { packets, duration, endOffset } = frames(bytes);
  if (!packets.length || Math.abs(duration - (window.end - window.start)) > 3) {
    throw new Error("mp3_duration");
  }
  const pieces: Array<{ bytes: Uint8Array; window: AudioWindow }> = [];
  for (let boundary = window.boundary; boundary < window.end - 0.001; boundary += seconds) {
    const start = Math.max(window.start, boundary - overlapSeconds);
    const end = Math.min(window.end, boundary + seconds);
    const first = packets.findLast((packet) => packet.time <= start - window.start) ?? packets[0];
    const after = packets.find((packet) => packet.time >= end - window.start);
    pieces.push({
      bytes: bytes.subarray(first.offset, after?.offset ?? endOffset),
      window: { boundary, start: window.start + first.time, end },
    });
  }
  return pieces;
}
