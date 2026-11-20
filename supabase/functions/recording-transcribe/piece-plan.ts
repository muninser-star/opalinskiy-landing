import { overlapSeconds, partWindow } from "./audio-plan.ts";

export type PieceProgress = {
  parts_done: number;
  part_piece: number;
  piece_offset_seconds: number;
  piece_seconds: number;
  duration_seconds: number;
};

export function pieceWindow(job: PieceProgress) {
  const part = partWindow(job.parts_done, job.duration_seconds);
  const coarseStart = part.boundary + job.part_piece * 120;
  const boundary = coarseStart + job.piece_offset_seconds;
  const coarseEnd = Math.min(part.end, coarseStart + 120);
  return {
    boundary,
    start: Math.max(part.start, boundary - overlapSeconds),
    end: Math.min(coarseEnd, boundary + job.piece_seconds),
  };
}

export function nextPiece(job: PieceProgress, end: number) {
  const part = partWindow(job.parts_done, job.duration_seconds);
  const coarseStart = part.boundary + job.part_piece * 120;
  const coarseEnd = Math.min(part.end, coarseStart + 120);
  if (end < coarseEnd - 0.001) {
    return { parts_done: job.parts_done, part_piece: job.part_piece,
      piece_offset_seconds: end - coarseStart, piece_seconds: job.piece_seconds };
  }
  if (end < part.end - 0.001) {
    return { parts_done: job.parts_done, part_piece: job.part_piece + 1, piece_offset_seconds: 0, piece_seconds: 120 };
  }
  return { parts_done: job.parts_done + 1, part_piece: 0, piece_offset_seconds: 0, piece_seconds: 120 };
}
