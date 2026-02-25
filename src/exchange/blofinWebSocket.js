import WebSocket from 'ws';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { EventEmitter } from 'events';

const WS_PUBLIC_URL = 'wss://openapi.blofin.com/ws/public';
const WS_PRIVATE_URL = 'wss://openapi.blofin.com/ws/private';
const DEMO_WS_PRIVATE_URL = 'wss://demo-trading-openapi.blofin.com/ws/private';

export class BlofinWebSocket extends EventEmitter {
    /**
     * @param {object} config
     * @param {string} config.apiKey
     * @param {string} config.apiSecret
     * @param {string} config.passphrase
     * @param {boolean} [config.demoTrading=false]
     */
    constructor({ apiKey, apiSecret, passphrase, demoTrading = false }) {
        super();
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.passphrase = passphrase;
        this.demoTrading = demoTrading;

        /** @type {WebSocket|null} */
        this.privateWs = null;
        /** @type {WebSocket|null} */
        this.publicWs = null;

        this._reconnectDelay = 1000;
        this._maxReconnectDelay = 30000;
        this._heartbeatInterval = null;
        this._isClosing = false;
    }

    // ============================================================
    // Private WebSocket (authenticated — orders, positions, account)
    // ============================================================

    async connectPrivate() {
        const url = this.demoTrading ? DEMO_WS_PRIVATE_URL : WS_PRIVATE_URL;
        return this._connect('private', url, true);
    }

    connectPublic() {
        return this._connect('public', WS_PUBLIC_URL, false);
    }

    _connect(type, url, authenticate) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);

            ws.on('open', async () => {
                logger.info('BlofinWS', `${type} WebSocket connected`);
                this._reconnectDelay = 1000;
                this._startHeartbeat(ws, type);

                if (authenticate) {
                    try {
                        await this._authenticate(ws);
                        resolve();
                    } catch (err) {
                        reject(err);
                    }
                } else {
                    resolve();
                }
            });

            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    this._handleMessage(type, msg);
                } catch {
                    // Heartbeat pong or non-JSON response
                }
            });

            ws.on('close', (code) => {
                logger.warn('BlofinWS', `${type} WebSocket closed (code: ${code})`);
                this._stopHeartbeat(type);
                if (!this._isClosing) {
                    this._scheduleReconnect(type, url, authenticate);
                }
            });

            ws.on('error', (err) => {
                logger.error('BlofinWS', `${type} WebSocket error: ${err.message}`);
            });

            if (type === 'private') this.privateWs = ws;
            else this.publicWs = ws;
        });
    }

    _authenticate(ws) {
        return new Promise((resolve, reject) => {
            const timestamp = Math.floor(Date.now() / 1000).toString();
            const nonce = crypto.randomBytes(16).toString('hex');
            const prehash = timestamp + 'GET' + '/users/self/verify' + nonce;
            const sign = crypto
                .createHmac('sha256', this.apiSecret)
                .update(prehash)
                .digest('base64');

            const loginMsg = {
                op: 'login',
                args: [{
                    apiKey: this.apiKey,
                    passphrase: this.passphrase,
                    timestamp,
                    sign,
                    nonce,
                }],
            };

            const timeout = setTimeout(() => reject(new Error('WS auth timeout')), 10000);

            const handler = (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.event === 'login') {
                        clearTimeout(timeout);
                        ws.removeListener('message', handler);
                        if (msg.code === '0') {
                            logger.info('BlofinWS', 'Authenticated successfully');
                            resolve();
                        } else {
                            reject(new Error(`WS auth failed: ${msg.msg}`));
                        }
                    }
                } catch { /* ignore parse errors */ }
            };

            ws.on('message', handler);
            ws.send(JSON.stringify(loginMsg));
        });
    }

    // ============================================================
    // Subscriptions
    // ============================================================

    /**
     * Subscribe to order updates (private).
     * @param {string} instId - Instrument ID or omit for all
     */
    subscribeOrders(instId) {
        const args = { channel: 'orders' };
        if (instId) args.instId = instId;
        this._subscribe(this.privateWs, [args]);
    }

    /** Subscribe to position updates (private). */
    subscribePositions(instId) {
        const args = { channel: 'positions' };
        if (instId) args.instId = instId;
        this._subscribe(this.privateWs, [args]);
    }

    /** Subscribe to account updates (private). */
    subscribeAccount() {
        this._subscribe(this.privateWs, [{ channel: 'account' }]);
    }

    /** Subscribe to algo order updates (private). */
    subscribeAlgoOrders(instId) {
        const args = { channel: 'orders-algo' };
        if (instId) args.instId = instId;
        this._subscribe(this.privateWs, [args]);
    }

    /** Subscribe to ticker updates (public). */
    subscribeTicker(instId) {
        this._subscribe(this.publicWs, [{ channel: 'tickers', instId }]);
    }

    _subscribe(ws, args) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            logger.warn('BlofinWS', 'Cannot subscribe: WebSocket not connected');
            return;
        }
        ws.send(JSON.stringify({ op: 'subscribe', args }));
        logger.debug('BlofinWS', 'Subscribed', args);
    }

    // ============================================================
    // Message Handling
    // ============================================================

    _handleMessage(type, msg) {
        // Subscription confirmation
        if (msg.event === 'subscribe') {
            logger.debug('BlofinWS', `Subscription confirmed: ${JSON.stringify(msg.arg)}`);
            return;
        }

        // Data push
        if (msg.arg && msg.data) {
            const channel = msg.arg.channel;

            switch (channel) {
                case 'orders':
                    for (const order of msg.data) {
                        this.emit('order', order);
                        // Emit specific event for fills
                        if (order.state === 'filled') {
                            this.emit('orderFilled', order);
                        }
                    }
                    break;

                case 'positions':
                    for (const pos of msg.data) {
                        this.emit('position', pos);
                    }
                    break;

                case 'account':
                    for (const acct of msg.data) {
                        this.emit('account', acct);
                    }
                    break;

                case 'orders-algo':
                    for (const algo of msg.data) {
                        this.emit('algoOrder', algo);
                    }
                    break;

                case 'tickers':
                    for (const ticker of msg.data) {
                        this.emit('ticker', ticker);
                    }
                    break;

                default:
                    this.emit('data', { channel, data: msg.data });
            }
        }
    }

    // ============================================================
    // Heartbeat & Reconnection
    // ============================================================

    _startHeartbeat(ws, type) {
        const key = `_heartbeat_${type}`;
        this[key] = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send('ping');
            }
        }, 25000); // Ping every 25s (Blofin requires within 30s)
    }

    _stopHeartbeat(type) {
        const key = `_heartbeat_${type}`;
        if (this[key]) {
            clearInterval(this[key]);
            this[key] = null;
        }
    }

    _scheduleReconnect(type, url, authenticate) {
        logger.info('BlofinWS', `Reconnecting ${type} in ${this._reconnectDelay}ms...`);
        setTimeout(() => {
            this._connect(type, url, authenticate).catch(err => {
                logger.error('BlofinWS', `Reconnection failed: ${err.message}`);
            });
        }, this._reconnectDelay);
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay);
    }

    /** Gracefully close all connections. */
    close() {
        this._isClosing = true;
        this._stopHeartbeat('private');
        this._stopHeartbeat('public');
        if (this.privateWs) this.privateWs.close();
        if (this.publicWs) this.publicWs.close();
        logger.info('BlofinWS', 'All WebSocket connections closed');
    }
}
