import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', '..', 'perptrader.db');
const SCHEMA_PATH = join(__dirname, 'schema.sql');

let db;

/**
 * Initialize the database and run schema migrations.
 * @returns {Database.Database}
 */
export function initDatabase() {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    const schema = readFileSync(SCHEMA_PATH, 'utf-8');
    db.exec(schema);

    // Safe migration: add new columns if they don't exist yet
    const safeAddColumn = (table, col, def) => {
        try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
        catch { /* column already exists */ }
    };
    safeAddColumn('preferences', 'slippage_percent', 'REAL NOT NULL DEFAULT 1.0');
    safeAddColumn('preferences', 'leverage_source', "TEXT NOT NULL DEFAULT 'signal'");
    safeAddColumn('preferences', 'use_dca', 'INTEGER NOT NULL DEFAULT 0');
    safeAddColumn('preferences', 'dca_mode', "TEXT NOT NULL DEFAULT 'display'");
    safeAddColumn('signal_log', 'trader_name', 'TEXT');
    safeAddColumn('signal_log', 'leverage', 'INTEGER');
    safeAddColumn('signal_log', 'tp_levels', 'TEXT');
    safeAddColumn('signal_log', 'dca_levels', 'TEXT');
    safeAddColumn('order_history', 'trader_name', 'TEXT');
    safeAddColumn('order_history', 'tp_levels', 'TEXT');
    safeAddColumn('order_history', 'dca_levels', 'TEXT');
    safeAddColumn('order_history', 'dca_orders', 'TEXT');

    logger.info('Database', `Initialized at ${DB_PATH}`);
    return db;
}

/**
 * Get the database instance.
 * @returns {Database.Database}
 */
export function getDb() {
    if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
    return db;
}

// ============================================================
// Preferences CRUD
// ============================================================

const PREF_COLUMNS = [
    'order_amount', 'order_type', 'margin_mode', 'leverage',
    'trailing_stop_variance', 'trailing_stop_type', 'reduce_only',
    'auto_execute', 'confirm_before_order', 'channel_id',
    'slippage_percent', 'leverage_source', 'use_dca', 'dca_mode',
];

/**
 * Get all user preferences.
 * @returns {object}
 */
export function getPreferences() {
    const row = getDb().prepare('SELECT * FROM preferences WHERE id = 1').get();
    if (!row) throw new Error('Preferences row missing');
    return {
        orderAmount: row.order_amount,
        orderType: row.order_type,
        marginMode: row.margin_mode,
        leverage: row.leverage,
        trailingStopVariance: row.trailing_stop_variance,
        trailingStopType: row.trailing_stop_type,
        reduceOnly: Boolean(row.reduce_only),
        autoExecute: Boolean(row.auto_execute),
        confirmBeforeOrder: Boolean(row.confirm_before_order),
        channelId: row.channel_id,
        slippagePercent: row.slippage_percent,
        leverageSource: row.leverage_source,
        useDca: Boolean(row.use_dca),
        dcaMode: row.dca_mode,
        updatedAt: row.updated_at,
    };
}

/**
 * Update user preferences. Only provided keys are updated.
 * @param {object} updates - Partial preferences object
 */
export function updatePreferences(updates) {
    const keyMap = {
        orderAmount: 'order_amount',
        orderType: 'order_type',
        marginMode: 'margin_mode',
        leverage: 'leverage',
        trailingStopVariance: 'trailing_stop_variance',
        trailingStopType: 'trailing_stop_type',
        reduceOnly: 'reduce_only',
        autoExecute: 'auto_execute',
        confirmBeforeOrder: 'confirm_before_order',
        channelId: 'channel_id',
        slippagePercent: 'slippage_percent',
        leverageSource: 'leverage_source',
        useDca: 'use_dca',
        dcaMode: 'dca_mode',
    };

    const sets = [];
    const values = {};

    for (const [jsKey, dbCol] of Object.entries(keyMap)) {
        if (jsKey in updates) {
            sets.push(`${dbCol} = @${dbCol}`);
            let val = updates[jsKey];
            if (typeof val === 'boolean') val = val ? 1 : 0;
            values[dbCol] = val;
        }
    }

    if (sets.length === 0) return;

    sets.push("updated_at = datetime('now')");
    const sql = `UPDATE preferences SET ${sets.join(', ')} WHERE id = 1`;
    getDb().prepare(sql).run(values);
    logger.info('Preferences', 'Updated preferences', updates);
}

// ============================================================
// Trader Whitelist
// ============================================================

/**
 * Get all whitelisted traders.
 * @returns {object[]}
 */
export function getTraderWhitelist() {
    return getDb().prepare('SELECT * FROM trader_whitelist ORDER BY trader_name').all();
}

/**
 * Add a trader to the whitelist.
 * @param {string} traderName
 * @returns {boolean} True if added, false if already exists
 */
export function addTrader(traderName) {
    try {
        getDb().prepare('INSERT INTO trader_whitelist (trader_name) VALUES (?)').run(traderName.trim());
        logger.info('TraderWhitelist', `Added: ${traderName}`);
        return true;
    } catch (err) {
        if (err.message.includes('UNIQUE')) return false;
        throw err;
    }
}

/**
 * Remove a trader from the whitelist.
 * @param {string} traderName
 */
export function removeTrader(traderName) {
    getDb().prepare('DELETE FROM trader_whitelist WHERE trader_name = ? COLLATE NOCASE').run(traderName.trim());
    logger.info('TraderWhitelist', `Removed: ${traderName}`);
}

/**
 * Check if a trader is whitelisted.
 * @param {string} traderName
 * @returns {boolean}
 */
export function isTraderWhitelisted(traderName) {
    if (!traderName) return false;
    const row = getDb().prepare('SELECT 1 FROM trader_whitelist WHERE trader_name = ? COLLATE NOCASE').get(traderName.trim());
    return !!row;
}

/**
 * Check if the whitelist is empty (means all traders are allowed).
 * @returns {boolean}
 */
export function isWhitelistEmpty() {
    const row = getDb().prepare('SELECT COUNT(*) as cnt FROM trader_whitelist').get();
    return row.cnt === 0;
}

// ============================================================
// Signal Edit Tracking
// ============================================================

/**
 * Check if a Discord message ID has been processed.
 * @param {string} messageId
 * @returns {boolean}
 */
export function isMessageProcessed(messageId) {
    const row = getDb().prepare('SELECT 1 FROM signal_log WHERE message_id = ?').get(messageId);
    return !!row;
}

/**
 * Log a signal edit (version increment).
 * @param {string} messageId
 * @param {string} rawContent
 * @param {object} [extra]
 */
export function logSignalEdit(messageId, rawContent, extra = {}) {
    const lastVersion = getDb().prepare(
        'SELECT MAX(version) as v FROM signal_edits WHERE message_id = ?'
    ).get(messageId);
    const version = (lastVersion?.v || 0) + 1;

    getDb().prepare(`
        INSERT INTO signal_edits (message_id, version, raw_content, status, tp_hits, final_pnl, is_closed)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        messageId,
        version,
        rawContent,
        extra.status || null,
        extra.tpHits ? JSON.stringify(extra.tpHits) : null,
        extra.finalPnl || null,
        extra.isClosed ? 1 : 0,
    );

    logger.info('SignalEdits', `Logged edit v${version} for message ${messageId}`);
    return version;
}

/**
 * Get all edit versions for a message.
 * @param {string} messageId
 * @returns {object[]}
 */
export function getSignalEdits(messageId) {
    return getDb().prepare(
        'SELECT * FROM signal_edits WHERE message_id = ? ORDER BY version'
    ).all(messageId);
}

// ============================================================
// Signal Log
// ============================================================

/**
 * Log a received signal.
 * @param {object} signal
 * @returns {object} The inserted row
 */
export function logSignal(signal) {
    const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO signal_log (signal_id, channel_id, message_id, raw_content, ticker, side, entry_price, is_valid, was_executed, rejection_reason, trader_name, leverage, tp_levels, dca_levels)
    VALUES (@signalId, @channelId, @messageId, @rawContent, @ticker, @side, @entryPrice, @isValid, @wasExecuted, @rejectionReason, @traderName, @leverage, @tpLevels, @dcaLevels)
  `);
    const result = stmt.run({
        signalId: signal.signalId,
        channelId: signal.channelId || null,
        messageId: signal.messageId || null,
        rawContent: signal.rawContent,
        ticker: signal.ticker || null,
        side: signal.side || null,
        entryPrice: signal.entryPrice || null,
        isValid: signal.isValid ? 1 : 0,
        wasExecuted: signal.wasExecuted ? 1 : 0,
        rejectionReason: signal.rejectionReason || null,
        traderName: signal.traderName || null,
        leverage: signal.leverage || null,
        tpLevels: signal.tpLevels ? JSON.stringify(signal.tpLevels) : null,
        dcaLevels: signal.dcaLevels ? JSON.stringify(signal.dcaLevels) : null,
    });
    return result;
}

/**
 * Get recent signals.
 * @param {number} [limit=50]
 * @returns {object[]}
 */
export function getRecentSignals(limit = 50) {
    return getDb().prepare(
        'SELECT * FROM signal_log ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
}

// ============================================================
// Order History
// ============================================================

/**
 * Record an order.
 * @param {object} order
 * @returns {object}
 */
export function recordOrder(order) {
    const stmt = getDb().prepare(`
    INSERT INTO order_history (signal_id, inst_id, side, position_side, order_type, entry_price, size, leverage, margin_mode, order_id, tpsl_id, algo_id, status, trader_name, tp_levels, dca_levels, dca_orders)
    VALUES (@signalId, @instId, @side, @positionSide, @orderType, @entryPrice, @size, @leverage, @marginMode, @orderId, @tpslId, @algoId, @status, @traderName, @tpLevels, @dcaLevels, @dcaOrders)
  `);
    return stmt.run({
        signalId: order.signalId || null,
        instId: order.instId,
        side: order.side,
        positionSide: order.positionSide,
        orderType: order.orderType,
        entryPrice: order.entryPrice || null,
        size: order.size,
        leverage: order.leverage,
        marginMode: order.marginMode,
        orderId: order.orderId || null,
        tpslId: order.tpslId || null,
        algoId: order.algoId || null,
        status: order.status || 'pending',
        traderName: order.traderName || null,
        tpLevels: order.tpLevels ? JSON.stringify(order.tpLevels) : null,
        dcaLevels: order.dcaLevels ? JSON.stringify(order.dcaLevels) : null,
        dcaOrders: order.dcaOrders ? JSON.stringify(order.dcaOrders) : null,
    });
}

/**
 * Update order status.
 * @param {number} id
 * @param {object} updates
 */
export function updateOrder(id, updates) {
    const sets = [];
    const values = { id };

    for (const [key, val] of Object.entries(updates)) {
        const snakeKey = key.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
        sets.push(`${snakeKey} = @${snakeKey}`);
        values[snakeKey] = val;
    }

    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");

    getDb().prepare(`UPDATE order_history SET ${sets.join(', ')} WHERE id = @id`).run(values);
}

/**
 * Get recent orders.
 * @param {number} [limit=50]
 * @returns {object[]}
 */
export function getRecentOrders(limit = 50) {
    return getDb().prepare(
        'SELECT * FROM order_history ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
}
