import { logger } from './logger.js';

/**
 * Rate limiter that respects Blofin's limits:
 * - Trading: 30 requests per 10 seconds
 * - General: 500 requests per minute
 */
export class RateLimiter {
    /**
     * @param {number} maxRequests - Maximum requests allowed in the window
     * @param {number} windowMs - Time window in milliseconds
     */
    constructor(maxRequests, windowMs) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
        /** @type {number[]} */
        this.timestamps = [];
    }

    /**
     * Wait until a request slot is available, then consume it.
     * @returns {Promise<void>}
     */
    async acquire() {
        const now = Date.now();
        // Prune expired timestamps
        this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);

        if (this.timestamps.length >= this.maxRequests) {
            const oldest = this.timestamps[0];
            const waitTime = this.windowMs - (now - oldest) + 10; // +10ms safety margin
            logger.debug('RateLimiter', `Throttling for ${waitTime}ms`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return this.acquire(); // Retry after wait
        }

        this.timestamps.push(Date.now());
    }
}

// Pre-configured limiters for Blofin
export const tradingLimiter = new RateLimiter(30, 10_000);  // 30 req / 10s
export const generalLimiter = new RateLimiter(500, 60_000); // 500 req / 60s
