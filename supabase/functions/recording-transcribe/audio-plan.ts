export const partSeconds = 360;
export const overlapSeconds = 12;
export const maxRecordingSeconds = 3 * 60 * 60;
export const maxPartBytes = 2 * 1024 * 1024;

export function partCount(duration: number) {
  return Math.ceil(duration / partSeconds);
}

export function partWindow(index: number, duration: number) {
  const boundary = index * partSeconds;
  return {
    boundary,
    start: Math.max(0, boundary - overlapSeconds),
    end: Math.min(duration, boundary + partSeconds),
  };
}
