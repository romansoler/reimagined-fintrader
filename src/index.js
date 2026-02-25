import 'dotenv/config';
import { logger } from './utils/logger.js';
import { initDatabase, getPreferences, updatePreferences } from './config/preferenceManager.js';
import { BlofinClient } from './exchange/blofinClient.js';
import { BlofinWebSocket } from './exchange/blofinWebSocket.js';
import { DiscordProvider } from './discord/discordProvider.js';
import { OrderEngine } from './engine/orderEngine.js';
import { DashboardServer } from './dashboard/server.js';

// ============================================================
// PerpTrader — Application Entry Point
// ============================================================

async function main() {
    console.log(`
  ╔══════════════════════════════════════════╗
  ║          ⚡ PerpTrader v1.0.0            ║
  ║   Discord → Blofin Signal Execution Bot  ║
  ╚══════════════════════════════════════════╝
  `);

    // --- 1. Initialize Database ---
    logger.info('App', 'Initializing database...');
    initDatabase();
    logger.recordEvent('system', 'Database initialized');

    // --- 2. Load Config ---
    const prefs = getPreferences();
    const channelId = process.env.DISCORD_CHANNEL_ID || prefs.channelId;

    // Sync channel ID from env to DB if set
    if (process.env.DISCORD_CHANNEL_ID && process.env.DISCORD_CHANNEL_ID !== prefs.channelId) {
        updatePreferences({ channelId: process.env.DISCORD_CHANNEL_ID });
    }

    logger.info('App', 'Configuration loaded', {
        orderAmount: prefs.orderAmount,
        leverage: prefs.leverage,
        leverageSource: prefs.leverageSource,
        marginMode: prefs.marginMode,
        trailingStopVariance: prefs.trailingStopVariance,
        orderType: prefs.orderType,
        slippagePercent: prefs.slippagePercent,
        useDca: prefs.useDca,
        dcaMode: prefs.dcaMode,
        autoExecute: prefs.autoExecute,
    });

    // --- 3. Initialize Blofin Client ---
    const blofinConfig = {
        apiKey: process.env.BLOFIN_API_KEY,
        apiSecret: process.env.BLOFIN_API_SECRET,
        passphrase: process.env.BLOFIN_PASSPHRASE,
        demoTrading: process.env.BLOFIN_DEMO_TRADING === 'true',
    };

    let blofinClient = null;
    let blofinWs = null;

    if (blofinConfig.apiKey && blofinConfig.apiSecret) {
        blofinClient = new BlofinClient(blofinConfig);
        blofinWs = new BlofinWebSocket(blofinConfig);
        logger.recordEvent('system', `Blofin client initialized (${blofinConfig.demoTrading ? 'DEMO' : 'LIVE'} mode)`);

        // Connect WebSocket
        try {
            await blofinWs.connectPrivate();
            blofinWs.subscribeOrders();
            blofinWs.subscribePositions();
            blofinWs.subscribeAccount();
            logger.recordEvent('system', 'Blofin WebSocket connected & subscribed');
        } catch (err) {
            logger.error('App', `Blofin WebSocket connection failed: ${err.message}`);
            logger.recordEvent('error', `Blofin WebSocket failed: ${err.message}`);
        }
    } else {
        logger.warn('App', 'Blofin API keys not configured — trading disabled');
        logger.recordEvent('system', '⚠ Blofin API keys not set — monitoring only');
    }

    // --- 4. Initialize Order Engine ---
    const orderEngine = new OrderEngine(blofinClient, blofinWs || { on: () => { } });
    if (blofinClient) {
        await orderEngine.initialize();
        logger.recordEvent('system', `Order engine loaded ${orderEngine.instruments.size} instruments`);
    }

    // --- 5. Initialize Discord ---
    let discordProvider = null;
    const discordToken = process.env.DISCORD_BOT_TOKEN;

    if (discordToken && channelId) {
        discordProvider = new DiscordProvider({ token: discordToken, channelId, allowedBotNames: ['AO Trades'] });

        discordProvider.on('connected', (tag) => {
            logger.recordEvent('system', `Discord connected as ${tag}`);
        });

        discordProvider.on('message', (msg) => {
            logger.recordEvent('signal', `Discord message from ${msg.author}: ${msg.content.slice(0, 80)}`);
            logger.audit('SIGNAL_RECEIVED', 'Discord', { author: msg.author, content: msg.content, channelId: msg.channelId });
            orderEngine.processMessage(msg);
        });

        discordProvider.on('messageEdit', (msg) => {
            logger.recordEvent('signal', `Message edited: ${msg.messageId}`);
            logger.audit('MESSAGE_EDITED', 'Discord', { messageId: msg.messageId, content: msg.content?.slice(0, 200) });
            orderEngine.processMessageEdit(msg);
        });

        discordProvider.on('disconnected', () => {
            logger.recordEvent('error', 'Discord disconnected');
        });

        try {
            await discordProvider.connect();
        } catch (err) {
            logger.error('App', `Discord login failed: ${err.message}`);
            logger.recordEvent('error', `Discord login failed: ${err.message}`);
        }
    } else {
        logger.warn('App', 'Discord bot token or channel ID not configured');
        logger.recordEvent('system', '⚠ Discord not configured — dashboard only mode');

        // Create a stub for the dashboard
        discordProvider = {
            isConnected: () => false,
            setChannel: () => { },
        };
    }

    // --- 6. Start Dashboard ---
    const dashboardPort = parseInt(process.env.DASHBOARD_PORT || '3000');
    const dashboard = new DashboardServer({
        orderEngine,
        discordProvider,
        blofinWs: blofinWs || { privateWs: null },
        blofinClient,
    });
    dashboard.start(dashboardPort);

    logger.recordEvent('system', '⚡ PerpTrader is running');

    // --- Graceful Shutdown ---
    const shutdown = async () => {
        logger.info('App', 'Shutting down...');
        logger.recordEvent('system', 'Shutting down...');

        if (discordProvider?.disconnect) await discordProvider.disconnect();
        if (blofinWs) blofinWs.close();

        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('uncaughtException', (err) => {
        logger.error('App', `Uncaught exception: ${err.message}`, { stack: err.stack });
        logger.audit('UNCAUGHT_EXCEPTION', 'App', { message: err.message, stack: err.stack });
        logger.recordEvent('error', `Uncaught exception: ${err.message}`);
    });
    process.on('unhandledRejection', (reason) => {
        logger.error('App', `Unhandled rejection: ${reason}`);
        logger.audit('UNHANDLED_REJECTION', 'App', { reason: String(reason) });
        logger.recordEvent('error', `Unhandled rejection: ${reason}`);
    });
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
