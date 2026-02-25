import { logger } from '../utils/logger.js';
import { parseSignal, parseEditDiff, validateSignal } from '../parser/signalParser.js';
import {
    logSignal, logSignalEdit, recordOrder, updateOrder,
    getPreferences, isMessageProcessed, isTraderWhitelisted, isWhitelistEmpty,
} from '../config/preferenceManager.js';
import { EventEmitter } from 'events';

export class OrderEngine extends EventEmitter {
    /**
     * @param {import('../exchange/blofinClient.js').BlofinClient} blofinClient
     * @param {import('../exchange/blofinWebSocket.js').BlofinWebSocket} blofinWs
     */
    constructor(blofinClient, blofinWs) {
        super();
        this.client = blofinClient;
        this.ws = blofinWs;

        /** @type {Set<string>} Known instrument IDs */
        this.instruments = new Set();

        /** @type {Set<string>} Processed Discord message IDs (dedup) */
        this.processedMessages = new Set();

        /** @type {Map<string, object>} Pending fills: orderId → signal context */
        this.pendingFills = new Map();

        /** @type {Map<string, object>} Active signal tracking by messageId */
        this.activeSignals = new Map();

        this._setupWebSocketListeners();
    }

    /**
     * Initialize: load instrument list from Blofin.
     */
    async initialize() {
        try {
            const instruments = await this.client.getInstruments();
            if (Array.isArray(instruments)) {
                for (const inst of instruments) {
                    this.instruments.add(inst.instId);
                }
            }
            logger.info('OrderEngine', `Loaded ${this.instruments.size} instruments`);
        } catch (error) {
            logger.error('OrderEngine', `Failed to load instruments: ${error.message}`);
        }
    }

    // ============================================================
    // Message Processing (New Signals)
    // ============================================================

    /**
     * Process an incoming Discord message — the main entry point.
     * @param {object} msg - { content, messageId, channelId, author, timestamp }
     */
    async processMessage(msg) {
        // Step 1: Parse signal
        const signal = parseSignal(msg.content, msg.messageId, this.processedMessages);
        if (!signal) return;

        // Step 2: Message-level dedup (by Discord message ID)
        if (this.processedMessages.has(msg.messageId)) {
            logger.debug('OrderEngine', `Message ${msg.messageId} already processed — skipping`);
            return;
        }

        // Step 3: Trader whitelist check
        if (!isWhitelistEmpty() && !isTraderWhitelisted(signal.traderName)) {
            logger.warn('OrderEngine', `Trader "${signal.traderName}" not whitelisted — ignoring signal`, { instId: signal.instId });
            logSignal({
                ...signal, channelId: msg.channelId, messageId: msg.messageId,
                isValid: false, rejectionReason: `Trader not whitelisted: ${signal.traderName}`,
            });
            this.emit('signalRejected', { signal, reason: `Trader "${signal.traderName}" not whitelisted` });
            return;
        }

        // Step 4: If signal is already closed, just log it (it's an old/historical signal)
        if (signal.isClosed) {
            logger.info('OrderEngine', `Signal is already closed — logging only`, { instId: signal.instId, pnl: signal.finalPnl });
            logSignal({
                ...signal, channelId: msg.channelId, messageId: msg.messageId,
                isValid: true, wasExecuted: false, rejectionReason: 'Already closed',
            });
            this.emit('signalRejected', { signal, reason: 'Signal already closed' });
            return;
        }

        // Step 5: Validate instrument
        const validation = validateSignal(signal, this.instruments);
        if (!validation.valid) {
            logger.warn('OrderEngine', `Invalid signal: ${validation.reason}`, signal);
            logSignal({
                ...signal, channelId: msg.channelId, messageId: msg.messageId,
                isValid: false, rejectionReason: validation.reason,
            });
            this.emit('signalRejected', { signal, reason: validation.reason });
            return;
        }

        // Mark as processed
        this.processedMessages.add(msg.messageId);

        // Log signal
        logSignal({
            ...signal, channelId: msg.channelId, messageId: msg.messageId,
            isValid: true,
        });

        // Track active signal
        this.activeSignals.set(msg.messageId, {
            signal,
            channelId: msg.channelId,
            version: 1,
        });

        // Check preferences
        const prefs = getPreferences();

        // Emit DCA info if DCA levels present
        if (signal.dcaLevels.length > 0) {
            this.emit('signal:dcaDetected', { signal, dcaLevels: signal.dcaLevels, prefs });
        }

        this.emit('signalAccepted', { signal, prefs });

        // Check auto-execute vs confirm
        if (prefs.confirmBeforeOrder) {
            logger.info('OrderEngine', 'Signal requires confirmation', signal);
            this.emit('confirmRequired', { signal, prefs });
            return;
        }

        // Execute
        await this.executeSignal(signal, prefs);
    }

    // ============================================================
    // Message Edit Processing
    // ============================================================

    /**
     * Process a message edit — detect TP hits, closures, P&L updates.
     * @param {object} msg - { content, messageId, oldContent, isEdit, ... }
     */
    async processMessageEdit(msg) {
        const { messageId, content, oldContent } = msg;

        // Parse the new content
        const updated = parseSignal(content, messageId, this.processedMessages);
        if (!updated) return;

        // Determine what changed
        const diff = oldContent ? parseEditDiff(oldContent, content) : {
            tpHits: updated.tpLevels.filter(t => t.hit).map(t => t.level),
            isClosed: updated.isClosed,
            finalPnl: updated.finalPnl,
        };

        // Log the edit version
        logSignalEdit(messageId, content, {
            status: updated.isClosed ? 'closed' : 'active',
            tpHits: diff.tpHits,
            finalPnl: diff.finalPnl,
            isClosed: updated.isClosed,
        });

        const tracked = this.activeSignals.get(messageId);
        if (tracked) {
            tracked.version++;
        }

        // Emit events for each change
        if (diff.tpHits.length > 0) {
            logger.info('OrderEngine', `TP hit(s) detected: ${diff.tpHits.join(', ')}`, { instId: updated.instId });
            this.emit('signal:tpHit', {
                signal: updated,
                tpHits: diff.tpHits,
                messageId,
                version: tracked?.version || 1,
            });
        }

        if (diff.isClosed) {
            logger.info('OrderEngine', `Trade closed: ${updated.instId} | P&L: ${diff.finalPnl}`, { messageId });
            this.emit('signal:closed', {
                signal: updated,
                finalPnl: diff.finalPnl,
                messageId,
                version: tracked?.version || 1,
            });

            // Remove from active tracking
            this.activeSignals.delete(messageId);
        }

        // General edit event
        this.emit('signal:edit', {
            signal: updated,
            diff,
            messageId,
            version: tracked?.version || 1,
        });
    }

    // ============================================================
    // Order Execution
    // ============================================================

    /**
     * Execute a parsed signal with the given preferences.
     * @param {object} signal
     * @param {object} prefs
     */
    async executeSignal(signal, prefs) {
        const instId = signal.instId;
        const isLong = signal.side === 'long';

        try {
            this.emit('execution:start', { signal, step: 'pre-trade' });

            // 1. Check for existing position
            const positions = await this.client.getPositions(instId);
            if (Array.isArray(positions) && positions.length > 0) {
                const hasPosition = positions.some(p => parseFloat(p.positions) !== 0);
                if (hasPosition) {
                    logger.warn('OrderEngine', `Already in position for ${instId}. Skipping.`);
                    this.emit('execution:skipped', { signal, reason: 'Already in position' });
                    return;
                }
            }

            // 2. Set margin mode
            try {
                await this.client.setMarginMode(prefs.marginMode);
            } catch (err) {
                if (!err.message?.includes('already')) {
                    logger.warn('OrderEngine', `Set margin mode warning: ${err.message}`);
                }
            }
            this.emit('execution:progress', { signal, step: 'Margin mode set' });

            // 3. Determine leverage
            let effectiveLeverage = prefs.leverage;
            if (prefs.leverageSource === 'signal' && signal.leverage) {
                effectiveLeverage = signal.leverage;
            } else if (prefs.leverageSource === 'max' && signal.leverage) {
                effectiveLeverage = Math.max(prefs.leverage, signal.leverage);
            }

            // 4. Set leverage
            const positionSide = isLong ? 'long' : 'short';
            try {
                await this.client.setLeverage(instId, effectiveLeverage, prefs.marginMode, positionSide);
            } catch (err) {
                logger.warn('OrderEngine', `Set leverage warning: ${err.message}`);
            }
            this.emit('execution:progress', { signal, step: `Leverage set to ${effectiveLeverage}x` });

            // 5. Check balance
            const balance = await this.client.getBalance();
            const available = parseFloat(balance?.details?.[0]?.available || '0');
            if (available < prefs.orderAmount) {
                logger.error('OrderEngine', `Insufficient balance: ${available} < ${prefs.orderAmount}`);
                this.emit('execution:failed', { signal, reason: `Insufficient balance: $${available.toFixed(2)}` });
                return;
            }

            // --- Calculate size ---
            let entryPrice = signal.entryPrice;

            // Fetch current market price
            let currentMarketPrice = null;
            try {
                const markData = await this.client.getMarkPrice(instId);
                currentMarketPrice = parseFloat(Array.isArray(markData) ? markData[0]?.markPrice : markData?.markPrice);
            } catch {
                try {
                    const tickerData = await this.client.getTicker(instId);
                    currentMarketPrice = parseFloat(Array.isArray(tickerData) ? tickerData[0]?.last : tickerData?.last);
                } catch {
                    /* will handle below */
                }
            }

            // If no entry price, use market price
            if (!entryPrice) {
                entryPrice = currentMarketPrice;
            }

            if (!entryPrice || isNaN(entryPrice)) {
                logger.error('OrderEngine', 'Could not determine entry price');
                this.emit('execution:failed', { signal, reason: 'Could not determine entry price' });
                return;
            }

            // --- Slippage check: limit → market fallback ---
            let orderType = prefs.orderType;
            if (orderType === 'limit' && currentMarketPrice && entryPrice) {
                const slippagePct = Math.abs(currentMarketPrice - entryPrice) / entryPrice * 100;
                if (slippagePct > prefs.slippagePercent) {
                    logger.warn('OrderEngine', `Price slippage ${slippagePct.toFixed(2)}% > threshold ${prefs.slippagePercent}% — falling back to MARKET`, { entryPrice, currentMarketPrice });
                    orderType = 'market';
                    entryPrice = currentMarketPrice;
                    this.emit('execution:progress', { signal, step: `Slippage ${slippagePct.toFixed(2)}% exceeded — using market order` });
                }
            }

            // Contract size
            const notional = prefs.orderAmount * effectiveLeverage;
            const rawSize = notional / entryPrice;
            const size = parseFloat(rawSize.toPrecision(4));

            this.emit('execution:progress', { signal, step: `Size: ${size} | Notional: $${notional} | Lev: ${effectiveLeverage}x` });

            // --- Place Entry Order ---
            const side = isLong ? 'buy' : 'sell';

            const orderResult = await this.client.placeOrder({
                instId,
                marginMode: prefs.marginMode,
                positionSide,
                side,
                orderType,
                size: String(size),
                price: orderType === 'limit' ? String(entryPrice) : undefined,
                reduceOnly: false,
            });

            const orderId = Array.isArray(orderResult) ? orderResult[0]?.orderId : orderResult?.orderId;

            if (!orderId) {
                logger.error('OrderEngine', 'Order placement returned no orderId', orderResult);
                this.emit('execution:failed', { signal, reason: 'No orderId returned' });
                return;
            }

            logger.info('OrderEngine', `Order placed: ${orderId}`, { instId, side, size, orderType, leverage: effectiveLeverage });
            this.emit('execution:progress', { signal, step: `Order placed: ${orderId}` });

            // Record order
            const dbOrder = recordOrder({
                signalId: signal.signalId,
                instId,
                side,
                positionSide,
                orderType,
                entryPrice,
                size,
                leverage: effectiveLeverage,
                marginMode: prefs.marginMode,
                orderId,
                status: 'placed',
                traderName: signal.traderName,
                tpLevels: signal.tpLevels,
                dcaLevels: signal.dcaLevels,
            });

            // Store pending fill context
            this.pendingFills.set(orderId, {
                signal,
                prefs,
                instId,
                positionSide,
                side,
                size,
                entryPrice,
                leverage: effectiveLeverage,
                dbOrderId: dbOrder.lastInsertRowid,
            });

            // For market orders, try placing stop immediately
            if (orderType === 'market') {
                setTimeout(() => this._tryPlaceTrailingStop(orderId), 500);
            }

            // --- DCA orders (if enabled and DCA levels present) ---
            if (prefs.useDca && prefs.dcaMode === 'auto' && signal.dcaLevels.length > 0) {
                await this._placeDcaOrders(signal, prefs, instId, positionSide, effectiveLeverage);
            }

        } catch (error) {
            logger.error('OrderEngine', `Execution failed: ${error.message}`, { signal });
            this.emit('execution:failed', { signal, reason: error.message });
        }
    }

    // ============================================================
    // DCA Orders
    // ============================================================

    /**
     * Place DCA (Dollar-Cost Averaging) limit orders at signal-specified levels.
     */
    async _placeDcaOrders(signal, prefs, instId, positionSide, leverage) {
        const side = signal.side === 'long' ? 'buy' : 'sell';
        const dcaAmount = prefs.orderAmount; // Same amount per DCA level

        for (const dca of signal.dcaLevels) {
            try {
                const dcaSize = parseFloat(((dcaAmount * leverage) / dca.price).toPrecision(4));
                const result = await this.client.placeOrder({
                    instId,
                    marginMode: prefs.marginMode,
                    positionSide,
                    side,
                    orderType: 'limit',
                    size: String(dcaSize),
                    price: String(dca.price),
                    reduceOnly: false,
                });

                const dcaOrderId = Array.isArray(result) ? result[0]?.orderId : result?.orderId;
                logger.info('OrderEngine', `DCA${dca.level} order placed: ${dcaOrderId} @ ${dca.price}`, { instId });
                this.emit('execution:progress', { signal, step: `DCA${dca.level} limit order @ $${dca.price}` });
            } catch (err) {
                logger.error('OrderEngine', `DCA${dca.level} order failed: ${err.message}`, { instId, price: dca.price });
            }
        }
    }

    // ============================================================
    // Trailing Stop
    // ============================================================

    _setupWebSocketListeners() {
        this.ws.on('orderFilled', (order) => {
            const orderId = order.orderId;
            if (this.pendingFills.has(orderId)) {
                logger.info('OrderEngine', `Order ${orderId} filled — placing trailing stop`);
                this._placeTrailingStop(orderId, order);
            }
        });
    }

    async _tryPlaceTrailingStop(orderId) {
        const context = this.pendingFills.get(orderId);
        if (!context) return;

        try {
            const orderDetail = await this.client.getOrderDetail(orderId);
            const detail = Array.isArray(orderDetail) ? orderDetail[0] : orderDetail;
            if (detail?.state === 'filled') {
                await this._placeTrailingStop(orderId, detail);
            }
        } catch (err) {
            logger.debug('OrderEngine', `Polling fill status for ${orderId}: ${err.message}`);
        }
    }

    async _placeTrailingStop(orderId, fillData) {
        const context = this.pendingFills.get(orderId);
        if (!context) return;

        this.pendingFills.delete(orderId);

        const { signal, prefs, instId, positionSide, size, entryPrice } = context;
        const isLong = positionSide === 'long';
        const variance = prefs.trailingStopVariance / 100;

        const slTriggerPrice = isLong
            ? entryPrice * (1 - variance)
            : entryPrice * (1 + variance);

        const closeSide = isLong ? 'sell' : 'buy';

        try {
            if (prefs.trailingStopType === 'tpsl') {
                const tpslResult = await this.client.placeTPSL({
                    instId,
                    marginMode: prefs.marginMode,
                    positionSide,
                    side: closeSide,
                    size: String(size),
                    slTriggerPrice: String(slTriggerPrice.toFixed(8)),
                    slOrderPrice: '-1',
                    reduceOnly: true,
                });

                const tpslId = tpslResult?.tpslId;
                logger.info('OrderEngine', `TPSL placed: ${tpslId} (SL @ ${slTriggerPrice})`, { instId });

                updateOrder(context.dbOrderId, { tpslId, status: 'active' });
                this.emit('execution:complete', {
                    signal, orderId, tpslId,
                    stopPrice: slTriggerPrice,
                    type: 'tpsl',
                });
            } else {
                const algoResult = await this.client.placeAlgoOrder({
                    instId,
                    marginMode: prefs.marginMode,
                    positionSide,
                    side: closeSide,
                    size: String(size),
                    triggerPrice: String(slTriggerPrice.toFixed(8)),
                    triggerPriceType: 'last',
                    orderPrice: '-1',
                    reduceOnly: true,
                });

                const algoId = algoResult?.algoId;
                logger.info('OrderEngine', `Algo stop placed: ${algoId} (trigger @ ${slTriggerPrice})`, { instId });

                updateOrder(context.dbOrderId, { algoId, status: 'active' });
                this.emit('execution:complete', {
                    signal, orderId, algoId,
                    stopPrice: slTriggerPrice,
                    type: 'algo',
                });
            }
        } catch (error) {
            logger.error('OrderEngine', `Failed to place trailing stop: ${error.message}`, { instId });
            this.emit('execution:stopFailed', { signal, orderId, reason: error.message });
        }
    }

    // ============================================================
    // Manual Confirm & Emergency Close
    // ============================================================

    async confirmAndExecute(signal) {
        const prefs = getPreferences();
        await this.executeSignal(signal, prefs);
    }

    async emergencyClose(instId) {
        try {
            const prefs = getPreferences();
            await this.client.closePositions(instId, prefs.marginMode);
            logger.info('OrderEngine', `Emergency close executed for ${instId}`);
            this.emit('emergencyClose', { instId });
        } catch (error) {
            logger.error('OrderEngine', `Emergency close failed: ${error.message}`);
            throw error;
        }
    }
}
