// Runs once at server boot — starts the durable job worker so interrupted
// ingestions resume without waiting for a request.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWorker } = await import("./lib/jobs");
    startWorker();
    // Live runtime: bring up a listener for every configured source.
    const { startAllSources } = await import("./lib/runtime/sources");
    startAllSources();
  }
}
