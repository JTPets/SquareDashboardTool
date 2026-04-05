/**
 * Admin Subscriptions — Core
 * Page init, access check, Square config status, statistics, plan management.
 * Requires: admin-promo.js, admin-subscribers.js, admin-modals.js
 */

'use strict';

document.addEventListener('DOMContentLoaded', async function () {
    await checkAccess();
});

async function checkAccess() {
    try {
        var response = await fetch('/api/subscriptions/admin/plans');
        if (response.status === 403) {
            document.getElementById('access-denied').style.display = 'block';
            document.getElementById('main-content').style.display = 'none';
            return;
        }
        if (!response.ok) throw new Error('Failed to verify access');

        loadConfig();
        loadStats();
        loadPlans();
        loadPromoCodes();
        loadSubscribers();
    } catch (error) {
        console.error('Access check failed:', error);
        document.getElementById('access-denied').style.display = 'block';
        document.getElementById('main-content').style.display = 'none';
    }
}

// ==================== CONFIG ====================

async function loadConfig() {
    var container = document.getElementById('config-status');
    try {
        var response = await fetch('/api/subscriptions/admin/plans');
        var data = await response.json();
        var locationConfigured = data.squareConfigured;

        container.innerHTML =
            '<div class="config-item">' +
            '<span class="config-label">SQUARE_LOCATION_ID</span>' +
            '<span class="config-value ' + (locationConfigured ? 'set' : 'missing') + '">' +
            escapeHtml(locationConfigured ? 'Configured' : 'Not configured') +
            '</span></div>' +
            '<div class="config-item">' +
            '<span class="config-label">SQUARE_ACCESS_TOKEN</span>' +
            '<span class="config-value set">Configured (hidden)</span>' +
            '</div>' +
            '<div class="config-item">' +
            '<span class="config-label">Subscription Billing</span>' +
            '<span class="config-value ' + (locationConfigured ? 'set' : 'missing') + '">' +
            escapeHtml(locationConfigured ? 'Ready' : 'Setup required') +
            '</span></div>';

        if (!locationConfigured) {
            container.innerHTML +=
                '<div class="alert alert-warning alert-spaced">' +
                '<strong>Action Required:</strong> Configure SQUARE_LOCATION_ID to enable subscriptions.' +
                '</div>';
        }
    } catch (error) {
        container.innerHTML = '<div class="alert alert-error">Failed to load configuration: ' +
            escapeHtml(error.message) + '</div>';
    }
}

// ==================== STATS ====================

async function loadStats() {
    var container = document.getElementById('stats-container');
    try {
        var response = await fetch('/api/subscriptions/admin/list');
        if (!response.ok) throw new Error('Failed to load statistics');
        var data = await response.json();
        var stats = data.stats || {};

        container.innerHTML =
            '<div class="stats-grid">' +
            '<div class="stat-card highlight"><div class="stat-value">' +
            escapeHtml(String(stats.total_subscribers || 0)) +
            '</div><div class="stat-label">Total Subscribers</div></div>' +
            '<div class="stat-card"><div class="stat-value">' +
            escapeHtml(String(stats.active_count || 0)) +
            '</div><div class="stat-label">Active</div></div>' +
            '<div class="stat-card"><div class="stat-value">' +
            escapeHtml(String(stats.trial_count || 0)) +
            '</div><div class="stat-label">Trial</div></div>' +
            '<div class="stat-card"><div class="stat-value">' +
            escapeHtml(String(stats.canceled_count || 0)) +
            '</div><div class="stat-label">Canceled</div></div>' +
            '<div class="stat-card"><div class="stat-value">' +
            escapeHtml(String(stats.monthly_count || 0)) +
            '</div><div class="stat-label">Monthly Plans</div></div>' +
            '<div class="stat-card"><div class="stat-value">' +
            escapeHtml(String(stats.annual_count || 0)) +
            '</div><div class="stat-label">Annual Plans</div></div>' +
            '<div class="stat-card highlight"><div class="stat-value">$' +
            escapeHtml(((stats.monthly_revenue_cents || 0) / 100).toFixed(2)) +
            '</div><div class="stat-label">Est. Monthly Revenue</div></div>' +
            '</div>';
    } catch (error) {
        container.innerHTML = '<div class="alert alert-error">Failed to load statistics: ' +
            escapeHtml(error.message) + '</div>';
    }
}

// ==================== PLANS ====================

async function loadPlans() {
    var container = document.getElementById('plans-container');
    try {
        var response = await fetch('/api/subscriptions/admin/plans');
        if (!response.ok) throw new Error('Failed to load plans');
        var data = await response.json();
        var plans = data.plans || [];

        if (plans.length === 0) {
            container.innerHTML = '<div class="empty-state"><h3>No Plans Configured</h3>' +
                '<p>No subscription plans found in the database.</p></div>';
            return;
        }

        var hasUnconfiguredPlans = false;
        var html = '<table><thead><tr><th>Plan</th><th>Price</th><th>Billing</th>' +
            '<th>Square Status</th><th>Active</th></tr></thead><tbody>';

        plans.forEach(function (plan) {
            var hasSquarePlan = !!plan.square_plan_id;
            if (!hasSquarePlan) hasUnconfiguredPlans = true;
            html +=
                '<tr><td><strong>' + escapeHtml(plan.name) + '</strong><br>' +
                '<small class="text-muted">' + escapeHtml(plan.plan_key) + '</small></td>' +
                '<td>$' + (plan.price_cents / 100).toFixed(2) + '</td>' +
                '<td>' + escapeHtml(plan.billing_frequency) + '</td>' +
                '<td>' + (hasSquarePlan
                    ? '<span class="badge badge-success">Configured</span>'
                    : '<span class="badge badge-warning">Not in Square</span>') + '</td>' +
                '<td>' + (plan.is_active
                    ? '<span class="badge badge-success">Active</span>'
                    : '<span class="badge badge-gray">Inactive</span>') + '</td></tr>';
        });

        html += '</tbody></table>';

        if (hasUnconfiguredPlans) {
            html += '<div class="alert alert-warning alert-spaced">' +
                '<strong>Action Required:</strong> Some plans are not configured in Square. ' +
                'Click "Setup Plans in Square" to create them.</div>';
        } else {
            html += '<div class="alert alert-success alert-spaced">' +
                'All plans are configured in Square and ready for billing.</div>';
            document.getElementById('setup-btn').textContent = 'Re-sync Plans';
        }

        container.innerHTML = html;
    } catch (error) {
        container.innerHTML = '<div class="alert alert-error">Failed to load plans: ' +
            escapeHtml(error.message) + '</div>';
    }
}

async function setupPlans() {
    var btn = document.getElementById('setup-btn');
    var originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Setting up...';
    try {
        var response = await fetch('/api/subscriptions/admin/setup-plans', { method: 'POST' });
        var data = await response.json();
        if (!response.ok) throw new Error(data.error || data.message || 'Setup failed');

        var message = 'Setup completed!\n\nPlans created: ' + (data.plans ? data.plans.length : 0);
        if (data.errors && data.errors.length > 0) {
            message += '\nErrors: ' + data.errors.length;
            data.errors.forEach(function (err) {
                message += '\n- ' + err.planKey + ': ' + err.error;
            });
        }
        alert(message);
        loadPlans();
    } catch (error) {
        alert('Failed to setup plans: ' + error.message);
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

// ==================== EXPOSE TO EVENT DELEGATION ====================

window.loadStats = loadStats;
window.setupPlans = setupPlans;
