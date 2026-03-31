/* global escapeHtml, formatCurrency */
'use strict';

let appliedPromoCode = null;

async function loadPricing() {
    const res = await fetch('/api/public/pricing');
    const data = await res.json();
    if (!data.success) return;

    renderModules(data.modules);
    renderBundles(data.bundles);
}

function renderModules(modules) {
    const grid = document.getElementById('modules-grid');
    if (!grid) return;
    grid.innerHTML = modules.map(m => {
        // formatCurrency takes cents
        const priceDisplay = formatCurrency(m.price_cents);
        return `
        <div class="pricing-card">
            <div class="pricing-card-name">${escapeHtml(m.name)}</div>
            <div class="pricing-card-price">${priceDisplay}<span>/mo</span></div>
            <a href="${escapeHtml(subscribeUrl())}" class="pricing-card-cta">Get Started</a>
        </div>`;
    }).join('');
}

function renderBundles(bundles) {
    const grid = document.getElementById('bundles-grid');
    if (!grid) return;
    grid.innerHTML = bundles.map(b => {
        // formatCurrency takes cents
        const priceDisplay = formatCurrency(b.price_cents);
        const includes = b.includes.join(', ').replace(/_/g, ' ');
        return `
        <div class="pricing-card bundle">
            <div class="pricing-card-name">${escapeHtml(b.name)}</div>
            <div class="pricing-card-price">${priceDisplay}<span>/mo</span></div>
            <div class="pricing-bundle-includes">Includes: ${escapeHtml(includes)}</div>
            <a href="${escapeHtml(subscribeUrl())}" class="pricing-card-cta">Get Bundle</a>
        </div>`;
    }).join('');
}

/**
 * Build the subscribe.html URL, optionally including the applied promo code.
 * subscribe.html handles plan selection internally — we don't pass a plan key
 * because module keys (e.g. 'cycle_counts') are not valid plan keys there.
 */
function subscribeUrl() {
    if (appliedPromoCode) {
        return '/subscribe.html?promo=' + encodeURIComponent(appliedPromoCode);
    }
    return '/subscribe.html';
}

async function checkPromo() {
    const input = document.getElementById('promo-input');
    const result = document.getElementById('promo-result');
    const code = input.value.trim().toUpperCase();

    if (!code) {
        result.textContent = 'Please enter a promo code.';
        result.className = 'pricing-promo-result invalid';
        return;
    }

    result.textContent = 'Checking\u2026';
    result.className = 'pricing-promo-result';

    try {
        const res = await fetch('/api/public/promo/check?code=' + encodeURIComponent(code));
        const data = await res.json();

        if (data.valid) {
            appliedPromoCode = code;
            let msg = 'Code applied: ' + escapeHtml(data.discountDisplay);
            if (data.durationMonths) {
                msg += ' for ' + data.durationMonths + ' month' + (data.durationMonths === 1 ? '' : 's');
            }
            if (data.description) {
                msg += ' \u2014 ' + escapeHtml(data.description);
            }
            result.textContent = msg;
            result.className = 'pricing-promo-result valid';
            // Refresh card links to carry the promo code to subscribe.html
            loadPricing();
        } else {
            appliedPromoCode = null;
            result.textContent = 'Invalid or expired promo code.';
            result.className = 'pricing-promo-result invalid';
        }
    } catch {
        result.textContent = 'Could not check promo code. Please try again.';
        result.className = 'pricing-promo-result invalid';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    loadPricing();

    // Support ?promo= in URL to pre-fill and auto-check the code
    const params = new URLSearchParams(window.location.search);
    const prefilledCode = params.get('promo');
    if (prefilledCode) {
        const input = document.getElementById('promo-input');
        if (input) {
            input.value = prefilledCode.toUpperCase();
            checkPromo();
        }
    }

    const btn = document.getElementById('promo-check-btn');
    if (btn) btn.addEventListener('click', checkPromo);

    const input = document.getElementById('promo-input');
    if (input) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') checkPromo();
        });
    }
});
