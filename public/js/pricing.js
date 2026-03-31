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
        const priceDisplay = formatCurrency(m.price_cents / 100);
        return `
        <div class="pricing-card">
            <div class="pricing-card-name">${escapeHtml(m.name)}</div>
            <div class="pricing-card-price">${priceDisplay}<span>/mo</span></div>
            <a href="${escapeHtml(subscribeUrl(m.key))}" class="pricing-card-cta">Get Started</a>
        </div>`;
    }).join('');
}

function renderBundles(bundles) {
    const grid = document.getElementById('bundles-grid');
    if (!grid) return;
    grid.innerHTML = bundles.map(b => {
        const priceDisplay = formatCurrency(b.price_cents / 100);
        const includes = b.includes.join(', ').replace(/_/g, ' ');
        return `
        <div class="pricing-card bundle">
            <div class="pricing-card-name">${escapeHtml(b.name)}</div>
            <div class="pricing-card-price">${priceDisplay}<span>/mo</span></div>
            <div class="pricing-bundle-includes">Includes: ${escapeHtml(includes)}</div>
            <a href="${escapeHtml(subscribeUrl(b.key, true))}" class="pricing-card-cta">Get Bundle</a>
        </div>`;
    }).join('');
}

function subscribeUrl(planKey, isBundle) {
    const base = '/subscribe.html?plan=' + encodeURIComponent(planKey);
    const promoSuffix = appliedPromoCode ? '&promo=' + encodeURIComponent(appliedPromoCode) : '';
    return base + promoSuffix + (isBundle ? '&bundle=1' : '');
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

    result.textContent = 'Checking…';
    result.className = 'pricing-promo-result';

    try {
        const res = await fetch('/api/public/promo/check?code=' + encodeURIComponent(code));
        const data = await res.json();

        if (data.valid) {
            appliedPromoCode = code;
            let msg = `Code applied: ${escapeHtml(data.discountDisplay)}`;
            if (data.durationMonths) {
                msg += ` for ${data.durationMonths} month${data.durationMonths === 1 ? '' : 's'}`;
            }
            if (data.description) {
                msg += ` — ${escapeHtml(data.description)}`;
            }
            result.textContent = msg;
            result.className = 'pricing-promo-result valid';
            // Refresh card links to include promo code
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

    // Support ?promo= in URL to pre-fill code
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
