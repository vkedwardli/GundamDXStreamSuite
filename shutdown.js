export async function withTimeout(operation, timeoutMs, description) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${description} timed out after ${timeoutMs / 1000}s.`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function installShutdownHandlers(cleanups, { target = process, exit = code => process.exit(code), timeoutMs = 10000, logger = console } = {}) {
  let stopping;
  const shutdown = code => {
    if (stopping) return stopping;
    stopping = (async () => {
      const timeout = setTimeout(() => {
        logger.error("Local shutdown timed out; exiting. OBS remains running.");
        exit(code);
      }, timeoutMs);
      try {
        const results = await Promise.allSettled(cleanups.map(cleanup => Promise.resolve().then(cleanup)));
        for (const result of results) {
          if (result.status === "rejected") logger.error("Local shutdown failed:", result.reason);
        }
      } finally {
        clearTimeout(timeout);
      }
      exit(code);
    })();
    return stopping;
  };
  target.on("SIGINT", () => { void shutdown(130); });
  target.on("SIGTERM", () => { void shutdown(143); });
  return shutdown;
}
