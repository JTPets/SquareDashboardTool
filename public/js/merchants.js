/**
 * Merchants Page Script
 * Handles managing connected Square merchant accounts
 */

let merchants = [];
let activeMerchantId = null;
let disconnectMerchantId = null;

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
  checkOAuthMessages();
  loadMerchants();

  // Close modal on outside click
  document.getElementById('disconnect-modal').addEventListener('click', function(e) {
    if (e.target === this) closeDisconnectModal();
  });
});

/**
 * Check for OAuth callback messages on page load
 */
function checkOAuthMessages() {
  const params = new URLSearchParams(window.location.search);

  // Check for success
  if (params.get('connected') === 'true') {
    const merchantName = params.get('merchant') || 'Square Account';
    showToast(`Successfully connected to ${merchantName}!`, 'success');
    // Clean URL
    window.history.replaceState({}, '', window.location.pathname);
  }

  // Check for errors (OAuth denial or other errors)
  if (params.get('error')) {
    const errorMsg = params.get('error_description') || params.get('error') || 'Authorization was denied or failed';
    showToast(errorMsg, 'error');
    // Clean URL
    window.history.replaceState({}, '', window.location.pathname);
  }
}

/**
 * Show toast notification
 * @param {string} message - Message to display
 * @param {string} type - Type: 'info', 'success', or 'error'
 */
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    padding: 16px 24px;
    border-radius: 8px;
    color: white;
    font-weight: 500;
    z-index: 10000;
    animation: slideIn 0.3s ease;
    max-width: 400px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  `;
  toast.style.backgroundColor = type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6';
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

/**
 * Load merchants from API
 */
async function loadMerchants() {
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
    merchants = data.merchants || [];
    activeMerchantId = data.activeMerchantId;

    renderMerchants();
  } catch (error) {
    console.error('Error loading merchants:', error);
    document.getElementById('merchants-container').innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">Error loading accounts. Please refresh.</div>
      </div>
    `;
  }
}

/**
 * Render merchant cards
 */
function renderMerchants() {
  const container = document.getElementById('merchants-container');

  if (merchants.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🏪</div>
        <h2>No Square Accounts Connected</h2>
        <p>Connect your Square account to start managing your inventory, tracking sales, and more.</p>
        <button class="btn btn-primary" data-action="connectSquare">
          Connect Square Account
        </button>
      </div>
    `;
    return;
  }

  container.innerHTML = '<div class="merchants-list">' + merchants.map(merchant => `
    <div class="merchant-card ${merchant.id === activeMerchantId ? 'active' : ''}">
      <div class="merchant-info">
        <div class="merchant-name">${escapeHtml(merchant.business_name)}</div>
        <div class="merchant-id">ID: ${escapeHtml(merchant.square_merchant_id)}</div>
        <div class="merchant-status">
          <span class="status-badge ${merchant.subscription_status}">${merchant.subscription_status}</span>
          <span class="role-badge">${merchant.role}</span>
        </div>
        <div class="merchant-meta">
          Last synced: ${merchant.last_sync_at ? formatDate(merchant.last_sync_at) : 'Never'}
        </div>
      </div>
      <div class="merchant-actions">
        ${merchant.id !== activeMerchantId ? `
          <button class="btn btn-primary" data-action="switchMerchant" data-action-param="${merchant.id}">
            Switch to This Account
          </button>
        ` : `
          <span class="btn btn-outline" style="cursor: default;">Currently Active</span>
        `}
        <button class="btn btn-outline" data-action="showDisconnectModal" data-merchant-id="${merchant.id}" data-merchant-name="${escapeHtml(merchant.business_name)}">
          Disconnect
        </button>
      </div>
    </div>
  `).join('') + '</div>';
}

/**
 * Connect new Square account (redirect to OAuth)
 */
function connectSquare() {
  window.location.href = '/api/square/oauth/connect?redirect=' + encodeURIComponent(window.location.pathname);
}

/**
 * Switch active merchant
 * @param {HTMLElement} element - The triggering element
 * @param {Event} event - The DOM event
 * @param {string} param - Merchant ID from data-action-param
 */
async function switchMerchant(element, event, param) {
  // Handle being called from event delegation (param is the merchant ID string)
  const merchantId = typeof element === 'string' ? element : param;
  const id = parseInt(merchantId, 10);
  if (isNaN(id)) return;

  try {
    const response = await fetch('/api/merchants/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchantId: id })
    });

    if (!response.ok) {
      throw new Error('Failed to switch merchant');
    }

    // Reload to apply new context
    window.location.reload();
  } catch (error) {
    console.error('Error switching merchant:', error);
    alert('Failed to switch account. Please try again.');
  }
}

/**
 * Show disconnect confirmation modal
 * @param {HTMLElement} element - The triggering element
 * @param {Event} event - The DOM event
 * @param {string} param - Not used, merchant info comes from data attributes
 */
function showDisconnectModal(element, event, param) {
  // Read merchant info from element's data attributes
  const merchantId = element ? parseInt(element.dataset.merchantId, 10) : parseInt(param, 10);
  const merchantName = element ? element.dataset.merchantName : '';
  if (isNaN(merchantId)) return;

  disconnectMerchantId = merchantId;
  document.getElementById('disconnect-merchant-name').textContent = merchantName;
  document.getElementById('disconnect-modal').classList.add('show');
}

/**
 * Close disconnect modal
 */
function closeDisconnectModal() {
  disconnectMerchantId = null;
  document.getElementById('disconnect-modal').classList.remove('show');
}

/**
 * Confirm and execute disconnect
 */
async function confirmDisconnect() {
  if (!disconnectMerchantId) return;

  try {
    const response = await fetch('/api/square/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchantId: disconnectMerchantId })
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Failed to disconnect');
    }

    closeDisconnectModal();
    showToast('Square account disconnected successfully', 'success');
    loadMerchants();
  } catch (error) {
    console.error('Error disconnecting:', error);
    showToast(error.message || 'Failed to disconnect. Please try again.', 'error');
  }
}

/**
 * Copy referral link to clipboard
 */
function copyReferralLink() {
  const input = document.getElementById('referral-url');
  input.select();
  document.execCommand('copy');

  const btn = input.nextElementSibling;
  const originalText = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => btn.textContent = originalText, 2000);
}

/**
 * Escape HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Format date as relative time
 * @param {string} dateString - ISO date string
 * @returns {string} Formatted relative time
 */
function formatDate(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

// Expose functions to global scope for event delegation
window.connectSquare = connectSquare;
window.switchMerchant = switchMerchant;
window.showDisconnectModal = showDisconnectModal;
window.closeDisconnectModal = closeDisconnectModal;
window.confirmDisconnect = confirmDisconnect;
window.copyReferralLink = copyReferralLink;
