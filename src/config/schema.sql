-- PerpTrader Database Schema

-- User preferences (single-row config table)
CREATE TABLE IF NOT EXISTS preferences (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  order_amount REAL NOT NULL DEFAULT 50.0,
  order_type TEXT NOT NULL DEFAULT 'market' CHECK (order_type IN ('market', 'limit')),
  margin_mode TEXT NOT NULL DEFAULT 'cross' CHECK (margin_mode IN ('cross', 'isolated')),
  leverage INTEGER NOT NULL DEFAULT 20,
  trailing_stop_variance REAL NOT NULL DEFAULT 2.0,
  trailing_stop_type TEXT NOT NULL DEFAULT 'tpsl' CHECK (trailing_stop_type IN ('tpsl', 'algo')),
  reduce_only INTEGER NOT NULL DEFAULT 1,
  auto_execute INTEGER NOT NULL DEFAULT 1,
  confirm_before_order INTEGER NOT NULL DEFAULT 0,
  channel_id TEXT,
  slippage_percent REAL NOT NULL DEFAULT 1.0,
  leverage_source TEXT NOT NULL DEFAULT 'signal' CHECK (leverage_source IN ('signal', 'saved', 'max')),
  use_dca INTEGER NOT NULL DEFAULT 0,
  dca_mode TEXT NOT NULL DEFAULT 'display' CHECK (dca_mode IN ('display', 'auto')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Insert default row
INSERT OR IGNORE INTO preferences (id) VALUES (1);

-- Migrate existing preferences table if columns are missing
-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we use a safe pragma approach
-- These will silently fail if columns already exist (handled in code)

-- Trader whitelist
CREATE TABLE IF NOT EXISTS trader_whitelist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Signal edit tracking (version history per Discord message)
CREATE TABLE IF NOT EXISTS signal_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  raw_content TEXT NOT NULL,
  status TEXT,
  tp_hits TEXT,
  final_pnl TEXT,
  is_closed INTEGER NOT NULL DEFAULT 0,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(message_id, version)
);

-- Order history
CREATE TABLE IF NOT EXISTS order_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id TEXT,
  inst_id TEXT NOT NULL,
  side TEXT NOT NULL,
  position_side TEXT NOT NULL,
  order_type TEXT NOT NULL,
  entry_price REAL,
  size REAL NOT NULL,
  leverage INTEGER NOT NULL,
  margin_mode TEXT NOT NULL,
  order_id TEXT,
  tpsl_id TEXT,
  algo_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  pnl REAL,
  trader_name TEXT,
  tp_levels TEXT,
  dca_levels TEXT,
  dca_orders TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Signal log
CREATE TABLE IF NOT EXISTS signal_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id TEXT NOT NULL UNIQUE,
  channel_id TEXT,
  message_id TEXT,
  raw_content TEXT NOT NULL,
  ticker TEXT,
  side TEXT,
  entry_price REAL,
  is_valid INTEGER NOT NULL DEFAULT 0,
  was_executed INTEGER NOT NULL DEFAULT 0,
  rejection_reason TEXT,
  trader_name TEXT,
  leverage INTEGER,
  tp_levels TEXT,
  dca_levels TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_order_history_inst_id ON order_history(inst_id);
CREATE INDEX IF NOT EXISTS idx_order_history_status ON order_history(status);
CREATE INDEX IF NOT EXISTS idx_signal_log_signal_id ON signal_log(signal_id);
CREATE INDEX IF NOT EXISTS idx_signal_log_created_at ON signal_log(created_at);
CREATE INDEX IF NOT EXISTS idx_signal_log_message_id ON signal_log(message_id);
CREATE INDEX IF NOT EXISTS idx_signal_edits_message_id ON signal_edits(message_id);
CREATE INDEX IF NOT EXISTS idx_trader_whitelist_name ON trader_whitelist(trader_name);
