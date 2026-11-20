export async function runBurst<T extends { state: string }>(
  initial: T,
  options: {
    process: (job: T, timeout: number) => Promise<T | null>;
    claim: (job: T) => Promise<T | null>;
    release: (job: T) => Promise<unknown>;
    maxSteps: number;
    now?: () => number;
  },
) {
  const now = options.now ?? Date.now;
  const deadline = now() + 100_000;
  let current: T | null = initial;
  for (let step = 0; current && step < options.maxSteps; step++) {
    const remaining = deadline - now();
    if (remaining < 15_000) {
      await options.release(current);
      return;
    }
    const next = await options.process(current, remaining);
    if (!next || next.state !== "processing" || step + 1 === options.maxSteps) return;
    current = await options.claim(next);
  }
}
