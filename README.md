# AutoSingalPerpTrader

> Discord Signal → Blofin Perpetual Futures Execution Bot

A low-latency, event-driven bot that monitors a Discord channel for trading signals, parses them, and automatically executes orders on **Blofin** with configurable leverage, margin mode, and trailing stop protection.

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Required environment variables:

| Variable | Description |
| :--- | :--- |
| `DISCORD_BOT_TOKEN` | Your Discord bot token |
| `DISCORD_CHANNEL_ID` | Channel ID to monitor for signals |
| `BLOFIN_API_KEY` | Blofin API key |
| `BLOFIN_API_SECRET` | Blofin API secret |
| `BLOFIN_PASSPHRASE` | Blofin API passphrase |
| `BLOFIN_DEMO_TRADING` | Set to `true` for demo mode (recommended initially) |

### 3. Run

```bash
npm start
# or with auto-restart on changes:
npm run dev
```

### 4. Open Dashboard

Navigate to `http://localhost:3000` in your browser.

## Features

- **Discord signal monitoring** — listens for LONG/SHORT signals with entry prices
- **Auto-execution** — places market/limit orders on Blofin within milliseconds
- **Trailing stop loss** — automatic TPSL or algo stop placement after fill
- **Configurable defaults** — order amount, leverage, margin mode, variance %
- **Real-time dashboard** — live signal feed, order history, event log
- **Audit logging** — full API request/response trail in `logs/audit-*.log`

## Architecture

```text
src/
├── index.js                  # Application entry point
├── config/
│   ├── preferenceManager.js  # SQLite-backed config CRUD
│   └── schema.sql            # Database schema
├── discord/
│   └── discordProvider.js    # Discord.js bot client
├── parser/
│   └── signalParser.js       # Multi-pattern signal regex engine
├── exchange/
│   ├── blofinClient.js       # Blofin REST API client
│   └── blofinWebSocket.js    # Blofin WebSocket client
├── engine/
│   └── orderEngine.js        # Order execution pipeline
├── dashboard/
│   ├── server.js             # Express + Socket.IO server
│   └── public/               # Dashboard UI (HTML/CSS/JS)
└── utils/
    ├── logger.js             # Structured + audit logging
    └── rateLimit.js          # API rate limiter
```

## License

ISC
