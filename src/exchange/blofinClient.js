import axios from 'axios';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { tradingLimiter, generalLimiter } from '../utils/rateLimit.js';

const BASE_URL = 'https://openapi.blofin.com';
const DEMO_BASE_URL = 'https://demo-trading-openapi.blofin.com';

export class BlofinClient {
    /**
     * @param {object} config
     * @param {string} config.apiKey
     * @param {string} config.apiSecret
     * @param {string} config.passphrase
     * @param {boolean} [config.demoTrading=false]
     */
    constructor({ apiKey, apiSecret, passphrase, demoTrading = false }) {
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.passphrase = passphrase;
        this.baseUrl = demoTrading ? DEMO_BASE_URL : BASE_URL;
        this.demoTrading = demoTrading;

        this.http = axios.create({
            baseURL: this.baseUrl,
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' },
        });

        logger.info('BlofinClient', `Initialized (${demoTrading ? 'DEMO' : 'LIVE'} mode)`);
    }

    // ============================================================
    // Authentication
    // ============================================================

    /**
     * Generate authentication headers for a request.
     * @param {string} method - GET, POST, etc.
     * @param {string} path - API path (e.g., /api/v1/trade/order)
     * @param {string} [body=''] - JSON body string
     * @returns {object} Headers object
     */
    _signRequest(method, path, body = '') {
        const timestamp = Date.now().toString();
        const nonce = crypto.randomBytes(16).toString('hex');
        const prehash = timestamp + method.toUpperCase() + path + body + nonce;

        const signature = crypto
            .createHmac('sha256', this.apiSecret)
            .update(prehash)
            .digest('base64');

        return {
            'ACCESS-KEY': this.apiKey,
            'ACCESS-SIGN': signature,
            'ACCESS-TIMESTAMP': timestamp,
            'ACCESS-NONCE': nonce,
            'ACCESS-PASSPHRASE': this.passphrase,
        };
    }

    /**
     * Make an authenticated GET request.
     * @param {string} path
     * @param {object} [params={}]
     * @param {boolean} [isTrading=false]
     * @returns {Promise<object>}
     */
    async get(path, params = {}, isTrading = false) {
        const limiter = isTrading ? tradingLimiter : generalLimiter;
        await limiter.acquire();

        const queryString = Object.entries(params)
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
            .join('&');

        const fullPath = queryString ? `${path}?${queryString}` : path;
        const headers = this._signRequest('GET', fullPath);

        logger.audit('API_REQUEST', 'BlofinClient', { method: 'GET', path: fullPath, params });

        try {
            const startMs = Date.now();
            const response = await this.http.get(fullPath, { headers });
            const elapsed = Date.now() - startMs;
            logger.audit('API_RESPONSE', 'BlofinClient', { method: 'GET', path: fullPath, status: response.status, code: response.data?.code, elapsed: `${elapsed}ms` });
            logger.recordEvent('api', `GET ${path} → ${response.data?.code === '0' ? '✓' : '✗'} (${elapsed}ms)`);
            this._checkResponse(response.data, path);
            return response.data;
        } catch (error) {
            this._handleError(error, 'GET', path);
        }
    }

    /**
     * Make an authenticated POST request.
     * @param {string} path
     * @param {object} body
     * @param {boolean} [isTrading=true]
     * @returns {Promise<object>}
     */
    async post(path, body, isTrading = true) {
        const limiter = isTrading ? tradingLimiter : generalLimiter;
        await limiter.acquire();

        const bodyStr = JSON.stringify(body);
        const headers = this._signRequest('POST', path, bodyStr);

        logger.audit('API_REQUEST', 'BlofinClient', { method: 'POST', path, body });

        try {
            const startMs = Date.now();
            const response = await this.http.post(path, body, { headers });
            const elapsed = Date.now() - startMs;
            logger.audit('API_RESPONSE', 'BlofinClient', { method: 'POST', path, status: response.status, code: response.data?.code, responseData: response.data?.data, elapsed: `${elapsed}ms` });
            logger.recordEvent('api', `POST ${path} → ${response.data?.code === '0' ? '✓' : '✗'} (${elapsed}ms)`, body);
            this._checkResponse(response.data, path);
            return response.data;
        } catch (error) {
            this._handleError(error, 'POST', path);
        }
    }

    _checkResponse(data, path) {
        if (data.code !== '0' && data.code !== 0) {
            const err = new Error(`Blofin API error on ${path}: [${data.code}] ${data.msg}`);
            err.code = data.code;
            err.apiMsg = data.msg;
            throw err;
        }
    }

    _handleError(error, method, path) {
        const errDetails = error.response
            ? { status: error.response.status, data: error.response.data }
            : { message: error.message };

        logger.error('BlofinClient', `${method} ${path} failed`, errDetails);
        logger.audit('API_ERROR', 'BlofinClient', { method, path, ...errDetails });
        logger.recordEvent('error', `${method} ${path} failed: ${error.response?.data?.msg || error.message}`);
        throw error;
    }

    // ============================================================
    // Account Endpoints
    // ============================================================

    /** Get futures account balance. */
    async getBalance() {
        const res = await this.get('/api/v1/account/balance');
        return res.data;
    }

    /** Get current positions, optionally filtered by instrument. */
    async getPositions(instId = null) {
        const params = instId ? { instId } : {};
        const res = await this.get('/api/v1/account/positions', params, true);
        return res.data;
    }

    /** Get current margin mode. */
    async getMarginMode() {
        const res = await this.get('/api/v1/account/margin-mode');
        return res.data;
    }

    /** Set margin mode (cross or isolated). */
    async setMarginMode(marginMode) {
        const res = await this.post('/api/v1/account/set-margin-mode', { marginMode }, false);
        return res.data;
    }

    /** Get leverage for an instrument. */
    async getLeverage(instId, marginMode) {
        const res = await this.get('/api/v1/account/batch-leverage-info', { instId, marginMode });
        return res.data;
    }

    /** Set leverage for an instrument. */
    async setLeverage(instId, leverage, marginMode, positionSide = 'net') {
        const res = await this.post('/api/v1/account/set-leverage', {
            instId,
            leverage: String(leverage),
            marginMode,
            positionSide,
        }, false);
        return res.data;
    }

    /** Get position mode (net_mode or long_short_mode). */
    async getPositionMode() {
        const res = await this.get('/api/v1/account/position-mode');
        return res.data;
    }

    /** Set position mode. */
    async setPositionMode(positionMode) {
        const res = await this.post('/api/v1/account/set-position-mode', { positionMode }, false);
        return res.data;
    }

    // ============================================================
    // Trading Endpoints
    // ============================================================

    /**
     * Place a market or limit order.
     * @param {object} params
     * @param {string} params.instId - e.g., "BTC-USDT"
     * @param {string} params.marginMode - "cross" or "isolated"
     * @param {string} params.positionSide - "long", "short", or "net"
     * @param {string} params.side - "buy" or "sell"
     * @param {string} params.orderType - "market", "limit", "post_only", "fok", "ioc"
     * @param {string} params.size - Number of contracts
     * @param {string} [params.price] - Required for limit orders
     * @param {boolean} [params.reduceOnly=false]
     * @param {string} [params.clientOrderId]
     * @returns {Promise<object>}
     */
    async placeOrder({
        instId, marginMode, positionSide, side, orderType, size,
        price, reduceOnly = false, clientOrderId,
    }) {
        const body = {
            instId,
            marginMode,
            positionSide,
            side,
            orderType,
            size: String(size),
            reduceOnly: reduceOnly ? 'true' : 'false',
        };
        if (price && orderType !== 'market') body.price = String(price);
        if (clientOrderId) body.clientOrderId = clientOrderId;

        logger.info('BlofinClient', `Placing ${orderType} order`, body);
        const res = await this.post('/api/v1/trade/order', body);
        return res.data;
    }

    /**
     * Place a TPSL (Take-Profit / Stop-Loss) order.
     * @param {object} params
     * @returns {Promise<object>}
     */
    async placeTPSL({
        instId, marginMode, positionSide, side, size,
        tpTriggerPrice, tpOrderPrice,
        slTriggerPrice, slOrderPrice,
        reduceOnly = true, clientOrderId,
    }) {
        const body = {
            instId,
            marginMode,
            positionSide,
            side,
            size: String(size),
            reduceOnly: reduceOnly ? 'true' : 'false',
        };
        if (tpTriggerPrice) body.tpTriggerPrice = String(tpTriggerPrice);
        if (tpOrderPrice) body.tpOrderPrice = String(tpOrderPrice);
        if (slTriggerPrice) body.slTriggerPrice = String(slTriggerPrice);
        if (slOrderPrice) body.slOrderPrice = String(slOrderPrice);
        if (clientOrderId) body.clientOrderId = clientOrderId;

        logger.info('BlofinClient', 'Placing TPSL order', body);
        const res = await this.post('/api/v1/trade/order-tpsl', body);
        return res.data;
    }

    /**
     * Place an algo / trigger order.
     * @param {object} params
     * @returns {Promise<object>}
     */
    async placeAlgoOrder({
        instId, marginMode, positionSide, side, size,
        orderType = 'trigger', triggerPrice, triggerPriceType = 'last',
        orderPrice = '-1', reduceOnly = true, clientOrderId,
        attachAlgoOrders,
    }) {
        const body = {
            instId,
            marginMode,
            positionSide,
            side,
            size: String(size),
            orderType,
            triggerPrice: String(triggerPrice),
            triggerPriceType,
            orderPrice: String(orderPrice),
        };
        if (clientOrderId) body.clientOrderId = clientOrderId;
        if (attachAlgoOrders) body.attachAlgoOrders = attachAlgoOrders;

        logger.info('BlofinClient', 'Placing algo order', body);
        const res = await this.post('/api/v1/trade/order-algo', body);
        return res.data;
    }

    /** Cancel an order by orderId. */
    async cancelOrder(orderId, instId) {
        const body = { orderId };
        if (instId) body.instId = instId;
        const res = await this.post('/api/v1/trade/cancel-order', body);
        return res.data;
    }

    /** Cancel a TPSL order. */
    async cancelTPSL(tpslId, instId) {
        const body = { tpslId };
        if (instId) body.instId = instId;
        const res = await this.post('/api/v1/trade/cancel-order-tpsl', body);
        return res.data;
    }

    /** Cancel an algo order. */
    async cancelAlgoOrder(algoId, instId) {
        const body = { algoId };
        if (instId) body.instId = instId;
        const res = await this.post('/api/v1/trade/cancel-order-algo', body);
        return res.data;
    }

    /** Get active orders. */
    async getActiveOrders(instId = null) {
        const params = instId ? { instId } : {};
        const res = await this.get('/api/v1/trade/orders-pending', params, true);
        return res.data;
    }

    /** Get order detail by orderId. */
    async getOrderDetail(orderId) {
        const res = await this.get('/api/v1/trade/order', { orderId }, true);
        return res.data;
    }

    /** Close all positions for an instrument. */
    async closePositions(instId, marginMode) {
        const res = await this.post('/api/v1/trade/close-position', { instId, marginMode });
        return res.data;
    }

    // ============================================================
    // Public Data
    // ============================================================

    /** Get available instruments. */
    async getInstruments() {
        const res = await this.get('/api/v1/market/instruments', { instType: 'SWAP' }, false);
        return res.data;
    }

    /** Get ticker for an instrument. */
    async getTicker(instId) {
        const res = await this.get('/api/v1/market/tickers', { instId }, false);
        return res.data;
    }

    /** Get mark price. */
    async getMarkPrice(instId) {
        const res = await this.get('/api/v1/market/mark-price', { instId }, false);
        return res.data;
    }
}
