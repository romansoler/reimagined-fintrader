import { logger } from '../utils/logger.js';
import crypto from 'crypto';

/**
 * @typedef {object} ParsedSignal
 * @property {string} signalId - Unique hash of the signal
 * @property {string} ticker - e.g., "FOGO"
 * @property {string} instId - Blofin instrument ID, e.g., "FOGO-USDT"
 * @property {'long'|'short'} side - Trade direction
 * @property {number|null} entryPrice - Suggested entry price
 * @property {number|null} leverage - Signal-specified leverage (e.g., 25)
 * @property {string|null} traderName - The signal caller (e.g., "Haseeb Trade")
 * @property {object[]} tpLevels - Array of { level, price, hit }
 * @property {object[]} dcaLevels - Array of { level, price }
 * @property {string|null} finalPnl - Final P&L string if trade is closed
 * @property {boolean} isClosed - Whether the trade is marked as closed
 * @property {boolean} isTriggered - Whether entry was triggered
 * @property {'new_signal'|'edit_update'} messageType - First seen vs edited
 * @property {string} rawContent - Original message text
 */

/**
 * Parse an AO Trading signal from Discord.
 *
 * Handles both the embed body and the header line. The format is:
 *   Header: @TraderName 🏦 NEW SIGNAL • TICKER • Entry $PRICE (edited)
 *   Body:   🔴 SHORT SIGNAL - TICKER/USDT
 *           Leverage: 25x • Trader: haseeb1111
 *           Entry: 0.02936 ✅ Triggered
 *           TP1–TP5, DCA1–DCAn, Breakeven, Notes, etc.
 *
 * @param {string} content - Raw message / embed content
 * @param {string} [messageId=''] - Discord message ID
 * @param {Set<string>} [seenMessageIds=null] - Previously processed message IDs (for edit detection)
 * @returns {ParsedSignal|null}
 */
export function parseSignal(content, messageId = '', seenMessageIds = null) {
    if (!content || typeof content !== 'string') return null;
    if (content.length < 10) return null;

    // --- Detect side ---
    const sideMatch = content.match(/(LONG|SHORT)\s+SIGNAL/i);
    if (!sideMatch) {
        // Fallback: try header format "NEW SIGNAL • TICKER • Entry"
        const headerSideMatch = content.match(/(?:🟢|🔴|📊)?\s*(LONG|SHORT)/i);
        if (!headerSideMatch) {
            logger.debug('SignalParser', 'No LONG/SHORT SIGNAL found', { preview: content.slice(0, 120) });
            return null;
        }
    }
    const side = (sideMatch?.[1] || content.match(/(?:🟢|🔴)?\s*(LONG|SHORT)/i)?.[1])?.toLowerCase();
    if (!side) return null;

    // --- Extract ticker ---
    let ticker = null;
    // Primary: "SHORT SIGNAL - FOGO/USDT"
    const tickerMatch = content.match(/(?:LONG|SHORT)\s+SIGNAL\s*[-–—]\s*([A-Z0-9]+)\/?USDT/i);
    if (tickerMatch) {
        ticker = tickerMatch[1].toUpperCase();
    } else {
        // Fallback: "NEW SIGNAL • FOGO • Entry"
        const headerTickerMatch = content.match(/NEW\s+SIGNAL\s*[•·]\s*([A-Z0-9]+)\s*[•·]/i);
        if (headerTickerMatch) ticker = headerTickerMatch[1].toUpperCase();
    }
    if (!ticker) {
        logger.debug('SignalParser', 'Could not extract ticker', { preview: content.slice(0, 120) });
        return null;
    }

    // --- Extract trader name ---
    let traderName = null;
    // From header: "@Haseeb Trade 🏦"
    const traderHeaderMatch = content.match(/@([A-Za-z0-9][\w\s]*?)\s*🏦/);
    if (traderHeaderMatch) {
        traderName = traderHeaderMatch[1].trim();
    } else {
        // From body: "Trader: haseeb1111"
        const traderBodyMatch = content.match(/Trader:\s*(\S+)/i);
        if (traderBodyMatch) traderName = traderBodyMatch[1].trim();
    }

    // --- Extract leverage ---
    let leverage = null;
    const levMatch = content.match(/Leverage:\s*(\d+)x/i);
    if (levMatch) leverage = parseInt(levMatch[1]);

    // --- Extract entry price ---
    let entryPrice = null;
    // "Entry: 0.02936" or "Entry $0.02936" or "Entry: $0.02936"
    const entryMatch = content.match(/Entry[:\s]*\$?([\d.,]+)/i);
    if (entryMatch) {
        entryPrice = parseFloat(entryMatch[1].replace(/,/g, ''));
        if (isNaN(entryPrice) || entryPrice <= 0) entryPrice = null;
    }

    // --- Extract TP levels ---
    const tpLevels = [];
    const tpRegex = /TP(\d+):\s*([\d.]+)(?:\s*(HIT))?/gi;
    let tpMatch;
    while ((tpMatch = tpRegex.exec(content)) !== null) {
        tpLevels.push({
            level: parseInt(tpMatch[1]),
            price: parseFloat(tpMatch[2]),
            hit: !!tpMatch[3],
        });
    }
    // Also detect TP hits from ✅ prefix (e.g., "✅ TP1: 0.029")
    const tpHitRegex = /✅\s*TP(\d+)/gi;
    let tpHitMatch;
    while ((tpHitMatch = tpHitRegex.exec(content)) !== null) {
        const level = parseInt(tpHitMatch[1]);
        const existing = tpLevels.find(t => t.level === level);
        if (existing) existing.hit = true;
    }

    // --- Extract DCA levels ---
    const dcaLevels = [];
    const dcaRegex = /DCA(\d+):\s*([\d.]+)/gi;
    let dcaMatch;
    while ((dcaMatch = dcaRegex.exec(content)) !== null) {
        dcaLevels.push({
            level: parseInt(dcaMatch[1]),
            price: parseFloat(dcaMatch[2]),
        });
    }

    // --- Detect closure ---
    const isClosed = /(?:closed|TRADE\s+CLOSED)/i.test(content);
    const isTriggered = /Triggered/i.test(content);

    // --- Extract final P&L ---
    let finalPnl = null;
    const pnlMatch = content.match(/Final\s+P&L:\s*([+-]?[\d.]+%)/i)
        || content.match(/Final\s+profit:\s*([+-]?[\d.]+%)/i)
        || content.match(/P&L:\s*([+-]?[\d.]+%)/i);
    if (pnlMatch) finalPnl = pnlMatch[1];

    // --- Message type: new vs edit ---
    const messageType = (seenMessageIds && seenMessageIds.has(messageId))
        ? 'edit_update'
        : 'new_signal';

    // --- Generate signal ID ---
    const instId = `${ticker}-USDT`;
    const signalId = crypto
        .createHash('md5')
        .update(`${messageId || `${side}-${instId}-${entryPrice}-${Date.now()}`}`)
        .digest('hex')
        .slice(0, 12);

    const signal = {
        signalId,
        ticker,
        instId,
        side,
        entryPrice,
        leverage,
        traderName,
        tpLevels,
        dcaLevels,
        finalPnl,
        isClosed,
        isTriggered,
        messageType,
        rawContent: content,
    };

    logger.info('SignalParser', `Parsed [${messageType}]: ${side.toUpperCase()} ${instId} @ ${entryPrice || 'MARKET'} | Trader: ${traderName} | Lev: ${leverage}x | TPs: ${tpLevels.length} | DCAs: ${dcaLevels.length}`, signal);
    return signal;
}

/**
 * Parse only the edit-specific changes from a message update.
 * Compares old and new content to determine what changed.
 * @param {string} oldContent
 * @param {string} newContent
 * @returns {{ tpHits: number[], isClosed: boolean, finalPnl: string|null }}
 */
export function parseEditDiff(oldContent, newContent) {
    const oldSignal = parseSignal(oldContent, '', null);
    const newSignal = parseSignal(newContent, '', null);

    const tpHits = [];
    if (newSignal?.tpLevels) {
        for (const tp of newSignal.tpLevels) {
            const oldTp = oldSignal?.tpLevels?.find(t => t.level === tp.level);
            if (tp.hit && (!oldTp || !oldTp.hit)) {
                tpHits.push(tp.level);
            }
        }
    }

    return {
        tpHits,
        isClosed: !oldSignal?.isClosed && (newSignal?.isClosed || false),
        finalPnl: newSignal?.finalPnl || null,
    };
}

/**
 * Validate a parsed signal against known instruments.
 * @param {ParsedSignal} signal
 * @param {Set<string>} knownInstruments
 * @param {number} [currentPrice]
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateSignal(signal, knownInstruments, currentPrice = null) {
    if (!signal) return { valid: false, reason: 'Null signal' };

    if (!knownInstruments.has(signal.instId)) {
        return { valid: false, reason: `Unknown instrument: ${signal.instId}` };
    }

    if (signal.entryPrice && currentPrice) {
        const deviation = Math.abs(signal.entryPrice - currentPrice) / currentPrice;
        if (deviation > 0.10) {
            return { valid: false, reason: `Entry price ${signal.entryPrice} deviates ${(deviation * 100).toFixed(1)}% from current ${currentPrice}` };
        }
    }

    return { valid: true };
}
