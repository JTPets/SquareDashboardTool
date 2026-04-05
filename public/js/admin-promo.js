/**
 * Admin Promo Codes
 * Promo code creation form, list, and deactivation.
 */

'use strict';

function onPromoTypeChange() {
    var type = document.getElementById('promo-discount-type').value;
    var label = document.getElementById('promo-value-label');
    var input = document.getElementById('promo-value');
    if (type === 'percent') {
        label.innerHTML = 'Value (%) <span class="text-required">*</span>';
        input.placeholder = 'e.g. 20';
        input.max = 100;
    } else if (type === 'fixed') {
        label.innerHTML = 'Amount off (cents) <span class="text-required">*</span>';
        input.placeholder = 'e.g. 500 = $5.00 off';
        input.removeAttribute('max');
    } else {
        label.innerHTML = 'Fixed monthly price (cents) <span class="text-required">*</span>';
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
                '<td class="td-notes">' + escapeHtml(promo.description || '') + '</td>' +
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

window.onPromoTypeChange = onPromoTypeChange;
window.createPromoCode = createPromoCode;
window.deactivatePromoCode = deactivatePromoCode;
