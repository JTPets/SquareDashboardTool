/**
 * Admin Subscriptions Page Script
 * Handles subscription management for super admin users.
 *
 * Sections:
 *   - Access check
 *   - Square config status
 *   - Subscription statistics
 *   - Subscription plans
 *   - Promo code creation form + list
 *   - Subscriber list with search / filter / pagination
 *   - Billing history modal (click a subscriber row)
 */

'use strict';

// ==================== STATE ====================

var subscribersPage = 0;
var subscribersLimit = 10;
var subscribersTotal = 0;
var searchDebounceTimer = null;

// ==================== INIT ====================

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
                '<div class="alert alert-warning" style="margin-top:15px;margin-bottom:0;">' +
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
                '<small style="color:#6b7280;">' + escapeHtml(plan.plan_key) + '</small></td>' +
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
            html += '<div class="alert alert-warning" style="margin-top:15px;">' +
                '<strong>Action Required:</strong> Some plans are not configured in Square. ' +
                'Click "Setup Plans in Square" to create them.</div>';
        } else {
            html += '<div class="alert alert-success" style="margin-top:15px;">' +
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

// ==================== PROMO CODES ====================

function onPromoTypeChange() {
    var type = document.getElementById('promo-discount-type').value;
    var label = document.getElementById('promo-value-label');
    var input = document.getElementById('promo-value');
    if (type === 'percent') {
        label.innerHTML = 'Value (%) <span style="color:#dc2626">*</span>';
        input.placeholder = 'e.g. 20';
        input.max = 100;
    } else if (type === 'fixed') {
        label.innerHTML = 'Amount off (cents) <span style="color:#dc2626">*</span>';
        input.placeholder = 'e.g. 500 = $5.00 off';
        input.removeAttribute('max');
    } else {
        label.innerHTML = 'Fixed monthly price (cents) <span style="color:#dc2626">*</span>';
        input.placeholder = 'e.g. 99 = $0.99/mo';
        input.removeAttribute('max');
    }
}

async function createPromoCode() {
    var code = document.getElementById('promo-code').value.trim().toUpperCase();
    var discountType = document.getElementById('promo-discount-type').value;
    var valueRaw = document.getElementById('promo-value').value.trim();
    var duration = document.getElementById('promo-duration').value.trim();
    var maxUses = document.getElementById('promo-max-uses').value.trim();
    var notes = document.getElementById('promo-notes').value.trim();

    if (!code) { showToast('Code is required.', 'error'); return; }
    if (!valueRaw) { showToast('Value is required.', 'error'); return; }

    var payload = { code: code, discount_type: discountType };
    if (notes) payload.description = notes;

    if (discountType === 'fixed_price') {
        payload.fixed_price_cents = parseInt(valueRaw, 10);
    } else {
        payload.discount_value = Number(valueRaw);
    }
    if (duration) payload.duration_months = parseInt(duration, 10);
    if (maxUses) payload.max_uses = parseInt(maxUses, 10);

    try {
        var response = await fetch('/api/admin/promo-codes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        var data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to create promo code');

        showToast('Promo code ' + escapeHtml(data.promo.code) + ' created.', 'success');
        document.getElementById('promo-code').value = '';
        document.getElementById('promo-value').value = '';
        document.getElementById('promo-duration').value = '';
        document.getElementById('promo-max-uses').value = '';
        document.getElementById('promo-notes').value = '';
        loadPromoCodes();
    } catch (error) {
        showToast('Error: ' + error.message, 'error');
    }
}

async function loadPromoCodes() {
    var container = document.getElementById('promo-list-container');
    try {
        var response = await fetch('/api/admin/promo-codes');
        if (!response.ok) {
            var errData = await response.json().catch(function () { return {}; });
            throw new Error(errData.error || 'Failed to load promo codes');
        }
        var data = await response.json();
        var codes = data.promoCodes || [];

        if (codes.length === 0) {
            container.innerHTML = '<div class="empty-state"><h3>No Promo Codes</h3>' +
                '<p>Create a promo code using the form above.</p></div>';
            return;
        }

        var html =
            '<table><thead><tr>' +
            '<th>Code</th><th>Type</th><th>Value</th><th>Duration</th>' +
            '<th>Uses</th><th>Status</th><th>Created</th><th>Notes</th><th></th>' +
            '</tr></thead><tbody>';

        codes.forEach(function (promo) {
            var valueDisplay;
            if (promo.discount_type === 'percent') {
                valueDisplay = escapeHtml(String(promo.discount_value)) + '%';
            } else if (promo.discount_type === 'fixed') {
                valueDisplay = '$' + (promo.discount_value / 100).toFixed(2) + ' off';
            } else {
                valueDisplay = '$' + ((promo.fixed_price_cents || 0) / 100).toFixed(2) + '/mo';
            }

            var usesDisplay = escapeHtml(String(promo.times_used || 0));
            if (promo.max_uses) usesDisplay += ' / ' + escapeHtml(String(promo.max_uses));

            var duration = promo.duration_months
                ? escapeHtml(String(promo.duration_months)) + ' mo'
                : 'Unlimited';

            var statusBadge = promo.is_active
                ? '<span class="badge badge-success">Active</span>'
                : '<span class="badge badge-gray">Inactive</span>';

            var deactivateBtn = promo.is_active
                ? '<button class="btn btn-danger btn-sm" data-action="deactivatePromoCode"' +
                  ' data-action-param="' + escapeAttr(String(promo.id)) + '">Deactivate</button>'
                : '';

            html +=
                '<tr>' +
                '<td><code>' + escapeHtml(promo.code) + '</code></td>' +
                '<td>' + escapeHtml(promo.discount_type) + '</td>' +
                '<td>' + valueDisplay + '</td>' +
                '<td>' + duration + '</td>' +
                '<td>' + usesDisplay + '</td>' +
                '<td>' + statusBadge + '</td>' +
                '<td>' + formatDate(promo.created_at) + '</td>' +
                '<td style="max-width:200px;font-size:12px;color:#6b7280;">' +
                escapeHtml(promo.description || '') + '</td>' +
                '<td>' + deactivateBtn + '</td>' +
                '</tr>';
        });

        html += '</tbody></table>';
        container.innerHTML = html;
    } catch (error) {
        container.innerHTML = '<div class="alert alert-error">Failed to load promo codes: ' +
            escapeHtml(error.message) + '</div>';
    }
}

async function deactivatePromoCode(element, event, promoId) {
    if (!confirm('Deactivate this promo code? Existing subscribers will not be affected.')) return;
    try {
        var response = await fetch(
            '/api/admin/promo-codes/' + encodeURIComponent(promoId) + '/deactivate',
            { method: 'POST' }
        );
        var data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to deactivate');
        showToast('Promo code deactivated.', 'success');
        loadPromoCodes();
    } catch (error) {
        showToast('Error: ' + error.message, 'error');
    }
}

// ==================== SUBSCRIBERS ====================

function reloadSubscribers() {
    subscribersPage = 0;
    loadSubscribers();
}

function onSubscriberSearch() {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(function () {
        subscribersPage = 0;
        loadSubscribers();
    }, 350);
}

function onSubscriberFilterChange() {
    subscribersPage = 0;
    loadSubscribers();
}

function prevPage() {
    if (subscribersPage > 0) {
        subscribersPage--;
        loadSubscribers();
    }
}

function nextPage() {
    var maxPage = Math.ceil(subscribersTotal / subscribersLimit) - 1;
    if (subscribersPage < maxPage) {
        subscribersPage++;
        loadSubscribers();
    }
}

async function loadSubscribers() {
    var container = document.getElementById('subscribers-container');
    var pagination = document.getElementById('subscribers-pagination');
    var search = document.getElementById('subscriber-search').value.trim();
    var status = document.getElementById('subscriber-status-filter').value;

    var params = new URLSearchParams({
        limit: String(subscribersLimit),
        offset: String(subscribersPage * subscribersLimit)
    });
    if (search) params.set('search', search);
    if (status) params.set('status', status);

    try {
        var response = await fetch('/api/subscriptions/admin/list?' + params.toString());
        if (!response.ok) throw new Error('Failed to load subscribers');
        var data = await response.json();
        var subscribers = data.subscribers || [];
        subscribersTotal = data.total || 0;

        if (subscribers.length === 0) {
            container.innerHTML = '<div class="empty-state"><h3>No Subscribers Found</h3>' +
                '<p>Try adjusting your search or filter.</p></div>';
            pagination.style.display = 'none';
            return;
        }

        var html =
            '<table><thead><tr>' +
            '<th>Email / Business</th><th>Plan</th><th>Status</th>' +
            '<th>Square Sub</th><th>Created</th><th></th>' +
            '</tr></thead><tbody>';

        subscribers.forEach(function (sub) {
            var statusClass = ({
                active: 'badge-success', trial: 'badge-info',
                canceled: 'badge-gray', expired: 'badge-error', past_due: 'badge-warning'
            })[sub.subscription_status] || 'badge-gray';

            html +=
                '<tr class="subscriber-row-clickable" data-action="showBillingModal"' +
                ' data-merchant-id="' + escapeAttr(String(sub.merchant_id || '')) + '"' +
                ' data-email="' + escapeAttr(sub.email) + '"' +
                ' data-business="' + escapeAttr(sub.business_name || '') + '">' +
                '<td><div class="subscriber-email">' + escapeHtml(sub.email) + '</div>' +
                (sub.business_name
                    ? '<div class="subscriber-business">' + escapeHtml(sub.business_name) + '</div>'
                    : '') +
                '</td>' +
                '<td>' + escapeHtml(sub.subscription_plan || '—') + '</td>' +
                '<td><span class="badge ' + escapeAttr(statusClass) + '">' +
                escapeHtml(sub.subscription_status) + '</span></td>' +
                '<td>' + (sub.square_subscription_id
                    ? '<span class="badge badge-success">Linked</span>'
                    : '<span class="badge badge-gray">None</span>') + '</td>' +
                '<td>' + formatDate(sub.created_at) + '</td>' +
                '<td style="font-size:12px;color:#6b7280;">View billing &#x2192;</td>' +
                '</tr>';
        });

        html += '</tbody></table>';
        container.innerHTML = html;

        // Update pagination
        var offset = subscribersPage * subscribersLimit;
        var from = offset + 1;
        var to = Math.min(offset + subscribers.length, subscribersTotal);
        document.getElementById('pagination-info').textContent =
            'Showing ' + from + '\u2013' + to + ' of ' + subscribersTotal;
        document.getElementById('prev-page-btn').disabled = subscribersPage === 0;
        document.getElementById('next-page-btn').disabled = to >= subscribersTotal;
        pagination.style.display = '';
    } catch (error) {
        container.innerHTML = '<div class="alert alert-error">Failed to load subscribers: ' +
            escapeHtml(error.message) + '</div>';
        pagination.style.display = 'none';
    }
}

// ==================== BILLING HISTORY ====================

async function showBillingModal(rowElement) {
    var merchantId = rowElement.dataset.merchantId;
    var email = rowElement.dataset.email;
    var business = rowElement.dataset.business;

    var modal = document.getElementById('billing-modal');
    var infoEl = document.getElementById('billing-merchant-info');
    var contentEl = document.getElementById('billing-content');

    infoEl.textContent = email + (business ? ' \u2014 ' + business : '');
    contentEl.innerHTML = '<div class="loading"><div class="spinner"></div>' +
        '<p>Loading payment history...</p></div>';
    modal.classList.add('active');

    if (!merchantId) {
        contentEl.innerHTML = '<div class="alert alert-warning">No merchant ID linked to this subscriber.</div>';
        return;
    }

    try {
        var response = await fetch(
            '/api/admin/merchants/' + encodeURIComponent(merchantId) + '/payments'
        );
        if (!response.ok) {
            var errData = await response.json().catch(function () { return {}; });
            throw new Error(errData.error || 'Failed to load payments');
        }
        var data = await response.json();
        var payments = data.payments || [];

        if (payments.length === 0) {
            contentEl.innerHTML = '<div class="empty-state" style="padding:20px;">' +
                '<p>No payment records found.</p></div>';
            return;
        }

        var html =
            '<table><thead><tr>' +
            '<th>Date</th><th>Amount</th><th>Status</th><th>Plan</th><th>Period</th>' +
            '</tr></thead><tbody>';

        payments.forEach(function (p) {
            var isRefunded = p.status === 'refunded' || !!p.refunded_at;
            var rowStyle = isRefunded ? ' style="color:#9ca3af;text-decoration:line-through;"' : '';
            var amountDisplay = '$' + (p.amount_cents / 100).toFixed(2) +
                ' ' + escapeHtml(p.currency || 'CAD');
            if (isRefunded && p.refund_amount_cents) {
                amountDisplay += ' (refunded $' + (p.refund_amount_cents / 100).toFixed(2) + ')';
            }
            var period = '';
            if (p.billing_period_start && p.billing_period_end) {
                period = formatDate(p.billing_period_start) + ' \u2013 ' +
                    formatDate(p.billing_period_end);
            }
            var badgeClass = isRefunded ? 'badge-gray'
                : p.status === 'completed' ? 'badge-success' : 'badge-error';

            html +=
                '<tr' + rowStyle + '>' +
                '<td>' + formatDate(p.created_at) + '</td>' +
                '<td>' + amountDisplay + '</td>' +
                '<td><span class="badge ' + escapeAttr(badgeClass) + '">' +
                escapeHtml(p.status) + '</span></td>' +
                '<td>' + escapeHtml(p.subscription_plan || '\u2014') + '</td>' +
                '<td style="font-size:12px;color:#6b7280;">' + escapeHtml(period) + '</td>' +
                '</tr>';
        });

        html += '</tbody></table>';
        if (data.total > payments.length) {
            html += '<p style="font-size:12px;color:#6b7280;margin-top:8px;">Showing ' +
                payments.length + ' of ' + data.total + ' payments.</p>';
        }
        contentEl.innerHTML = html;
    } catch (error) {
        contentEl.innerHTML = '<div class="alert alert-error">Failed to load payments: ' +
            escapeHtml(error.message) + '</div>';
    }
}

function hideBillingModal() {
    document.getElementById('billing-modal').classList.remove('active');
}

// ==================== EXPOSE TO EVENT DELEGATION ====================

window.loadStats = loadStats;
window.setupPlans = setupPlans;
window.onPromoTypeChange = onPromoTypeChange;
window.createPromoCode = createPromoCode;
window.deactivatePromoCode = deactivatePromoCode;
window.reloadSubscribers = reloadSubscribers;
window.onSubscriberSearch = onSubscriberSearch;
window.onSubscriberFilterChange = onSubscriberFilterChange;
window.prevPage = prevPage;
window.nextPage = nextPage;
window.showBillingModal = showBillingModal;
window.hideBillingModal = hideBillingModal;
