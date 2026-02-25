import express from 'express';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import {
    getPreferences, updatePreferences, getRecentSignals, getRecentOrders,
    getTraderWhitelist, addTrader, removeTrader, getSignalEdits,
} from '../config/preferenceManager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class DashboardServer {
    /**
     * @param {object} deps
     * @param {import('../engine/orderEngine.js').OrderEngine} deps.orderEngine
     * @param {import('../discord/discordProvider.js').DiscordProvider} deps.discordProvider
     * @param {import('../exchange/blofinWebSocket.js').BlofinWebSocket} deps.blofinWs
     * @param {import('../exchange/blofinClient.js').BlofinClient} deps.blofinClient
     */
    constructor({ orderEngine, discordProvider, blofinWs, blofinClient }) {
        this.orderEngine = orderEngine;
        this.discordProvider = discordProvider;
        this.blofinWs = blofinWs;
        this.blofinClient = blofinClient;

        this.app = express();
        this.httpServer = createServer(this.app);
        this.io = new SocketIO(this.httpServer, {
            cors: { origin: '*' },
        });

        this._setupRoutes();
        this._setupSocketIO();
        this._setupEngineEvents();
    }

    _setupRoutes() {
        this.app.use(express.json());
        this.app.use(express.static(join(__dirname, 'public')));

        // --- Preferences ---
        this.app.get('/api/preferences', (req, res) => {
            try {
                res.json({ success: true, data: getPreferences() });
            } catch (err) {
                res.status(500).json({ success: false, error: err.message });
            }
        });

        this.app.post('/api/preferences', (req, res) => {
            try {
                updatePreferences(req.body);
                const updated = getPreferences();
                this.io.emit('preferences:updated', updated);
                logger.recordEvent('system', 'Preferences updated');
                res.json({ success: true, data: updated });
            } catch (err) {
                res.status(500).json({ success: false, error: err.message });
            }
        });

        // --- Trader Whitelist ---
        this.app.get('/api/traders', (req, res) => {
            try {
                res.json({ success: true, data: getTraderWhitelist() });
            } catch (err) {
                res.status(500).json({ success: false, error: err.message });
            }
        });

        this.app.post('/api/traders', (req, res) => {
            try {
                const { traderName } = req.body;
                if (!traderName?.trim()) {
                    return res.status(400).json({ success: false, error: 'Trader name required' });
                }
                const added = addTrader(traderName);
                const traders = getTraderWhitelist();
                this.io.emit('traders:updated', traders);
                logger.recordEvent('system', `Trader ${added ? 'added' : 'already exists'}: ${traderName}`);
                res.json({ success: true, added, data: traders });
            } catch (err) {
                res.status(500).json({ success: false, error: err.message });
            }
        });

        this.app.delete('/api/traders/:name', (req, res) => {
            try {
                removeTrader(req.params.name);
                const traders = getTraderWhitelist();
                this.io.emit('traders:updated', traders);
                logger.recordEvent('system', `Trader removed: ${req.params.name}`);
                res.json({ success: true, data: traders });
            } catch (err) {
                res.status(500).json({ success: false, error: err.message });
            }
        });

        // --- Signals & Orders ---
        this.app.get('/api/signals', (req, res) => {
            try {
                res.json({ success: true, data: getRecentSignals(50) });
            } catch (err) {
                res.status(500).json({ success: false, error: err.message });
            }
        });

        this.app.get('/api/orders', (req, res) => {
            try {
                res.json({ success: true, data: getRecentOrders(50) });
            } catch (err) {
                res.status(500).json({ success: false, error: err.message });
            }
        });

        this.app.get('/api/events', (req, res) => {
            try {
                res.json({ success: true, data: logger.getEvents(100) });
            } catch (err) {
                res.status(500).json({ success: false, error: err.message });
            }
        });

        // --- Signal Edit History ---
        this.app.get('/api/signal-edits/:messageId', (req, res) => {
            try {
                const edits = getSignalEdits(req.params.messageId);
                res.json({ success: true, data: edits });
            } catch (err) {
                res.status(500).json({ success: false, error: err.message });
            }
        });

        // --- Status ---
        this.app.get('/api/status', (req, res) => {
            res.json({
                success: true,
                data: {
                    discord: this.discordProvider?.isConnected() || false,
                    blofinWs: this.blofinWs?.privateWs?.readyState === 1 || false,
                    uptime: process.uptime(),
                },
            });
        });

        // --- Emergency close ---
        this.app.post('/api/emergency-close', async (req, res) => {
            const { instId } = req.body;
            try {
                await this.orderEngine.emergencyClose(instId);
                logger.recordEvent('order', `Emergency close: ${instId}`);
                res.json({ success: true });
            } catch (err) {
                res.status(500).json({ success: false, error: err.message });
            }
        });

        // --- Confirm signal ---
        this.app.post('/api/confirm-signal', async (req, res) => {
            const { signal } = req.body;
            try {
                await this.orderEngine.confirmAndExecute(signal);
                res.json({ success: true });
            } catch (err) {
                res.status(500).json({ success: false, error: err.message });
            }
        });
    }

    _setupSocketIO() {
        this.io.on('connection', (socket) => {
            logger.debug('Dashboard', `Client connected: ${socket.id}`);

            socket.emit('init', {
                preferences: getPreferences(),
                traders: getTraderWhitelist(),
                events: logger.getEvents(50),
                status: {
                    discord: this.discordProvider?.isConnected() || false,
                    blofinWs: this.blofinWs?.privateWs?.readyState === 1 || false,
                    uptime: process.uptime(),
                },
            });

            socket.on('disconnect', () => {
                logger.debug('Dashboard', `Client disconnected: ${socket.id}`);
            });
        });
    }

    _setupEngineEvents() {
        const engine = this.orderEngine;

        engine.on('signalAccepted', ({ signal, prefs }) => {
            const event = logger.recordEvent('signal', `Signal: ${signal.side.toUpperCase()} ${signal.instId} @ ${signal.entryPrice || 'MARKET'} | Trader: ${signal.traderName} | ${signal.leverage}x`, signal);
            this.io.emit('signal:accepted', { signal, prefs, event });
        });

        engine.on('signalRejected', ({ signal, reason }) => {
            const event = logger.recordEvent('signal', `Rejected: ${reason}`, signal);
            this.io.emit('signal:rejected', { signal, reason, event });
        });

        engine.on('confirmRequired', ({ signal, prefs }) => {
            const event = logger.recordEvent('order', `Awaiting confirmation: ${signal.side.toUpperCase()} ${signal.instId}`, signal);
            this.io.emit('signal:confirmRequired', { signal, prefs, event });
        });

        engine.on('execution:start', ({ signal, step }) => {
            const event = logger.recordEvent('order', `Executing: ${signal.side.toUpperCase()} ${signal.instId}`, { step });
            this.io.emit('execution:start', { signal, step, event });
        });

        engine.on('execution:progress', ({ signal, step }) => {
            const event = logger.recordEvent('order', step, { instId: signal.instId });
            this.io.emit('execution:progress', { signal, step, event });
        });

        engine.on('execution:complete', (data) => {
            const event = logger.recordEvent('order', `✓ Complete: ${data.signal.side.toUpperCase()} ${data.signal.instId} | Stop @ ${data.stopPrice}`, data);
            this.io.emit('execution:complete', { ...data, event });
        });

        engine.on('execution:failed', ({ signal, reason }) => {
            const event = logger.recordEvent('error', `✗ Failed: ${signal.instId} — ${reason}`, { signal });
            this.io.emit('execution:failed', { signal, reason, event });
        });

        engine.on('execution:skipped', ({ signal, reason }) => {
            const event = logger.recordEvent('order', `Skipped: ${signal.instId} — ${reason}`);
            this.io.emit('execution:skipped', { signal, reason, event });
        });

        engine.on('execution:stopFailed', ({ signal, orderId, reason }) => {
            const event = logger.recordEvent('error', `Stop-loss failed: ${signal.instId} — ${reason}`, { orderId });
            this.io.emit('execution:stopFailed', { signal, orderId, reason, event });
        });

        engine.on('emergencyClose', ({ instId }) => {
            const event = logger.recordEvent('order', `⚠ Emergency close: ${instId}`);
            this.io.emit('emergencyClose', { instId, event });
        });

        // --- New edit-tracking events ---
        engine.on('signal:dcaDetected', ({ signal, dcaLevels, prefs }) => {
            const dcaStr = dcaLevels.map(d => `DCA${d.level}: $${d.price}`).join(', ');
            const event = logger.recordEvent('signal', `DCA levels detected: ${dcaStr}`, { instId: signal.instId, useDca: prefs.useDca });
            this.io.emit('signal:dcaDetected', { signal, dcaLevels, prefs, event });
        });

        engine.on('signal:tpHit', ({ signal, tpHits, messageId, version }) => {
            const event = logger.recordEvent('signal', `TP${tpHits.join(', TP')} HIT — ${signal.instId}`, { messageId, version });
            this.io.emit('signal:tpHit', { signal, tpHits, messageId, version, event });
        });

        engine.on('signal:closed', ({ signal, finalPnl, messageId, version }) => {
            const event = logger.recordEvent('order', `Trade closed: ${signal.instId} | P&L: ${finalPnl || 'N/A'}`, { messageId, version });
            this.io.emit('signal:closed', { signal, finalPnl, messageId, version, event });
        });

        engine.on('signal:edit', ({ signal, diff, messageId, version }) => {
            const event = logger.recordEvent('signal', `Signal edit v${version}: ${signal.instId}`, { diff });
            this.io.emit('signal:edit', { signal, diff, messageId, version, event });
        });
    }

    start(port = 3000) {
        this.httpServer.listen(port, () => {
            logger.info('Dashboard', `Dashboard running at http://localhost:${port}`);
            logger.recordEvent('system', `Dashboard started on port ${port}`);
        });
    }
}
