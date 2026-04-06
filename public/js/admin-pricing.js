/**
 * Admin Pricing — Pricing section of admin-subscriptions page.
 * Reads/writes prices via /api/admin/pricing (GET, PUT).
 * Loaded after admin-subscriptions.js.
 */
'use strict';

async function loadPricing() {
    var modContainer = document.getElementById('module-pricing-container');
    var planContainer = document.getElementById('plan-pricing-container');
    try {
        var response = await fetch('/api/admin/pricing');
        if (!response.ok) throw new Error('Failed to load pricing');
        var data = await response.json();
        renderModulePricing(data.modules || [], modContainer);
        renderPlanPricing(data.plans || [], planContainer);
    } catch (error) {
        var msg = '<div class="alert alert-error">Price unavailable: ' + escapeHtml(error.message) + '</div>';
        modContainer.innerHTML = msg;
        planContainer.innerHTML = msg;
    }
}

function renderModulePricing(modules, container) {
    if (modules.length === 0) {
        container.innerHTML = '<p class="text-muted">No modules found.</p>';
        return;
    }
    var html = '<table><thead><tr><th>Module</th><th>Current Price</th><th>Default</th><th>Edit</th></tr></thead><tbody>';
    modules.forEach(function (m) {
        html += '<tr>' +
            '<td><strong>' + escapeHtml(m.name) + '</strong><br><small class="text-muted">' + escapeHtml(m.key) + '</small></td>' +
            '<td>$' + (m.price_cents / 100).toFixed(2) + '/mo</td>' +
            '<td class="text-muted">$' + (m.default_price_cents / 100).toFixed(2) + '</td>' +
            '<td><div style="display:flex;gap:6px;align-items:center;">' +
            '<input type="number" min="0" step="1" value="' + escapeAttr(String(m.price_cents)) + '" ' +
            'id="mod-price-' + escapeAttr(m.key) + '" style="width:90px;">' +
            '<button class="btn btn-sm btn-secondary" ' +
            'data-action="saveModulePrice" data-key="' + escapeAttr(m.key) + '">Save</button>' +
            '</div></td>' +
            '</tr>';
    });
    html += '</tbody></table><p class="text-muted" style="margin-top:8px;font-size:12px;">Prices in cents (999 = $9.99). Changes take effect immediately.</p>';
    container.innerHTML = html;
}

function renderPlanPricing(plans, container) {
    if (plans.length === 0) {
        container.innerHTML = '<p class="text-muted">No plans found.</p>';
        return;
    }
    var html = '<table><thead><tr><th>Plan</th><th>Current Price</th><th>Billing</th><th>Edit</th></tr></thead><tbody>';
    plans.forEach(function (p) {
        html += '<tr>' +
            '<td><strong>' + escapeHtml(p.name) + '</strong><br><small class="text-muted">' + escapeHtml(p.plan_key) + '</small></td>' +
            '<td>$' + (p.price_cents / 100).toFixed(2) + '</td>' +
            '<td>' + escapeHtml(p.billing_frequency) + '</td>' +
            '<td><div style="display:flex;gap:6px;align-items:center;">' +
            '<input type="number" min="0" step="1" value="' + escapeAttr(String(p.price_cents)) + '" ' +
            'id="plan-price-' + escapeAttr(p.plan_key) + '" style="width:90px;">' +
            '<button class="btn btn-sm btn-secondary" ' +
            'data-action="savePlanPrice" data-key="' + escapeAttr(p.plan_key) + '">Save</button>' +
            '</div></td>' +
            '</tr>';
    });
    html += '</tbody></table>';
    container.innerHTML = html;
}

// Called via event delegation — reads key from element.dataset.key.
async function saveModulePrice(element) {
    var key = element && element.dataset && element.dataset.key;
    if (!key) return;
    var input = document.getElementById('mod-price-' + key);
    if (!input) return;
    var priceCents = parseInt(input.value, 10);
    if (isNaN(priceCents) || priceCents < 0) {
        alert('Price must be a non-negative integer (cents).');
        return;
    }
    try {
        var res = await fetch('/api/admin/pricing/modules/' + encodeURIComponent(key), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ price_cents: priceCents })
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Save failed');
        loadPricing();
    } catch (error) {
        alert('Failed to save module price: ' + error.message);
    }
}

// Called via event delegation — reads key from element.dataset.key.
async function savePlanPrice(element) {
    var key = element && element.dataset && element.dataset.key;
    if (!key) return;
    var input = document.getElementById('plan-price-' + key);
    if (!input) return;
    var priceCents = parseInt(input.value, 10);
    if (isNaN(priceCents) || priceCents < 0) {
        alert('Price must be a non-negative integer (cents).');
        return;
    }
    try {
        var res = await fetch('/api/admin/pricing/plans/' + encodeURIComponent(key), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ price_cents: priceCents })
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Save failed');
        loadPricing();
    } catch (error) {
        alert('Failed to save plan price: ' + error.message);
    }
}

window.loadPricing = loadPricing;
window.saveModulePrice = saveModulePrice;
window.savePlanPrice = savePlanPrice;
