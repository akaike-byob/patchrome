// Rejects with the error `onExpired` makes once `limitMs` pass without `work` settling. The work keeps running,
// and a later rejection from it is handled here, so it never surfaces as an unhandled rejection.
export async function settleWithin<T>(work: Promise<T>, limitMs: number, onExpired: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onExpired()), limitMs);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}
