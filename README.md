<<<<<<< HEAD
# AutoSignalPerpTrader 🤖📉

> **Automated Discord Signal Execution for Blofin Perpetual Futures**
=======
# reimagined-fintrader
 🤖📉

> **Automated Discord Signal Execution for Blofin (More coming) Perpetual Futures**
>>>>>>> e43b86f5ccfd2b0aa55e385fdb0dfab4091240ce

AutoSignalPerpTrader is a high-performance, event-driven trading bot that bridges the gap between social trading communities and professional exchange execution. It monitors specific Discord channels for trading signals (Long/Short, Entry, TP, SL) and executes them on the **Blofin** exchange with millisecond precision.

---

## 🚀 Key Features

- **Real-Time Signal Monitoring**: Low-latency listening for Discord `MessageCreate` and `MessageUpdate` events.
- **Advanced Parsing Engine**: Custom regex-based logic to handle varied signal formats, including embeds and edits.
- **Auto-Execution**: Instant order placement for Market and Limit orders.
- **Smart Protection**: Automatic Trailing Stop Loss (TSL) and Take Profit (TP) management.
- **Live Dashboard**: A sleek, real-time web interface to monitor active trades, system logs, and configuration.
- **Audit-Ready Logging**: Detailed logging system that tracks every API request and response for forensic trade analysis.

---

## 🛠 Tech Stack

- **Runtime**: Node.js (v18+)
- **Communication**: Socket.IO (Real-time events), Discord.js (Gateway interaction)
- **Database**: SQLite (via `better-sqlite3`) for lightweight, reliable persistence.
- **Exchange**: Blofin API (REST & WebSockets)
- **Frontend**: Vanilla HTML5/CSS3/JS for a lightweight, zero-dependency dashboard.

---

## 📋 Prerequisites

- **Discord**: A Bot Token from the [Discord Developer Portal](https://discord.com/developers/applications) with `Message Content Intent` enabled.
- **Blofin**: API Key, Secret, and Passphrase (Demo Trading supported).
- **Environment**: Node.js installed on your machine.

---

## 🏁 Quick Start

### 1. Installation

```bash
npm install
```

### 2. Configuration

Create a `.env` file in the root directory (refer to `.env.example`):

```env
DISCORD_BOT_TOKEN=your_token_here
DISCORD_CHANNEL_ID=your_channel_id_here
BLOFIN_API_KEY=your_key
BLOFIN_API_SECRET=your_secret
BLOFIN_PASSPHRASE=your_passphrase
BLOFIN_DEMO_TRADING=true
```

### 3. Launch

```bash
# Production mode
npm start

# Development mode (with auto-restart)
npm run dev
```

### 4. Monitor

Navigate to `http://localhost:3000` to view your live trading dashboard.

---

## 📂 Project Structure

```text
src/
├── index.js                  # App bootstrap
├── discord/
│   └── discordProvider.js    # Discord Gateway integration
├── engine/
│   └── orderEngine.js        # Trade execution & logic
├── exchange/
│   ├── blofinClient.js       # REST API implementation
│   └── blofinWebSocket.js    # Real-time data stream
├── parser/
│   └── signalParser.js       # Signal extraction logic
├── config/
│   └── preferenceManager.js  # SQLite config handler
└── dashboard/
    ├── server.js             # Web server & Socket logic
    └── public/               # UI assets
```

---

## ⚖️ License & Disclaimer

**License**: [MIT](LICENSE)

**DISCLAIMER**: Trading perpetual futures involves significant risk. This software is provided "as is" without warranty of any kind. The developers are not responsible for any financial losses incurred through the use of this bot. **Always test in Demo Mode before using real capital.**
