export function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  if (max < 1) throw new Error(`concurrency limit must be >= 1, got ${max}`);
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= max) return;
    const job = queue.shift();
    if (job) {
      active++;
      job();
    }
  };

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        fn().then(
          (v) => {
            active--;
            resolve(v);
            next();
          },
          (e) => {
            active--;
            reject(e);
            next();
          },
        );
      };
      queue.push(run);
      next();
    });
}
