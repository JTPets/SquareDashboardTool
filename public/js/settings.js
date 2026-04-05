/**
 * Settings Page Script
 * Handles connections, business rules, sync settings, and security/user management
 */

// Load all statuses on page load
async function loadAllStatuses() {
  await Promise.all([
    checkSquareStatus(),
    checkDatabaseStatus(),
    checkGoogleStatus(),
    checkEmailStatus(),
    loadSyncSettings()
  ]);
}

// Square status
async function checkSquareStatus() {
  const card = document.getElementById('square-connection');
  const status = document.getElementById('square-status');
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    if (data.square === 'connected') {
      card.className = 'connection-card connected';
      status.textContent = 'Connected - API responding';
    } else {
      card.className = 'connection-card disconnected';
      status.textContent = 'Not connected';
    }
  } catch (e) {
    card.className = 'connection-card disconnected';
    status.textContent = 'Error checking status';
  }
}

async function testSquareConnection() {
  const status = document.getElementById('square-status');
  status.textContent = 'Testing...';
  try {
    const response = await fetch('/api/locations');
    const data = await response.json();
    const locations = data.locations || data;
    const count = data.count || locations.length || 0;
    if (count > 0) {
      status.textContent = `Connected - Found ${count} location(s)`;
      document.getElementById('square-connection').className = 'connection-card connected';
    } else {
      status.textContent = 'Connected but no locations found';
    }
  } catch (e) {
    status.textContent = 'Connection failed: ' + e.message;
    document.getElementById('square-connection').className = 'connection-card disconnected';
  }
}

// Database status
async function checkDatabaseStatus() {
  const card = document.getElementById('database-connection');
  const status = document.getElementById('database-status');
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    if (data.database === 'connected') {
      card.className = 'connection-card connected';
      status.textContent = 'Connected';
    } else {
      card.className = 'connection-card disconnected';
      status.textContent = 'Not connected';
    }
  } catch (e) {
    card.className = 'connection-card disconnected';
    status.textContent = 'Error checking status';
  }
}

// Test database connection (for button click)
async function testDatabaseConnection() {
  const status = document.getElementById('database-status');
  status.textContent = 'Testing...';
  await checkDatabaseStatus();
}

// Google status
async function checkGoogleStatus() {
  const card = document.getElementById('google-connection');
  const status = document.getElementById('google-status');
  const actions = document.getElementById('google-actions');
  try {
    const response = await fetch('/api/google/status');
    const data = await response.json();

    if (!data.hasClientCredentials) {
      card.className = 'connection-card warning';
      status.textContent = 'Not configured - Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET';
      actions.innerHTML = '';
    } else if (!data.redirectUriValid) {
      card.className = 'connection-card warning';
      status.textContent = data.redirectUriError || 'Invalid GOOGLE_REDIRECT_URI';
      actions.innerHTML = '';
    } else if (!data.authenticated) {
      card.className = 'connection-card disconnected';
      status.textContent = 'Not connected';
      actions.innerHTML = '<button class="btn-primary" data-action="connectGoogle">Connect</button>';
    } else {
      card.className = 'connection-card connected';
      status.textContent = 'Connected';
      actions.innerHTML = '<button class="btn-danger" data-action="disconnectGoogle">Disconnect</button>';
    }
  } catch (e) {
    card.className = 'connection-card warning';
    status.textContent = 'Error checking status';
  }
}

function connectGoogle() {
  window.location.href = '/api/google/auth';
}

async function disconnectGoogle() {
  if (!confirm('Disconnect from Google?')) return;
  await fetch('/api/google/disconnect', { method: 'POST' });
  checkGoogleStatus();
}

// Email status
async function checkEmailStatus() {
  const card = document.getElementById('email-connection');
  const status = document.getElementById('email-status');
  try {
    const response = await fetch('/api/config');
    const data = await response.json();
    if (data.email_configured) {
      card.className = 'connection-card connected';
      status.textContent = 'Configured';
    } else {
      card.className = 'connection-card warning';
      status.textContent = 'Not configured - Add SMTP settings';
    }
  } catch (e) {
    card.className = 'connection-card warning';
    status.textContent = 'Error checking status';
  }
}

async function testEmailConnection() {
  const status = document.getElementById('email-status');
  status.textContent = 'Sending test email...';
  try {
    const response = await fetch('/api/test-email', { method: 'POST' });
    const data = await response.json();
    if (data.success) {
      status.textContent = 'Test email sent successfully!';
      document.getElementById('email-connection').className = 'connection-card connected';
    } else {
      status.textContent = 'Failed: ' + (data.error || 'Unknown error');
    }
  } catch (e) {
    status.textContent = 'Failed: ' + e.message;
  }
}

// Sync settings (read-only from env)
async function loadSyncSettings() {
  try {
    const response = await fetch('/api/sync-intervals');
    const data = await response.json();

    if (data.intervals) {
      document.getElementById('sync-catalog').textContent = `${data.intervals.catalog || 3} hours`;
      document.getElementById('sync-inventory').textContent = `${data.intervals.inventory || 3} hours`;
      document.getElementById('sync-sales').textContent = `${data.intervals.sales_91d || 3} hours`;
      document.getElementById('sync-gmc').textContent = data.intervals.gmc || 'Not configured';
      document.getElementById('sync-cron').textContent = data.cronSchedule || '0 * * * * (hourly)';
    }
  } catch (e) {
    console.error('Failed to load sync settings:', e);
    document.getElementById('sync-catalog').textContent = 'Error loading';
    document.getElementById('sync-inventory').textContent = 'Error loading';
    document.getElementById('sync-sales').textContent = 'Error loading';
    document.getElementById('sync-gmc').textContent = 'Error loading';
    document.getElementById('sync-cron').textContent = 'Error loading';
  }
}

// Handle OAuth callback
function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('google_connected')) {
    alert('Successfully connected to Google Merchant Center!');
    window.history.replaceState({}, '', window.location.pathname);
    checkGoogleStatus();
  } else if (params.get('google_error')) {
    alert('Google connection failed: ' + params.get('google_error'));
    window.history.replaceState({}, '', window.location.pathname);
  }
}

// Escape strings for use in JavaScript onclick handlers (single-quoted)
function escapeJsString(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

// ==================== SECURITY TAB FUNCTIONS ====================

let currentUser = null;

// Load current user info
async function loadCurrentUser() {
  try {
    const response = await fetch('/api/auth/me');
    if (!response.ok) {
      // Not logged in - redirect to login
      window.location.href = '/login.html?returnUrl=' + encodeURIComponent(window.location.pathname);
      return;
    }
    const data = await response.json();
    currentUser = data.user;

    document.getElementById('current-user-email').textContent = currentUser.email;
    document.getElementById('current-user-role').textContent = `Role: ${currentUser.role}`;

    // Show admin-only sections
    if (currentUser.role === 'admin') {
      document.getElementById('user-management-section').style.display = 'block';
      loadUsersList();

      // Check if super admin (try to access admin-only endpoint)
      checkSuperAdmin();
    }
  } catch (e) {
    console.error('Failed to load user info:', e);
  }
}

// Check if current user is super admin
async function checkSuperAdmin() {
  try {
    // Try to access super-admin endpoint - if it succeeds, show super admin section
    const response = await fetch('/api/subscriptions/admin/plans');
    if (response.ok) {
      document.getElementById('super-admin-section').style.display = 'block';
      document.getElementById('current-user-role').textContent = 'Role: admin (Super Admin)';
    }
  } catch (e) {
    // Not super admin - that's fine
  }
}

// Load users list (admin only)
async function loadUsersList() {
  const container = document.getElementById('users-list');
  try {
    const response = await fetch('/api/auth/users');
    if (!response.ok) {
      container.innerHTML = '<div class="alert error">Failed to load users</div>';
      return;
    }
    const data = await response.json();

    if (!data.users || data.users.length === 0) {
      container.innerHTML = '<div class="alert info">No users found</div>';
      return;
    }

    // LOGIC CHANGE: using shared formatDate/formatDateTime (BACKLOG-26)
    let html = '<div style="display: grid; gap: 10px;">';
    for (const user of data.users) {
      const isActive = user.is_active;
      const isLocked = user.locked_until && new Date(user.locked_until) > new Date();
      const statusClass = !isActive ? 'disconnected' : isLocked ? 'warning' : 'connected';
      const statusText = !isActive ? 'Inactive' : isLocked ? 'Locked' : 'Active';

      html += `
        <div class="connection-card ${statusClass}" style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <div style="font-weight: 600;">${escapeHtml(user.email)}</div>
            <div style="font-size: 13px; color: #6b7280;">
              ${escapeHtml(user.name || 'No name')} &bull; ${escapeHtml(user.role)} &bull; ${escapeHtml(statusText)}
            </div>
${user.last_login ? `<div style="font-size: 12px; color: #9ca3af;">Last login: ${formatDateTime(user.last_login)}</div>` : ''}
          </div>
          <div style="display: flex; gap: 8px;">
            ${isLocked ? `<button class="btn-icon" data-action="unlockUser" data-action-param="${user.id}" title="Unlock">🔓</button>` : ''}
            <button class="btn-icon" data-action="resetUserPassword" data-action-param="${user.id}" data-user-email="${escapeHtml(user.email)}" title="Reset Password">🔑</button>
            ${user.id !== currentUser.id ? `
              <button class="btn-icon" data-action="toggleUserActive" data-action-param="${user.id}" data-is-active="${isActive}" title="${isActive ? 'Deactivate' : 'Activate'}">${isActive ? '🚫' : '✅'}</button>
            ` : ''}
          </div>
        </div>
      `;
    }
    html += '</div>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = '<div class="alert error">Error loading users: ' + escapeHtml(e.message) + '</div>';
  }
}

// Logout
async function logoutUser() {
  if (!confirm('Are you sure you want to logout?')) return;
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login.html';
  } catch (e) {
    alert('Logout failed: ' + e.message);
  }
}

// Change password modal
function showChangePasswordModal() {
  document.getElementById('change-password-modal').style.display = 'flex';
  document.getElementById('current-password').value = '';
  document.getElementById('new-password').value = '';
  document.getElementById('confirm-password').value = '';
}

function hideChangePasswordModal() {
  document.getElementById('change-password-modal').style.display = 'none';
}

async function changePassword() {
  const currentPassword = document.getElementById('current-password').value;
  const newPassword = document.getElementById('new-password').value;
  const confirmPassword = document.getElementById('confirm-password').value;

  if (!currentPassword || !newPassword || !confirmPassword) {
    alert('Please fill in all fields');
    return;
  }

  if (newPassword !== confirmPassword) {
    alert('New passwords do not match');
    return;
  }

  try {
    const response = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const data = await response.json();

    if (response.ok) {
      alert('Password changed successfully!');
      hideChangePasswordModal();
    } else {
      alert('Error: ' + (data.error || 'Failed to change password'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

// Create user modal (admin only)
function showCreateUserModal() {
  document.getElementById('create-user-modal').style.display = 'flex';
  document.getElementById('new-user-email').value = '';
  document.getElementById('new-user-name').value = '';
  document.getElementById('new-user-role').value = 'user';
  document.getElementById('new-user-password').value = '';
}

function hideCreateUserModal() {
  document.getElementById('create-user-modal').style.display = 'none';
}

async function createUser() {
  const email = document.getElementById('new-user-email').value.trim();
  const name = document.getElementById('new-user-name').value.trim();
  const role = document.getElementById('new-user-role').value;
  const password = document.getElementById('new-user-password').value;

  if (!email || !password) {
    alert('Email and password are required');
    return;
  }

  try {
    const response = await fetch('/api/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name, role, password })
    });
    const data = await response.json();

    if (response.ok) {
      alert('User created successfully!');
      hideCreateUserModal();
      loadUsersList();
    } else {
      alert('Error: ' + (data.error || 'Failed to create user'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

// Admin user actions
// Note: These functions support both direct calls (legacy) and event delegation (CSP compliant)
async function unlockUser(paramOrElement, event, param) {
  // Support both: unlockUser(userId) and unlockUser(element, event, param)
  const userId = param || paramOrElement;
  if (!confirm('Unlock this user account?')) return;
  try {
    const response = await fetch(`/api/auth/users/${userId}/unlock`, { method: 'POST' });
    if (response.ok) {
      loadUsersList();
    } else {
      const data = await response.json();
      alert('Error: ' + (data.error || 'Failed to unlock'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function resetUserPassword(elementOrId, eventOrEmail, param) {
  // Support both: resetUserPassword(userId, email) and resetUserPassword(element, event, param)
  let userId, email;
  if (param !== undefined) {
    // Event delegation: (element, event, param)
    userId = param;
    email = elementOrId.dataset.userEmail || 'this user';
  } else {
    // Direct call: (userId, email)
    userId = elementOrId;
    email = eventOrEmail || 'this user';
  }

  const newPassword = prompt(`Enter new password for ${email}:\n(Min 8 chars, 1 uppercase, 1 number)`);
  if (!newPassword) return;

  try {
    const response = await fetch(`/api/auth/users/${userId}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: newPassword })
    });
    const data = await response.json();

    if (response.ok) {
      alert('Password reset successfully!');
    } else {
      alert('Error: ' + (data.error || 'Failed to reset password'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function toggleUserActive(elementOrId, eventOrActive, param) {
  // Support both: toggleUserActive(userId, isActive) and toggleUserActive(element, event, param)
  let userId, isCurrentlyActive;
  if (param !== undefined) {
    // Event delegation: (element, event, param)
    userId = param;
    isCurrentlyActive = elementOrId.dataset.isActive === 'true';
  } else {
    // Direct call: (userId, isActive)
    userId = elementOrId;
    isCurrentlyActive = eventOrActive;
  }

  const action = isCurrentlyActive ? 'deactivate' : 'activate';
  if (!confirm(`Are you sure you want to ${action} this user?`)) return;

  try {
    const response = await fetch(`/api/auth/users/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !isCurrentlyActive })
    });

    if (response.ok) {
      loadUsersList();
    } else {
      const data = await response.json();
      alert('Error: ' + (data.error || 'Failed to update user'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

// ==================== MERCHANT SETTINGS FUNCTIONS ====================

// Load merchant settings from API
async function loadMerchantSettings() {
  try {
    const response = await fetch('/api/settings/merchant');
    if (!response.ok) {
      if (response.status === 400) {
        // No merchant context - hide business rules tab or show message
        console.log('No merchant context for business rules');
        return;
      }
      throw new Error('Failed to load merchant settings');
    }

    const data = await response.json();
    const settings = data.settings;

    // Populate form fields
    const fields = [
      'reorder_safety_days', 'default_supply_days',
      'reorder_priority_urgent_days', 'reorder_priority_high_days',
      'reorder_priority_medium_days', 'reorder_priority_low_days',
      'daily_count_target', 'additional_cycle_count_email', 'notification_email'
    ];

    for (const field of fields) {
      const el = document.getElementById(field);
      if (el && settings[field] !== undefined && settings[field] !== null) {
        el.value = settings[field];
      }
    }

    // Populate checkboxes
    const checkboxFields = ['cycle_count_email_enabled', 'cycle_count_report_email', 'low_stock_alerts_enabled'];
    for (const field of checkboxFields) {
      const el = document.getElementById(field);
      if (el) {
        el.checked = settings[field] === true;
      }
    }

    console.log('Merchant settings loaded', settings);
  } catch (error) {
    console.error('Failed to load merchant settings:', error);
  }
}

// Save merchant settings to API
async function saveMerchantSettings() {
  try {
    const settings = {};

    // Collect numeric fields
    const numericFields = [
      'reorder_safety_days', 'default_supply_days',
      'reorder_priority_urgent_days', 'reorder_priority_high_days',
      'reorder_priority_medium_days', 'reorder_priority_low_days',
      'daily_count_target'
    ];

    for (const field of numericFields) {
      const el = document.getElementById(field);
      if (el) {
        settings[field] = parseInt(el.value) || 0;
      }
    }

    // Collect text fields
    const textFields = ['additional_cycle_count_email', 'notification_email'];
    for (const field of textFields) {
      const el = document.getElementById(field);
      if (el) {
        settings[field] = el.value.trim() || null;
      }
    }

    // Collect checkbox fields
    const checkboxFields = ['cycle_count_email_enabled', 'cycle_count_report_email', 'low_stock_alerts_enabled'];
    for (const field of checkboxFields) {
      const el = document.getElementById(field);
      if (el) {
        settings[field] = el.checked;
      }
    }

    const response = await fetch('/api/settings/merchant', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to save settings');
    }

    alert('Business rules saved successfully!');
    console.log('Merchant settings saved', data.settings);
  } catch (error) {
    alert('Failed to save settings: ' + error.message);
    console.error('Failed to save merchant settings:', error);
  }
}

// Reset merchant settings to defaults
async function resetMerchantSettingsToDefaults() {
  if (!confirm('Are you sure you want to reset all business rules to defaults? This cannot be undone.')) {
    return;
  }

  try {
    const response = await fetch('/api/settings/merchant/defaults');
    if (!response.ok) throw new Error('Failed to load defaults');

    const data = await response.json();
    const defaults = data.defaults;

    // Update form with defaults
    const fields = [
      'reorder_safety_days', 'default_supply_days',
      'reorder_priority_urgent_days', 'reorder_priority_high_days',
      'reorder_priority_medium_days', 'reorder_priority_low_days',
      'daily_count_target'
    ];

    for (const field of fields) {
      const el = document.getElementById(field);
      if (el && defaults[field] !== undefined) {
        el.value = defaults[field];
      }
    }

    // Reset text fields
    document.getElementById('additional_cycle_count_email').value = defaults.additional_cycle_count_email || '';
    document.getElementById('notification_email').value = defaults.notification_email || '';

    // Reset checkboxes
    document.getElementById('cycle_count_email_enabled').checked = defaults.cycle_count_email_enabled !== false;
    document.getElementById('cycle_count_report_email').checked = defaults.cycle_count_report_email !== false;
    document.getElementById('low_stock_alerts_enabled').checked = defaults.low_stock_alerts_enabled !== false;

    // Save the defaults
    await saveMerchantSettings();
  } catch (error) {
    alert('Failed to reset to defaults: ' + error.message);
    console.error('Failed to reset merchant settings:', error);
  }
}

// ==================== SUBSCRIPTION TAB FUNCTIONS ====================

let subscriptionEmail = null;

async function loadSubscriptionStatus() {
  const statusContainer = document.getElementById('subscription-status-content');
  const featuresContainer = document.getElementById('subscription-features-list');
  if (!statusContainer) return;

  try {
    const [statusRes, featuresRes] = await Promise.all([
      fetch('/api/subscriptions/merchant-status'),
      fetch('/api/merchant/features')
    ]);

    if (!statusRes.ok) {
      statusContainer.innerHTML = '<div class="alert warning">No subscription data found. <a href="/subscribe.html">Subscribe now</a> to unlock all features.</div>';
      featuresContainer.innerHTML = '';
      return;
    }

    const statusData = await statusRes.json();
    const featuresData = featuresRes.ok ? await featuresRes.json() : null;

    renderSubscriptionStatus(statusData, statusContainer);
    renderFeaturesList(featuresData, featuresContainer);
  } catch (e) {
    statusContainer.innerHTML = '<div class="alert error">Failed to load subscription details: ' + escapeHtml(e.message) + '</div>';
  }
}

function renderSubscriptionStatus(data, container) {
  const sub = data.subscription || {};
  const billing = data.billing || null;
  const status = sub.status || 'unknown';

  const statusLabels = {
    trial: 'Free Trial',
    active: 'Active',
    cancelled: 'Cancelled',
    expired: 'Expired',
    suspended: 'Suspended',
    platform_owner: 'Platform Owner'
  };
  const statusColors = {
    trial: 'info',
    active: 'success',
    cancelled: 'warning',
    expired: 'error',
    suspended: 'error',
    platform_owner: 'success'
  };

  let html = '<div class="connection-card ' + (statusColors[status] === 'success' ? 'connected' : statusColors[status] === 'error' ? 'disconnected' : 'warning') + '">';
  html += '<div class="connection-header"><span class="connection-icon">💳</span>';
  html += '<span class="connection-name">' + escapeHtml(statusLabels[status] || status) + '</span></div>';

  if (status === 'trial' && sub.trialDaysRemaining !== null) {
    html += '<div class="connection-status">' + escapeHtml(String(sub.trialDaysRemaining)) + ' day' + (sub.trialDaysRemaining !== 1 ? 's' : '') + ' remaining in free trial</div>';
  }

  if (billing) {
    const planName = escapeHtml(billing.plan || 'Standard');
    html += '<div class="connection-status">Plan: ' + planName + '</div>';
    if (billing.nextBillingDate) {
      html += '<div class="connection-status">Next billing: ' + escapeHtml(formatDate(billing.nextBillingDate)) + '</div>';
    }
    if (billing.cardBrand && billing.cardLastFour) {
      html += '<div class="connection-status">Payment: ' + escapeHtml(billing.cardBrand) + ' ending ' + escapeHtml(billing.cardLastFour) + '</div>';
    }
    // Store email for cancel flow (from subscriber record via merchant-status)
  }

  html += '</div>';
  container.innerHTML = html;

  // Show cancel button only for active paid subscriptions
  const mgmtSection = document.getElementById('subscription-management-section');
  if (mgmtSection && billing && billing.plan && status === 'active') {
    mgmtSection.style.display = '';
  }

  // Fetch email for cancel from /api/auth/me (already loaded in currentUser)
  if (currentUser) {
    subscriptionEmail = currentUser.email;
  }
}

function renderFeaturesList(featuresData, container) {
  if (!featuresData || !featuresData.success) {
    container.innerHTML = '<div class="alert info">Feature data unavailable.</div>';
    return;
  }

  const enabled = featuresData.enabled || [];
  const available = featuresData.available || [];

  if (featuresData.is_platform_owner) {
    container.innerHTML = '<div class="alert success">Platform owner — all features enabled.</div>';
    return;
  }

  if (enabled.length === 0) {
    container.innerHTML = '<div class="alert info">No paid features enabled. <a href="/subscribe.html">Subscribe</a> to unlock modules.</div>';
    return;
  }

  let html = '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px;">';
  available.forEach(function (mod) {
    const isEnabled = featuresData.is_platform_owner || mod.enabled;
    html += '<div class="connection-card ' + (isEnabled ? 'connected' : '') + '" style="padding: 12px 16px;">';
    html += '<div style="font-weight: 600; font-size: 14px;">' + escapeHtml(mod.name) + '</div>';
    html += '<div style="font-size: 12px; color: #6b7280;">' + (isEnabled ? 'Enabled' : '$' + (mod.price_cents / 100).toFixed(2) + '/mo') + '</div>';
    html += '</div>';
  });
  html += '</div>';
  container.innerHTML = html;
}

function showCancelSubscriptionModal() {
  const modal = document.getElementById('cancel-subscription-modal');
  if (modal) {
    document.getElementById('cancel-reason').value = '';
    modal.classList.add('active');
  }
}

function hideCancelSubscriptionModal() {
  const modal = document.getElementById('cancel-subscription-modal');
  if (modal) modal.classList.remove('active');
}

async function confirmCancelSubscription() {
  const email = subscriptionEmail || (currentUser && currentUser.email);
  if (!email) {
    showToast('Unable to determine account email. Please refresh.', 'error');
    return;
  }

  const reason = document.getElementById('cancel-reason').value.trim();
  const btn = document.getElementById('confirm-cancel-btn');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/subscriptions/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, reason: reason || 'Cancelled via settings' })
    });
    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Failed to cancel subscription.', 'error');
    } else {
      hideCancelSubscriptionModal();
      showToast('Subscription cancelled. Paid features remain active until end of billing period.', 'success');
      loadSubscriptionStatus();
    }
  } catch (e) {
    showToast('Network error: ' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  // Tab switching — load subscription data when tab activated
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      if (tab.dataset.tab === 'subscription') {
        loadSubscriptionStatus();
      }
    });
  });

  handleOAuthCallback();
  loadAllStatuses();
  loadCurrentUser();
  loadMerchantSettings();
});

// Expose functions to global scope for event delegation
window.testSquareConnection = testSquareConnection;
window.testDatabaseConnection = testDatabaseConnection;
window.testEmailConnection = testEmailConnection;
window.connectGoogle = connectGoogle;
window.disconnectGoogle = disconnectGoogle;
window.resetMerchantSettingsToDefaults = resetMerchantSettingsToDefaults;
window.saveMerchantSettings = saveMerchantSettings;
window.showChangePasswordModal = showChangePasswordModal;
window.hideChangePasswordModal = hideChangePasswordModal;
window.changePassword = changePassword;
window.showCreateUserModal = showCreateUserModal;
window.hideCreateUserModal = hideCreateUserModal;
window.createUser = createUser;
window.unlockUser = unlockUser;
window.resetUserPassword = resetUserPassword;
window.toggleUserActive = toggleUserActive;
window.logoutUser = logoutUser;
window.showCancelSubscriptionModal = showCancelSubscriptionModal;
window.hideCancelSubscriptionModal = hideCancelSubscriptionModal;
window.confirmCancelSubscription = confirmCancelSubscription;
