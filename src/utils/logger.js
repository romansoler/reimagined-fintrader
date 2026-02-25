import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, '..', '..', 'logs');

if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
}

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || 'info'] ?? LOG_LEVELS.info;

const dateStr = new Date().toISOString().slice(0, 10);

const logFile = createWriteStream(
    join(LOG_DIR, `perptrader-${dateStr}.log`),
    { flags: 'a' }
);

// Separate audit log for API requests/responses and trade actions
const auditFile = createWriteStream(
    join(LOG_DIR, `audit-${dateStr}.log`),
    { flags: 'a' }
);

/**
 * @param {'error'|'warn'|'info'|'debug'} level
 * @param {string} component
 * @param {string} message
 * @param {object} [data]
 */
function log(level, component, message, data = null) {
    if (LOG_LEVELS[level] > currentLevel) return;

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase().padEnd(5)}] [${component}]`;
    const entry = data
        ? `${prefix} ${message} | ${JSON.stringify(data)}`
        : `${prefix} ${message}`;

    // Console output with colors
    const colors = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
    const reset = '\x1b[0m';
    console.log(`${colors[level]}${entry}${reset}`);

    // File output
    logFile.write(entry + '\n');
}

/**
 * Audit-level log for API calls, trade events, and critical actions.
 * Always written regardless of LOG_LEVEL.
 * @param {string} action - e.g., 'API_REQUEST', 'API_RESPONSE', 'ORDER_PLACED', 'SIGNAL_RECEIVED'
 * @param {string} component
 * @param {object} details
 */
function audit(action, component, details = {}) {
    const timestamp = new Date().toISOString();
    const entry = JSON.stringify({ timestamp, action, component, ...details });
    auditFile.write(entry + '\n');

    // Also show in console at debug level
    const prefix = `[${timestamp}] [AUDIT] [${component}]`;
    console.log(`\x1b[35m${prefix} ${action}\x1b[0m`);
}

/** In-memory event history for dashboard display */
const eventHistory = [];
const MAX_EVENTS = 200;

/**
 * Record an event for the dashboard event log.
 * @param {'signal'|'order'|'error'|'system'|'api'} type
 * @param {string} message
 * @param {object} [data]
 */
function recordEvent(type, message, data = null) {
    const event = {
        id: Date.now() + Math.random().toString(36).slice(2, 6),
        timestamp: new Date().toISOString(),
        type,
        message,
        data,
    };
    eventHistory.unshift(event);
    if (eventHistory.length > MAX_EVENTS) eventHistory.pop();
    return event;
}

/**
 * Get recent events for the dashboard.
 * @param {number} [limit=50]
 * @returns {object[]}
 */
function getEvents(limit = 50) {
    return eventHistory.slice(0, limit);
}

export const logger = {
    error: (component, msg, data) => log('error', component, msg, data),
    warn: (component, msg, data) => log('warn', component, msg, data),
    info: (component, msg, data) => log('info', component, msg, data),
    debug: (component, msg, data) => log('debug', component, msg, data),
    audit,
    recordEvent,
    getEvents,
};
