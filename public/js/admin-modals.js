/**
 * Admin Modals
 * Billing history, feature overrides, extend-trial, and manual activation modals.
 */

'use strict';

// Pending action state shared across modal handlers
var pendingMerchantId = null;
var pendingMerchantLabel = '';

// ==================== BILLING HISTORY ====================

async function showBillingModal(element, event, merchantId) {
    var email = element.dataset.email || '';
    var business = element.dataset.business || '';

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
            contentEl.innerHTML = '<div class="empty-state"><p>No payment records found.</p></div>';
            return;
        }

        var html =
            '<table><thead><tr>' +
            '<th>Date</th><th>Amount</th><th>Status</th><th>Plan</th><th>Period</th>' +
            '</tr></thead><tbody>';

        payments.forEach(function (p) {
            var isRefunded = p.status === 'refunded' || !!p.refunded_at;
            var rowClass = isRefunded ? ' class="row-refunded"' : '';
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
                '<tr' + rowClass + '>' +
                '<td>' + formatDate(p.created_at) + '</td>' +
                '<td>' + amountDisplay + '</td>' +
                '<td><span class="badge ' + escapeAttr(badgeClass) + '">' +
                escapeHtml(p.status) + '</span></td>' +
                '<td>' + escapeHtml(p.subscription_plan || '\u2014') + '</td>' +
                '<td class="td-period">' + escapeHtml(period) + '</td>' +
                '</tr>';
        });

        html += '</tbody></table>';
        if (data.total > payments.length) {
            html += '<p class="td-meta">Showing ' +
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

// ==================== FEATURES MODAL ====================

async function showFeaturesModal(element, event, merchantId) {
    var email = element.dataset.email || '';
    pendingMerchantId = merchantId;
    pendingMerchantLabel = email || ('Merchant #' + merchantId);

    var modal = document.getElementById('features-modal');
    var infoEl = document.getElementById('features-merchant-info');
    var contentEl = document.getElementById('features-content');

    infoEl.textContent = pendingMerchantLabel;
    contentEl.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading features...</p></div>';
    modal.classList.add('active');

    try {
        var response = await fetch('/api/admin/merchants/' + encodeURIComponent(merchantId) + '/features');
        if (!response.ok) {
            var errData = await response.json().catch(function () { return {}; });
            throw new Error(errData.error || 'Failed to load features');
        }
        var data = await response.json();
        var features = data.features || [];

        var html = '<table><thead><tr><th>Module</th><th>Price</th><th>Source</th><th>Enabled</th></tr></thead><tbody>';

        features.forEach(function (f) {
            var sourceLabel = f.source === 'admin_override'
                ? '<span class="badge badge-admin-override">admin_override</span>'
                : f.source === 'subscription'
                    ? '<span class="badge badge-success">subscription</span>'
                    : '<span class="badge badge-gray">none</span>';

            var toggleChecked = f.enabled ? 'checked' : '';
            var toggleId = 'toggle-' + escapeAttr(f.feature_key);

            html +=
                '<tr>' +
                '<td><strong>' + escapeHtml(f.name) + '</strong><br>' +
                '<small class="feature-key-text">' + escapeHtml(f.feature_key) + '</small></td>' +
                '<td>$' + (f.price_cents / 100).toFixed(2) + '</td>' +
                '<td>' + sourceLabel + '</td>' +
                '<td><label class="feature-toggle-label">' +
                '<input type="checkbox" id="' + toggleId + '" ' + toggleChecked +
                ' data-action="toggleFeature"' +
                ' data-action-param="' + escapeAttr(merchantId + ':' + f.feature_key) + '">' +
                (f.enabled ? 'On' : 'Off') +
                '</label></td>' +
                '</tr>';
        });

        html += '</tbody></table>';
        contentEl.innerHTML = html;
    } catch (error) {
        contentEl.innerHTML = '<div class="alert alert-error">Failed to load features: ' +
            escapeHtml(error.message) + '</div>';
    }
}

function hideFeaturesModal() {
    document.getElementById('features-modal').classList.remove('active');
    pendingMerchantId = null;
}

async function toggleFeature(element, event, param) {
    var parts = (param || '').split(':');
    var merchantId = parts[0];
    var featureKey = parts.slice(1).join(':');
    var enabled = element.checked;

    var label = element.parentElement;
    if (label) label.textContent = 'Saving\u2026';

    if (!confirm((enabled ? 'Enable' : 'Disable') + ' ' + featureKey + ' for this merchant?')) {
        element.checked = !enabled;
        if (label) label.innerHTML =
            '<input type="checkbox" id="toggle-' + escapeAttr(featureKey) + '" ' +
            (!enabled ? 'checked' : '') +
            ' data-action="toggleFeature"' +
            ' data-action-param="' + escapeAttr(param) + '">' +
            (!enabled ? 'On' : 'Off');
        return;
    }

    try {
        var response = await fetch(
            '/api/admin/merchants/' + encodeURIComponent(merchantId) +
            '/features/' + encodeURIComponent(featureKey),
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: enabled })
            }
        );
        var data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to update feature');

        showToast(featureKey + ' ' + (enabled ? 'enabled' : 'disabled') + '.', 'success');
        showFeaturesModal({ dataset: { email: pendingMerchantLabel } }, null, merchantId);
    } catch (error) {
        showToast('Error: ' + error.message, 'error');
        element.checked = !enabled;
    }
}

// ==================== EXTEND TRIAL MODAL ====================

function showExtendTrialModal(element, event, merchantId) {
    var email = element.dataset.email || '';
    pendingMerchantId = merchantId;
    pendingMerchantLabel = email || ('Merchant #' + merchantId);

    document.getElementById('extend-trial-merchant-info').textContent = pendingMerchantLabel;
    document.getElementById('extend-trial-days').value = '14';
    document.getElementById('extend-trial-modal').classList.add('active');
}

function hideExtendTrialModal() {
    document.getElementById('extend-trial-modal').classList.remove('active');
    pendingMerchantId = null;
}

async function confirmExtendTrial() {
    var days = parseInt(document.getElementById('extend-trial-days').value, 10);
    if (!days || days < 1 || days > 3650) {
        showToast('Enter a valid number of days (1\u20133650).', 'error');
        return;
    }
    var merchantId = pendingMerchantId;
    if (!merchantId) return;

    try {
        var response = await fetch(
            '/api/admin/merchants/' + encodeURIComponent(merchantId) + '/extend-trial',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ days: days })
            }
        );
        var data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to extend trial');

        showToast('Trial extended by ' + days + ' day(s).', 'success');
        hideExtendTrialModal();
        loadSubscribers();
    } catch (error) {
        showToast('Error: ' + error.message, 'error');
    }
}

// ==================== ACTIVATE MODAL ====================

function showActivateModal(element, event, merchantId) {
    var email = element.dataset.email || '';
    pendingMerchantId = merchantId;
    pendingMerchantLabel = email || ('Merchant #' + merchantId);

    document.getElementById('activate-merchant-info').textContent = pendingMerchantLabel;
    document.getElementById('activate-modal').classList.add('active');
}

function hideActivateModal() {
    document.getElementById('activate-modal').classList.remove('active');
    pendingMerchantId = null;
}

async function confirmActivate() {
    var merchantId = pendingMerchantId;
    if (!merchantId) return;

    try {
        var response = await fetch(
            '/api/admin/merchants/' + encodeURIComponent(merchantId) + '/activate',
            { method: 'POST' }
        );
        var data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to activate merchant');

        showToast(
            'Merchant activated \u2014 ' + (data.modulesGranted || 0) + ' modules granted.',
            'success'
        );
        hideActivateModal();
        loadSubscribers();
    } catch (error) {
        showToast('Error: ' + error.message, 'error');
    }
}

window.showBillingModal = showBillingModal;
window.hideBillingModal = hideBillingModal;
window.showFeaturesModal = showFeaturesModal;
window.hideFeaturesModal = hideFeaturesModal;
window.toggleFeature = toggleFeature;
window.showExtendTrialModal = showExtendTrialModal;
window.hideExtendTrialModal = hideExtendTrialModal;
window.confirmExtendTrial = confirmExtendTrial;
window.showActivateModal = showActivateModal;
window.hideActivateModal = hideActivateModal;
window.confirmActivate = confirmActivate;
