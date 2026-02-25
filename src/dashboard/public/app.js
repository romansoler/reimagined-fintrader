/**
 * PerpTrader Dashboard — Client-Side Application
 * Real-time Socket.IO events, config management, trader whitelist, DCA info, edit tracking.
 */

const socket = io();
let configDirty = false;
let currentTraders = [];
let pendingSignal = null;

// ============================================================
// Initialization
// ============================================================

socket.on('init', ({ preferences, traders, events, status }) => {
    setConfigValues(preferences);
    currentTraders = traders || [];
    renderTraderList();
    if (events) events.forEach(e => addEventEntry(e));
    updateStatus(status);
});

socket.on('connect', () => updateConnectionIndicator('socket', true));
socket.on('disconnect', () => updateConnectionIndicator('socket', false));

// ============================================================
// Config Management
// ============================================================

function setConfigValues(p) {
    document.getElementById('cfgOrderAmount').value = p.orderAmount;
    document.getElementById('cfgOrderType').value = p.orderType;
    document.getElementById('cfgSlippagePercent').value = p.slippagePercent;
    document.getElementById('cfgLeverage').value = p.leverage;
    document.getElementById('cfgLeverageSource').value = p.leverageSource;
    document.getElementById('cfgMarginMode').value = p.marginMode;
    document.getElementById('cfgTrailingStopVariance').value = p.trailingStopVariance;
    document.getElementById('cfgTrailingStopType').value = p.trailingStopType;
    document.getElementById('cfgAutoExecute').checked = p.autoExecute;
    document.getElementById('cfgConfirmBeforeOrder').checked = p.confirmBeforeOrder;
    document.getElementById('cfgUseDca').checked = p.useDca;
    document.getElementById('cfgDcaMode').value = p.dcaMode;
    if (p.channelId) document.getElementById('cfgChannelId').value = p.channelId;
    document.getElementById('configStatus').textContent = 'SAVED';
}

// Track dirty state
document.querySelectorAll('.config-input, .config-select, .toggle-switch input').forEach(el => {
    el.addEventListener('change', () => {
        configDirty = true;
        document.getElementById('configStatus').textContent = 'UNSAVED';
    });
});

async function saveConfig() {
    const body = {
        orderAmount: parseFloat(document.getElementById('cfgOrderAmount').value),
        orderType: document.getElementById('cfgOrderType').value,
        slippagePercent: parseFloat(document.getElementById('cfgSlippagePercent').value),
        leverage: parseInt(document.getElementById('cfgLeverage').value),
        leverageSource: document.getElementById('cfgLeverageSource').value,
        marginMode: document.getElementById('cfgMarginMode').value,
        trailingStopVariance: parseFloat(document.getElementById('cfgTrailingStopVariance').value),
        trailingStopType: document.getElementById('cfgTrailingStopType').value,
        autoExecute: document.getElementById('cfgAutoExecute').checked,
        confirmBeforeOrder: document.getElementById('cfgConfirmBeforeOrder').checked,
        useDca: document.getElementById('cfgUseDca').checked,
        dcaMode: document.getElementById('cfgDcaMode').value,
        channelId: document.getElementById('cfgChannelId').value || null,
    };

    try {
        const res = await fetch('/api/preferences', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (res.ok) {
            configDirty = false;
            document.getElementById('configStatus').textContent = 'SAVED';
            showToast('Configuration saved', 'success');
        }
    } catch (err) {
        showToast(`Save failed: ${err.message}`, 'error');
    }
}

socket.on('preferences:updated', (p) => setConfigValues(p));

// ============================================================
// Trader Whitelist
// ============================================================

async function addTrader() {
    const input = document.getElementById('traderInput');
    const name = input.value.trim();
    if (!name) return;

    try {
        const res = await fetch('/api/traders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ traderName: name }),
        });
        const data = await res.json();
        if (data.success) {
            currentTraders = data.data;
            renderTraderList();
            input.value = '';
            showToast(`Trader "${name}" added`, 'success');
        }
    } catch (err) {
        showToast(`Failed to add trader: ${err.message}`, 'error');
    }
}

async function removeTraderByName(name) {
    try {
        const res = await fetch(`/api/traders/${encodeURIComponent(name)}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            currentTraders = data.data;
            renderTraderList();
            showToast(`Trader "${name}" removed`, 'info');
        }
    } catch (err) {
        showToast(`Failed to remove trader: ${err.message}`, 'error');
    }
}

function renderTraderList() {
    const container = document.getElementById('traderList');
    if (currentTraders.length === 0) {
        container.innerHTML = '<span class="empty-hint">No traders — all signals allowed</span>';
        return;
    }
    container.innerHTML = currentTraders.map(t =>
        `<span class="trader-tag">${t.trader_name}<span class="remove-btn" onclick="removeTraderByName('${t.trader_name.replace(/'/g, "\\'")}')">&times;</span></span>`
    ).join('');
}

socket.on('traders:updated', (traders) => {
    currentTraders = traders;
    renderTraderList();
});

// Allow Enter key to add trader
document.getElementById('traderInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addTrader();
});

// ============================================================
// Signal Feed
// ============================================================

function addSignalCard(signal, type = 'new') {
    const list = document.getElementById('signalList');
    if (list.querySelector('.empty-state')) list.innerHTML = '';

    const card = document.createElement('div');
    const isEdit = type === 'edit';
    card.className = `signal-card ${isEdit ? 'edit' : signal.side}`;

    // TP badges
    let tpHtml = '';
    if (signal.tpLevels?.length > 0) {
        tpHtml = '<div class="signal-tps">' + signal.tpLevels.map(tp =>
            `<span class="tp-badge ${tp.hit ? 'hit' : ''}">TP${tp.level}: ${tp.price}${tp.hit ? ' ✓' : ''}</span>`
        ).join('') + '</div>';
    }

    // DCA badges
    let dcaHtml = '';
    if (signal.dcaLevels?.length > 0) {
        dcaHtml = signal.dcaLevels.map(d =>
            `<span class="tp-badge">DCA${d.level}: ${d.price}</span>`
        ).join('');
        if (tpHtml) {
            tpHtml = tpHtml.replace('</div>', dcaHtml + '</div>');
        } else {
            tpHtml = '<div class="signal-tps">' + dcaHtml + '</div>';
        }
    }

    card.innerHTML = `
    <div class="signal-header">
      <span class="signal-pair">${signal.instId || signal.ticker + '-USDT'}</span>
      <span class="signal-side ${isEdit ? 'edit' : signal.side}">${isEdit ? 'EDIT' : signal.side?.toUpperCase()}</span>
    </div>
    <div class="signal-meta">
      <span>📍 ${signal.entryPrice || 'MARKET'}</span>
      <span>⚡ ${signal.leverage || '?'}x</span>
      ${signal.traderName ? `<span>👤 ${signal.traderName}</span>` : ''}
      ${signal.finalPnl ? `<span>💰 ${signal.finalPnl}</span>` : ''}
      ${signal.isClosed ? '<span>🔒 Closed</span>' : ''}
    </div>
    ${tpHtml}
  `;

    list.prepend(card);

    // Cap signal list
    while (list.children.length > 30) list.removeChild(list.lastChild);
}

socket.on('signal:accepted', ({ signal }) => addSignalCard(signal));
socket.on('signal:rejected', ({ signal, reason }) => {
    addSignalCard(signal);
    showToast(`Signal rejected: ${reason}`, 'warning');
});

// ============================================================
// Signal Edit Events
// ============================================================

socket.on('signal:edit', ({ signal, diff, version }) => {
    addSignalCard(signal, 'edit');
});

socket.on('signal:tpHit', ({ signal, tpHits, version }) => {
    showToast(`TP${tpHits.join(', TP')} HIT — ${signal.instId}`, 'success');
    addSignalCard(signal, 'edit');
});

socket.on('signal:closed', ({ signal, finalPnl }) => {
    showToast(`Trade closed: ${signal.instId} | P&L: ${finalPnl || 'N/A'}`, 'info');
    addSignalCard(signal, 'edit');
});

// ============================================================
// DCA Detection
// ============================================================

socket.on('signal:dcaDetected', ({ signal, dcaLevels, prefs }) => {
    showDcaModal(signal, dcaLevels, prefs);
});

function showDcaModal(signal, dcaLevels, prefs) {
    const explainEl = document.getElementById('dcaExplanation');
    const listEl = document.getElementById('dcaLevelsList');

    const isLong = signal.side === 'long';
    const direction = isLong ? 'below' : 'above';
    const effect = isLong ? 'averaging down' : 'averaging up';

    explainEl.innerHTML = `
    <p><strong>${signal.instId}</strong> signal includes ${dcaLevels.length} DCA level(s) ${direction} entry ($${signal.entryPrice}).</p>
    <br>
    <p>DCA places additional limit orders at these prices, <strong>${effect}</strong> your entry cost if price moves against you before reversing.</p>
    <br>
    <p>DCA is currently <strong>${prefs.useDca ? (prefs.dcaMode === 'auto' ? 'AUTO (placing orders)' : 'DISPLAY ONLY') : 'OFF'}</strong>. Change this in Config → DCA.</p>
  `;

    listEl.innerHTML = dcaLevels.map(d => {
        const pctFromEntry = signal.entryPrice
            ? ((d.price - signal.entryPrice) / signal.entryPrice * 100).toFixed(2)
            : '?';
        return `
      <div class="dca-level-item">
        <span class="label">DCA${d.level}</span>
        <span class="price">$${d.price}</span>
        <span class="effect">${pctFromEntry > 0 ? '+' : ''}${pctFromEntry}% from entry</span>
      </div>
    `;
    }).join('');

    document.getElementById('dcaModal').classList.add('show');
}

function closeDcaModal() {
    document.getElementById('dcaModal').classList.remove('show');
}

// ============================================================
// Confirm Modal
// ============================================================

socket.on('signal:confirmRequired', ({ signal, prefs }) => {
    showConfirmModal(signal, prefs);
});

function showConfirmModal(signal, prefs) {
    pendingSignal = signal;
    const details = document.getElementById('modalDetails');
    details.innerHTML = `
    <div><strong>Pair:</strong> ${signal.instId}</div>
    <div><strong>Side:</strong> ${signal.side?.toUpperCase()}</div>
    <div><strong>Entry:</strong> $${signal.entryPrice || 'MARKET'}</div>
    <div><strong>Leverage:</strong> ${signal.leverage || prefs.leverage}x</div>
    <div><strong>Trader:</strong> ${signal.traderName || 'Unknown'}</div>
    <div><strong>Amount:</strong> $${prefs.orderAmount}</div>
    <div><strong>Order Type:</strong> ${prefs.orderType}</div>
    ${signal.tpLevels?.length ? `<div><strong>TPs:</strong> ${signal.tpLevels.map(t => `$${t.price}`).join(', ')}</div>` : ''}
    ${signal.dcaLevels?.length ? `<div><strong>DCA:</strong> ${signal.dcaLevels.map(d => `$${d.price}`).join(', ')}</div>` : ''}
  `;

    document.getElementById('modalExecuteBtn').onclick = () => confirmExecute();
    document.getElementById('confirmModal').classList.add('show');
}

async function confirmExecute() {
    if (!pendingSignal) return;
    closeModal();

    try {
        await fetch('/api/confirm-signal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ signal: pendingSignal }),
        });
        showToast('Trade confirmed & executing', 'success');
    } catch (err) {
        showToast(`Confirm failed: ${err.message}`, 'error');
    }
    pendingSignal = null;
}

function closeModal() {
    document.getElementById('confirmModal').classList.remove('show');
}

// ============================================================
// Order Table
// ============================================================

socket.on('execution:complete', (data) => {
    addOrderRow(data);
    showToast(`✓ ${data.signal.side?.toUpperCase()} ${data.signal.instId} filled`, 'success');
});

function addOrderRow(data) {
    const tbody = document.getElementById('orderTableBody');
    if (tbody.querySelector('.empty-state')) tbody.innerHTML = '';

    const tr = document.createElement('tr');
    const s = data.signal || {};
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });

    tr.innerHTML = `
    <td>${time}</td>
    <td>${s.instId || '—'}</td>
    <td style="color: ${s.side === 'long' ? 'var(--accent-emerald)' : 'var(--accent-rose)'}">${s.side?.toUpperCase() || '—'}</td>
    <td>${data.type || '—'}</td>
    <td>${s.entryPrice || '—'}</td>
    <td>${data.size || '—'}</td>
    <td>${s.leverage || '—'}x</td>
    <td>${s.traderName || '—'}</td>
    <td style="color: var(--accent-emerald)">ACTIVE</td>
  `;
    tbody.prepend(tr);

    const count = tbody.querySelectorAll('tr').length;
    document.getElementById('orderBadge').textContent = String(count);
}

// Execution progress via event log
socket.on('execution:start', ({ signal, step, event }) => { if (event) addEventEntry(event); });
socket.on('execution:progress', ({ signal, step, event }) => { if (event) addEventEntry(event); });
socket.on('execution:failed', ({ signal, reason, event }) => {
    if (event) addEventEntry(event);
    showToast(`Execution failed: ${reason}`, 'error');
});

// ============================================================
// Event Log
// ============================================================

function addEventEntry(event) {
    const logBody = document.getElementById('eventLogBody');
    if (logBody.querySelector('.empty-state')) logBody.innerHTML = '';

    const div = document.createElement('div');
    div.className = 'event-entry';

    const time = event.timestamp
        ? new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false })
        : new Date().toLocaleTimeString('en-US', { hour12: false });

    div.innerHTML = `
    <span class="event-time">${time}</span>
    <span class="event-type ${event.type || 'system'}">${event.type || 'sys'}</span>
    <span class="event-msg">${event.message || ''}</span>
  `;

    logBody.prepend(div);

    // Cap log
    while (logBody.children.length > 100) logBody.removeChild(logBody.lastChild);

    const count = logBody.querySelectorAll('.event-entry').length;
    document.getElementById('eventBadge').textContent = String(count);
}

// ============================================================
// Emergency Close
// ============================================================

async function emergencyClose() {
    if (!confirm('⚠ Close ALL open positions? This cannot be undone!')) return;

    try {
        const res = await fetch('/api/emergency-close', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instId: '' }),
        });
        showToast('Emergency close sent', res.ok ? 'warning' : 'error');
    } catch (err) {
        showToast(`Emergency close failed: ${err.message}`, 'error');
    }
}

// ============================================================
// Status Polling
// ============================================================

function updateStatus(status) {
    const discordDot = document.getElementById('discordStatus');
    const blofinDot = document.getElementById('blofinStatus');

    discordDot.className = `status-dot ${status?.discord ? 'connected' : 'disconnected'}`;
    blofinDot.className = `status-dot ${status?.blofinWs ? 'connected' : 'disconnected'}`;

    if (status?.uptime) {
        document.getElementById('uptimeDisplay').textContent = formatUptime(status.uptime);
    }
}

function updateConnectionIndicator(type, connected) {
    if (type === 'socket') {
        // visual indicator for dashboard socket itself
    }
}

function formatUptime(seconds) {
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
}

// Poll status every 15s
setInterval(async () => {
    try {
        const res = await fetch('/api/status');
        const data = await res.json();
        if (data.success) updateStatus(data.data);
    } catch { /* ignore */ }
}, 15000);

// ============================================================
// Toast Notifications
// ============================================================

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-10px)';
        toast.style.transition = '0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}
