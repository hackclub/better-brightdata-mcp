// Keeps a slow-but-active SSE connection alive by periodically reporting
// progress while a single blocking call is still in flight, so a proxy
// with an idle timeout doesn't reap the connection before the real
// response is ready. Tools that already report real incremental progress
// (e.g. a poll loop) don't need this - it's for the ones that don't.
const HEARTBEAT_INTERVAL_MS = parseInt(
    process.env.HEARTBEAT_INTERVAL_MS || '15000', 10);

// Returns a stop function - call it (in a finally block) once the real work is done.
export function startHeartbeat(ctx, message){
    if (!ctx?.reportProgress)
        return () => {};
    let beat = 0;
    const interval = setInterval(()=>{
        ctx.reportProgress({progress: beat++, message}).catch(()=>{});
    }, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(interval);
}
