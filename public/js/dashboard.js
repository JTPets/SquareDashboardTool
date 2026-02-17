/**
 * Dashboard Page Script
 * Main dashboard for managing store operations, inventory, and automations
 */

// Auto-refresh interval ID (for cleanup if needed)
let autoRefreshInterval = null;
let dashboardReady = false;
const AUTO_REFRESH_MS = 300000;

// Set current year in footer
document.getElementById('year').textContent = new Date().getFullYear();

/**
 * Toggle API documentation section visibility
 */
function toggleApiList() {
  const section = document.getElementById('api-section');
  section.style.display = section.style.display === 'none' ? 'block' : 'none';
}

/**
 * Show health check modal
 */
function showHealthModal() {
  const modal = document.getElementById('health-modal');
  modal.style.display = 'flex';
  loadHealthStatus();
}

/**
 * Hide health check modal
 */
function hideHealthModal() {
  document.getElementById('health-modal').style.display = 'none';
}

/**
 * Navigate to URL (for data-action handler)
 * @param {HTMLElement} element - The triggering element
 * @param {Event} event - The DOM event
 * @param {string} url - URL from data-action-param
 */
function navigate(element, event, url) {
  window.location.href = url;
}

/**
 * Show API info alert (for data-action handler)
 * @param {HTMLElement} element - The triggering element
 * @param {Event} event - The DOM event
 * @param {string} message - Message from data-action-param
 */
function showApiInfo(element, event, message) {
  alert(message);
}

/**
 * Load and display system health status
 */
async function loadHealthStatus() {
  const content = document.getElementById('health-content');
  content.innerHTML = '<p style="color: #6b7280;">Loading...</p>';

  try {
    const response = await fetch('/api/health');
    const data = await response.json();

    const statusIcon = (status) => status === 'connected' || status === 'ok' ? '✅' : '❌';
    const statusColor = (status) => status === 'connected' || status === 'ok' ? '#10b981' : '#ef4444';

    let html = `
      <div style="display: grid; gap: 15px;">
        <div style="display: flex; justify-content: space-between; padding: 12px; background: #f9fafb; border-radius: 8px; border-left: 4px solid ${statusColor(data.database)};">
          <span><strong>🗄️ Database</strong></span>
          <span>${statusIcon(data.database)} ${data.database || 'Unknown'}</span>
        </div>
        <div style="display: flex; justify-content: space-between; padding: 12px; background: #f9fafb; border-radius: 8px; border-left: 4px solid ${statusColor(data.square)};">
          <span><strong>🟦 Square API</strong></span>
          <span>${statusIcon(data.square)} ${data.square || 'Unknown'}</span>
        </div>
        <div style="padding: 12px; background: #f9fafb; border-radius: 8px;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
            <span><strong>⏱️ Uptime</strong></span>
            <span>${data.uptime || 'N/A'}</span>
          </div>
          <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
            <span><strong>💾 Memory</strong></span>
            <span>${data.memory?.heapUsed ? Math.round(data.memory.heapUsed / 1024 / 1024) + ' MB' : 'N/A'}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span><strong>🔧 Node Version</strong></span>
            <span>${data.nodeVersion || 'N/A'}</span>
          </div>
        </div>
        <div style="text-align: center; color: #9ca3af; font-size: 12px;">
          Last checked: ${new Date().toLocaleTimeString()}
        </div>
      </div>
    `;
    content.innerHTML = html;
  } catch (e) {
    content.innerHTML = `<p style="color: #ef4444;">❌ Failed to load health status: ${escapeHtml(e.message)}</p>`;
  }
}

// Close modal on background click
document.getElementById('health-modal').addEventListener('click', function(e) {
  if (e.target === this) hideHealthModal();
});

/**
 * Format timestamp as relative time (e.g., "2h ago")
 * @param {string} timestamp - ISO timestamp
 * @returns {string} Formatted relative time
 */
function formatTimestamp(timestamp) {
  if (!timestamp) return 'Never';
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

/**
 * Format next sync time
 * @param {string} timestamp - ISO timestamp
 * @returns {string} Formatted time until next sync
 */
function formatNextSync(timestamp) {
  if (!timestamp) return 'N/A';
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = date - now;
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  return `${diffHours}h`;
}

/**
 * Helper function to update a stat display
 * @param {string} id - Element ID
 * @param {string} value - Value to display
 */
function updateStat(id, value) {
  const elem = document.getElementById(id);
  if (elem) {
    elem.textContent = value;
    elem.classList.remove('loading-placeholder');
  }
}

/**
 * Load dashboard statistics from multiple API endpoints
 */
async function loadStats() {
  try {
    console.log('Loading dashboard stats...');

    // Load merchant config for supply days (avoid hardcoded values)
    var configRes = await fetch('/api/config');
    var config = configRes.ok ? await configRes.json() : {};
    var supplyDays = config.defaultSupplyDays || 45;

    // Fetch all data in parallel
    const [inventoryResponse, expiryResponse, reorderResponse, cycleResponse] = await Promise.all([
      fetch('/api/inventory'),
      fetch('/api/expirations'),
      fetch('/api/reorder-suggestions?supply_days=' + supplyDays),
      fetch('/api/cycle-counts/pending')
    ]);

    // Process inventory data
    const inventoryData = await inventoryResponse.json();
    const inventory = Array.isArray(inventoryData) ? inventoryData : (inventoryData.inventory || []);

    const uniqueVariations = new Set(inventory.map(i => i.variation_id)).size;
    const totalUnits = inventory.reduce((sum, item) => sum + (parseFloat(item.quantity) || 0), 0);
    const outOfStock = inventory.filter(item => (parseFloat(item.quantity) || 0) === 0).length;

    // Calculate retail value (using price_money)
    const totalValueRetail = inventory.reduce((sum, item) => {
      const qty = item.quantity || 0;
      const price = item.price_money || 0;
      return sum + (qty * price / 100);
    }, 0);

    // Calculate COG value (using unit_cost_cents)
    const totalValueCOG = inventory.reduce((sum, item) => {
      const qty = item.quantity || 0;
      const cost = item.unit_cost_cents || 0;
      return sum + (qty * cost / 100);
    }, 0);

    // Process expiration data
    const expiryData = await expiryResponse.json();
    const expirations = Array.isArray(expiryData) ? expiryData : (expiryData.items || []);

    const withExpiryData = expirations.filter(i => i.expiration_date || i.does_not_expire).length;
    const expiryPercent = uniqueVariations > 0 ? ((withExpiryData / uniqueVariations) * 100).toFixed(1) : 0;

    const today = new Date();
    const in120Days = new Date(today.getTime() + 120*24*60*60*1000);
    const expiringSoon = expirations.filter(i => {
      if (!i.expiration_date || i.does_not_expire) return false;
      // Filter out items with 0 stock (can't audit what you don't have)
      if ((parseFloat(i.quantity) || 0) <= 0) return false;
      const expDate = new Date(i.expiration_date);
      return expDate <= in120Days && expDate >= today;
    }).length;

    // Process reorder data
    const reorderData = await reorderResponse.json();
    const alertCount = reorderData.count || reorderData.suggestions?.length || 0;

    // Process cycle count data
    const cycleData = await cycleResponse.json();
    const pendingCount = cycleData.items?.length || 0;
    const targetCount = cycleData.target || 0;
    // Completion rate: 0% if pending >= target, otherwise (target - pending) / target * 100
    // Always clamp between 0% and 100%
    const completionRate = targetCount > 0
      ? Math.max(0, Math.min(100, Math.round(((targetCount - pendingCount) / targetCount) * 100)))
      : 0;

    // Update all stats
    updateStat('stat-variations', uniqueVariations.toLocaleString());
    updateStat('stat-total-units', Math.floor(totalUnits).toLocaleString());
    updateStat('stat-value-retail', '$' + totalValueRetail.toLocaleString('en-CA', {minimumFractionDigits: 0, maximumFractionDigits: 0}));
    updateStat('stat-value-cog', '$' + totalValueCOG.toLocaleString('en-CA', {minimumFractionDigits: 0, maximumFractionDigits: 0}));
    updateStat('stat-out-of-stock', outOfStock.toLocaleString());

    updateStat('stat-expiry-data', `${withExpiryData.toLocaleString()} (${expiryPercent}%)`);
    updateStat('stat-expiring-soon', expiringSoon.toLocaleString());

    updateStat('stat-alerts', alertCount.toLocaleString());

    updateStat('stat-cycle-pending', pendingCount.toLocaleString());
    updateStat('stat-cycle-target', targetCount.toLocaleString());
    updateStat('stat-cycle-complete', `${completionRate}%`);

    console.log('Dashboard stats updated successfully');

  } catch (error) {
    console.error('Failed to load stats:', error);

    // Show error state
    ['stat-variations', 'stat-total-units', 'stat-value-retail', 'stat-value-cog', 'stat-out-of-stock',
     'stat-expiry-data', 'stat-expiring-soon', 'stat-alerts',
     'stat-cycle-pending', 'stat-cycle-target', 'stat-cycle-complete'].forEach(id => {
      const elem = document.getElementById(id);
      if (elem) {
        elem.textContent = 'Error';
        elem.style.color = '#ef4444';
        elem.classList.remove('loading-placeholder');
      }
    });

    // Update sync status banner with friendly message
    const statusEl = document.getElementById('sync-status');
    if (statusEl) {
      const friendlyMsg = window.ErrorHelper
        ? ErrorHelper.getFriendlyMessage(error, 'inventory', 'load')
        : 'Unable to load dashboard data. Please refresh the page.';
      statusEl.innerHTML = '⚠️ ' + friendlyMsg;
      statusEl.style.background = '#fee2e2';
      statusEl.style.color = '#991b1b';
    }
  }
}

/**
 * Update sync status display
 */
async function updateSyncStatus() {
  try {
    const status = await fetch('/api/sync-status').then(r => r.json());

    let html = '✅ ';
    const syncTypes = ['catalog', 'inventory', 'sales_91d'];
    const parts = [];

    syncTypes.forEach(type => {
      if (status[type]) {
        const last = formatTimestamp(status[type].last_sync);
        const next = formatNextSync(status[type].next_sync_due);
        parts.push(`${type}: ${last} (next in ${next})`);
      }
    });

    html += parts.join(' | ');
    html += ' | <button data-action="runSmartSync">Manual Sync</button>';

    document.getElementById('sync-status').innerHTML = html;
    document.getElementById('sync-status').classList.remove('loading');

  } catch (error) {
    console.error('Failed to load sync status:', error);
  }
}

/**
 * Run smart sync manually
 */
async function runSmartSync() {
  const statusEl = document.getElementById('sync-status');
  statusEl.innerHTML = '⏳ Syncing...';
  statusEl.classList.add('loading');

  try {
    const result = await fetch('/api/sync-smart', { method: 'POST' }).then(r => r.json());

    statusEl.innerHTML = `✅ Sync complete! Synced: ${escapeHtml(result.synced.join(', ')) || 'none (up to date)'}`;
    statusEl.classList.remove('loading');

    // Reload stats after sync
    setTimeout(() => {
      loadStats();
      updateSyncStatus();
    }, 2000);

  } catch (error) {
    const friendlyMsg = window.ErrorHelper
      ? ErrorHelper.getFriendlyMessage(error, 'sync', 'error')
      : 'Sync failed. Please try again.';
    statusEl.innerHTML = '❌ ' + friendlyMsg;
    statusEl.classList.remove('loading');
    statusEl.style.background = '#fee2e2';
    statusEl.style.color = '#991b1b';
  }
}

/**
 * Load current user info
 */
async function loadUserInfo() {
  try {
    const response = await fetch('/api/auth/me');
    if (response.ok) {
      const data = await response.json();
      document.getElementById('user-email').textContent = data.user?.email || 'User';
      document.getElementById('user-role').textContent = data.user?.role || '';
    }
  } catch (error) {
    console.error('Failed to load user info:', error);
  }
}

/**
 * Load merchant info and check if merchant is connected
 * @returns {boolean} True if merchant is connected
 */
async function loadMerchantInfo() {
  try {
    const response = await fetch('/api/merchants');
    if (!response.ok) {
      if (response.status === 401) {
        window.location.href = '/login.html';
        return;
      }
      throw new Error('Failed to load merchants');
    }

    const data = await response.json();
    const merchants = data.merchants || [];
    const activeMerchantId = data.activeMerchantId;

    if (merchants.length === 0) {
      // Show no-merchant overlay
      document.getElementById('no-merchant-overlay').classList.add('show');
      return false;
    }

    // Find active merchant
    const activeMerchant = merchants.find(m => m.id === activeMerchantId) || merchants[0];

    if (activeMerchant) {
      document.getElementById('merchant-name').textContent = activeMerchant.business_name;
      document.getElementById('merchant-info').style.display = 'block';
    }

    return true;
  } catch (error) {
    console.error('Failed to load merchant info:', error);
    return true; // Don't block on error, let dashboard load
  }
}

/**
 * Connect Square account via OAuth
 */
function connectSquare() {
  window.location.href = '/api/square/oauth/connect?redirect=' + encodeURIComponent(window.location.pathname);
}

/**
 * Logout and redirect to home
 */
async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    window.location.href = '/';
  } catch (error) {
    console.error('Logout failed:', error);
    window.location.href = '/login.html';
  }
}

// Initialize dashboard
document.addEventListener('DOMContentLoaded', async function() {
  loadUserInfo();

  // Load merchant info first - if no merchant, show overlay
  const hasMerchant = await loadMerchantInfo();

  if (hasMerchant) {
    dashboardReady = true;
    loadStats();
    updateSyncStatus();

    // Auto-refresh every 5 minutes (pauses when tab is hidden)
    autoRefreshInterval = setInterval(() => {
      loadStats();
      updateSyncStatus();
    }, AUTO_REFRESH_MS);
  }
});

// Pause polling when tab is hidden, resume when visible
document.addEventListener('visibilitychange', () => {
  if (!dashboardReady) return;
  if (document.hidden) {
    if (autoRefreshInterval) {
      clearInterval(autoRefreshInterval);
      autoRefreshInterval = null;
    }
  } else {
    loadStats();
    updateSyncStatus();
    if (!autoRefreshInterval) {
      autoRefreshInterval = setInterval(() => {
        loadStats();
        updateSyncStatus();
      }, AUTO_REFRESH_MS);
    }
  }
});

// Expose functions to global scope for event delegation
window.logout = logout;
window.navigate = navigate;
window.showApiInfo = showApiInfo;
window.toggleApiList = toggleApiList;
window.showHealthModal = showHealthModal;
window.hideHealthModal = hideHealthModal;
window.connectSquare = connectSquare;
window.runSmartSync = runSmartSync;
