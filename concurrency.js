// Shared concurrency limiter for memory-heavy operations (screenshots,
// full-page HTML dumps, dataset polling) so a burst of concurrent requests
// can't pile up unbounded and exceed the container's memory limit.
export class Semaphore {
    #permits;
    #queue = [];
    constructor(permits){
        this.#permits = permits;
    }
    async acquire(){
        if (this.#permits > 0) {
            this.#permits--;
            return;
        }
        await new Promise(resolve=>this.#queue.push(resolve));
        this.#permits--;
    }
    release(){
        this.#permits++;
        const next = this.#queue.shift();
        if (next)
            next();
    }
    async run(fn){
        await this.acquire();
        try { return await fn(); }
        finally { this.release(); }
    }
}

const MAX_CONCURRENT_HEAVY_OPS = parseInt(
    process.env.MAX_CONCURRENT_HEAVY_OPS || '4', 10);
export const heavyOpsSemaphore = new Semaphore(MAX_CONCURRENT_HEAVY_OPS);
