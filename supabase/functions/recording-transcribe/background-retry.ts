export function backgroundRetry(count: number, retryable: boolean, now = Date.now()) {
  if (!retryable || count >= 3) return null;
  return {
    retry_count: count + 1,
    retry_at: new Date(now + 30_000 * 2 ** count).toISOString(),
  };
}
