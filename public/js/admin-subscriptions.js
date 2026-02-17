/**
 * Admin Subscriptions Page Script
 * Handles subscription management for super admin users
 */

// Initialize on page load
document.addEventListener('DOMContentLoaded', async function() {
  await checkAccess();
});

/**
 * Check if user has super admin access
 */
async function checkAccess() {
  try {
    // Try to load admin plans - this will fail if not super admin
    const response = await fetch('/api/subscriptions/admin/plans');
    if (response.status === 403) {
      document.getElementById('access-denied').style.display = 'block';
      document.getElementById('main-content').style.display = 'none';
      return;
    }
    if (!response.ok) {
      throw new Error('Failed to verify access');
    }

    // Access granted - load all data
    loadConfig();
    loadStats();
    loadPlans();
    loadSubscribers();
  } catch (error) {
    console.error('Access check failed:', error);
    document.getElementById('access-denied').style.display = 'block';
    document.getElementById('main-content').style.display = 'none';
  }
}

/**
 * Load Square configuration status
 */
async function loadConfig() {
  const container = document.getElementById('config-status');
  try {
    const response = await fetch('/api/subscriptions/admin/plans');
    const data = await response.json();

    const locationConfigured = data.squareConfigured;

    container.innerHTML = `
      <div class="config-item">
        <span class="config-label">SQUARE_LOCATION_ID</span>
        <span class="config-value ${locationConfigured ? 'set' : 'missing'}">
          ${locationConfigured ? 'Configured' : 'Not configured'}
        </span>
      </div>
      <div class="config-item">
        <span class="config-label">SQUARE_ACCESS_TOKEN</span>
        <span class="config-value set">Configured (hidden)</span>
      </div>
      <div class="config-item">
        <span class="config-label">Subscription Billing</span>
        <span class="config-value ${locationConfigured ? 'set' : 'missing'}">
          ${locationConfigured ? 'Ready' : 'Setup required'}
        </span>
      </div>
    `;

    if (!locationConfigured) {
      container.innerHTML += `
        <div class="alert alert-warning" style="margin-top: 15px; margin-bottom: 0;">
          <strong>Action Required:</strong> Configure SQUARE_LOCATION_ID in your environment to enable subscriptions.
        </div>
      `;
    }
  } catch (error) {
    container.innerHTML = `
      <div class="alert alert-error">Failed to load configuration: ${escapeHtml(error.message)}</div>
    `;
  }
}

/**
 * Load subscription statistics
 */
async function loadStats() {
  const container = document.getElementById('stats-container');
  try {
    const response = await fetch('/api/subscriptions/admin/list');
    if (!response.ok) throw new Error('Failed to load statistics');

    const data = await response.json();
    const stats = data.stats || {};

    container.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card highlight">
          <div class="stat-value">${stats.total_subscribers || 0}</div>
          <div class="stat-label">Total Subscribers</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${stats.active_count || 0}</div>
          <div class="stat-label">Active</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${stats.trial_count || 0}</div>
          <div class="stat-label">Trial</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${stats.canceled_count || 0}</div>
          <div class="stat-label">Canceled</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${stats.monthly_count || 0}</div>
          <div class="stat-label">Monthly Plans</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${stats.annual_count || 0}</div>
          <div class="stat-label">Annual Plans</div>
        </div>
        <div class="stat-card highlight">
          <div class="stat-value">$${((stats.monthly_revenue_cents || 0) / 100).toFixed(2)}</div>
          <div class="stat-label">Est. Monthly Revenue</div>
        </div>
      </div>
    `;
  } catch (error) {
    container.innerHTML = `
      <div class="alert alert-error">Failed to load statistics: ${escapeHtml(error.message)}</div>
    `;
  }
}

/**
 * Load subscription plans from Square
 */
async function loadPlans() {
  const container = document.getElementById('plans-container');
  try {
    const response = await fetch('/api/subscriptions/admin/plans');
    if (!response.ok) throw new Error('Failed to load plans');

    const data = await response.json();
    const plans = data.plans || [];

    if (plans.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <h3>No Plans Configured</h3>
          <p>No subscription plans found in the database.</p>
        </div>
      `;
      return;
    }

    let hasUnconfiguredPlans = false;

    let html = `
      <table>
        <thead>
          <tr>
            <th>Plan</th>
            <th>Price</th>
            <th>Billing</th>
            <th>Square Status</th>
            <th>Active</th>
          </tr>
        </thead>
        <tbody>
    `;

    for (const plan of plans) {
      const hasSquarePlan = !!plan.square_plan_id;
      if (!hasSquarePlan) hasUnconfiguredPlans = true;

      html += `
        <tr>
          <td>
            <strong>${escapeHtml(plan.name)}</strong>
            <br><small style="color: #6b7280;">${escapeHtml(plan.plan_key)}</small>
          </td>
          <td>$${(plan.price_cents / 100).toFixed(2)}</td>
          <td>${plan.billing_frequency}</td>
          <td>
            ${hasSquarePlan
              ? `<span class="badge badge-success">Configured</span>`
              : `<span class="badge badge-warning">Not in Square</span>`}
          </td>
          <td>
            ${plan.is_active
              ? `<span class="badge badge-success">Active</span>`
              : `<span class="badge badge-gray">Inactive</span>`}
          </td>
        </tr>
      `;
    }

    html += '</tbody></table>';

    if (hasUnconfiguredPlans) {
      html += `
        <div class="alert alert-warning" style="margin-top: 15px;">
          <strong>Action Required:</strong> Some plans are not configured in Square.
          Click "Setup Plans in Square" to create them.
        </div>
      `;
    } else {
      html += `
        <div class="alert alert-success" style="margin-top: 15px;">
          All plans are configured in Square and ready for billing.
        </div>
      `;
      document.getElementById('setup-btn').textContent = 'Re-sync Plans';
    }

    container.innerHTML = html;
  } catch (error) {
    container.innerHTML = `
      <div class="alert alert-error">Failed to load plans: ${escapeHtml(error.message)}</div>
    `;
  }
}

/**
 * Load recent subscribers
 */
async function loadSubscribers() {
  const container = document.getElementById('subscribers-container');
  try {
    const response = await fetch('/api/subscriptions/admin/list');
    if (!response.ok) throw new Error('Failed to load subscribers');

    const data = await response.json();
    const subscribers = (data.subscribers || []).slice(0, 20); // Show last 20

    if (subscribers.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <h3>No Subscribers Yet</h3>
          <p>Subscribers will appear here once users sign up.</p>
        </div>
      `;
      return;
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Plan</th>
            <th>Status</th>
            <th>Square Sub</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
    `;

    for (const sub of subscribers) {
      const statusClass = {
        'active': 'badge-success',
        'trial': 'badge-info',
        'canceled': 'badge-gray',
        'expired': 'badge-error',
        'past_due': 'badge-warning'
      }[sub.subscription_status] || 'badge-gray';

      html += `
        <tr>
          <td>
            <div class="subscriber-email">${escapeHtml(sub.email)}</div>
            ${sub.business_name ? `<div class="subscriber-business">${escapeHtml(sub.business_name)}</div>` : ''}
          </td>
          <td>${escapeHtml(sub.subscription_plan || '-')}</td>
          <td><span class="badge ${statusClass}">${sub.subscription_status}</span></td>
          <td>
            ${sub.square_subscription_id
              ? `<span class="badge badge-success">Linked</span>`
              : `<span class="badge badge-gray">None</span>`}
          </td>
          <td>${formatDate(sub.created_at)}</td>
        </tr>
      `;
    }

    html += '</tbody></table>';
    container.innerHTML = html;
  } catch (error) {
    container.innerHTML = `
      <div class="alert alert-error">Failed to load subscribers: ${escapeHtml(error.message)}</div>
    `;
  }
}

/**
 * Setup subscription plans in Square
 */
async function setupPlans() {
  const btn = document.getElementById('setup-btn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Setting up...';

  try {
    const response = await fetch('/api/subscriptions/admin/setup-plans', {
      method: 'POST'
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || data.message || 'Setup failed');
    }

    // Show results
    let message = `Setup completed!\n\nPlans created: ${data.plans?.length || 0}`;
    if (data.errors?.length > 0) {
      message += `\nErrors: ${data.errors.length}`;
      for (const err of data.errors) {
        message += `\n- ${err.planKey}: ${err.error}`;
      }
    }
    alert(message);

    // Reload plans
    loadPlans();

  } catch (error) {
    alert('Failed to setup plans: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

/**
 * Format date string for display
 * @param {string} dateStr - ISO date string
 * @returns {string} Formatted date
 */
function formatDate(dateStr) {
  if (!dateStr) return '-';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  } catch {
    return '-';
  }
}

// Expose functions to global scope for event delegation
window.loadStats = loadStats;
window.setupPlans = setupPlans;
