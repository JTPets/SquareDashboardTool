/* global escapeHtml, formatCurrency */
'use strict';

let appliedPromoCode = null;
let currentBillingCycle = 'monthly'; // 'monthly' | 'annual'
let pricingData = null;

async function loadPricing() {
    const res = await fetch('/api/public/pricing');
    const data = await res.json();
    if (!data.success) return;

    pricingData = data;
    renderFullAccessCard(data.modules, data.plans);
    renderModuleGrid(data.modules);
}

function getSelectedPlan(plans) {
    return plans.find(p => p.key === currentBillingCycle) || plans[0];
}

function renderFullAccessCard(modules, plans) {
    const card = document.getElementById('full-access-card');
    if (!card) return;

    const monthly = plans.find(p => p.key === 'monthly');
    const annual  = plans.find(p => p.key === 'annual');
    const selected = getSelectedPlan(plans);

    const moduleListHtml = modules.map(m => `
        <li>
            <span>${escapeHtml(m.name)}</span>
            <span class="pricing-module-desc">— ${escapeHtml(m.description || '')}</span>
        </li>`).join('');

    const savingsHtml = (monthly && annual && currentBillingCycle === 'annual')
        ? `<div class="price-savings">Save $${Math.round((monthly.price_cents * 12 - annual.price_cents) / 100)}/yr</div>`
        : '';

    const period = currentBillingCycle === 'annual' ? '/year' : '/month';

    card.innerHTML = `
        <div class="pricing-full-access-features">
            <h2>Everything you need to run your store</h2>
            <p>All modules included. Unlimited inventory items. Multi-location support.</p>
            <ul class="pricing-module-list">${moduleListHtml}</ul>
        </div>
        <div class="pricing-full-access-cta">
            ${monthly && annual ? `
            <div class="pricing-plan-toggle">
                <button data-cycle="monthly" class="${currentBillingCycle === 'monthly' ? 'active' : ''}">Monthly</button>
                <button data-cycle="annual"  class="${currentBillingCycle === 'annual'  ? 'active' : ''}">Annual</button>
            </div>` : ''}
            <div class="pricing-price-display">
                <div class="price-amount">${formatCurrency(selected.price_cents)}</div>
                <div class="price-period">${escapeHtml(period)}</div>
                ${savingsHtml}
            </div>
            <a href="${escapeHtml(subscribeUrl())}" class="pricing-cta-btn">Subscribe for Full Access</a>
            <div class="pricing-cta-note">14-day free trial &mdash; no credit card required</div>
            <div class="pricing-promo" style="width:100%;box-sizing:border-box;margin:0;">
                <div style="font-size:0.85rem;font-weight:600;color:#374151;margin-bottom:8px;">Have a promo code?</div>
                <div class="pricing-promo-row">
                    <input id="promo-input" class="pricing-promo-input" type="text"
                           placeholder="e.g. BETA99" maxlength="50" autocomplete="off" spellcheck="false">
                    <button id="promo-check-btn" class="pricing-promo-btn">Apply</button>
                </div>
                <div id="promo-result" class="pricing-promo-result"></div>
            </div>
        </div>`;

    // Rebind toggle buttons and promo after re-render
    card.querySelectorAll('.pricing-plan-toggle button').forEach(btn => {
        btn.addEventListener('click', () => {
            currentBillingCycle = btn.dataset.cycle;
            renderFullAccessCard(modules, plans);
        });
    });

    const promoBtn = card.querySelector('#promo-check-btn');
    if (promoBtn) promoBtn.addEventListener('click', checkPromo);

    const promoInput = card.querySelector('#promo-input');
    if (promoInput) {
        // Restore previously entered code
        if (appliedPromoCode) promoInput.value = appliedPromoCode;
        promoInput.addEventListener('keydown', e => { if (e.key === 'Enter') checkPromo(); });
    }
}

function renderModuleGrid(modules) {
    const grid = document.getElementById('modules-grid');
    if (!grid) return;
    grid.innerHTML = modules.map(m => `
        <div class="pricing-card muted">
            <div class="pricing-card-name">${escapeHtml(m.name)}</div>
            <div class="pricing-card-price">${formatCurrency(m.price_cents)}<span>/mo</span></div>
            <div class="pricing-card-desc">${escapeHtml(m.description || '')}</div>
            <span class="pricing-badge-soon">Coming Soon</span>
        </div>`).join('');
}

function subscribeUrl() {
    if (appliedPromoCode) {
        return '/subscribe.html?promo=' + encodeURIComponent(appliedPromoCode);
    }
    return '/subscribe.html';
}

async function checkPromo() {
    const input  = document.getElementById('promo-input');
    const result = document.getElementById('promo-result');
    if (!input || !result) return;

    const code = input.value.trim().toUpperCase();
    if (!code) {
        result.textContent = 'Please enter a promo code.';
        result.className = 'pricing-promo-result invalid';
        return;
    }

    result.textContent = 'Checking\u2026';
    result.className = 'pricing-promo-result';

    try {
        const res  = await fetch('/api/public/promo/check?code=' + encodeURIComponent(code));
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
            // Refresh CTA link to carry the promo code to subscribe.html
            if (pricingData) renderFullAccessCard(pricingData.modules, pricingData.plans);
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
        appliedPromoCode = prefilledCode.toUpperCase();
        // Input is rendered async; checkPromo is called after render via the input pre-fill path
        loadPricing().then(() => {
            const input = document.getElementById('promo-input');
            if (input) {
                input.value = appliedPromoCode;
                checkPromo();
            }
        });
    }
});
