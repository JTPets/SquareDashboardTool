/**
 * Upgrade page JavaScript
 * Handles merchant-aware subscription upgrade flow.
 * Uses session-based merchant_id — no email form needed.
 */

let selectedPlan = null;
let card = null;
let payments = null;
let merchantStatus = null;

function showMessage(type, text) {
    const msg = document.getElementById('message');
    msg.className = 'message ' + type;
    msg.textContent = text;
}

function clearMessage() {
    const msg = document.getElementById('message');
    msg.className = 'message';
    msg.style.display = 'none';
}

async function loadSquareSDK(environment) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = environment === 'production'
            ? 'https://web.squarecdn.com/v1/square.js'
            : 'https://sandbox.web.squarecdn.com/v1/square.js';
        script.onload = resolve;
        script.onerror = () => reject(new Error('Failed to load Square SDK'));
        document.head.appendChild(script);
    });
}

async function initializeSquare() {
    try {
        const config = await fetch('/api/square/payment-config').then(r => r.json());
        if (!config.applicationId) {
            showMessage('error', 'Payment system not configured. Please contact support.');
            return;
        }
        await loadSquareSDK(config.environment);
        payments = Square.payments(config.applicationId, config.locationId);
        card = await payments.card();
        await card.attach('#card-container');
    } catch (error) {
        console.error('Failed to initialize Square Payments:', error);
        showMessage('error', 'Payment system unavailable. Please try again later.');
    }
}

function renderPlans(plans) {
    const container = document.getElementById('plans-container');
    container.innerHTML = '';

    plans.forEach(plan => {
        const el = document.createElement('div');
        el.className = 'plan-card';
        el.dataset.planKey = plan.plan_key;

        const priceDisplay = (plan.price_cents / 100).toFixed(2);
        const period = plan.billing_frequency === 'ANNUAL' ? '/year' : '/month';

        el.innerHTML =
            '<h3>' + escapeHtml(plan.name) + '</h3>' +
            '<div class="price">$' + priceDisplay + '<span>' + period + '</span></div>' +
            (plan.description ? '<div class="desc">' + escapeHtml(plan.description) + '</div>' : '');

        el.addEventListener('click', () => selectPlan(plan.plan_key, el));
        container.appendChild(el);
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function selectPlan(planKey, element) {
    selectedPlan = planKey;
    document.querySelectorAll('.plan-card').forEach(c => c.classList.remove('selected'));
    element.classList.add('selected');

    const btn = document.getElementById('upgrade-btn');
    btn.disabled = false;
    document.getElementById('btn-text').textContent = 'Subscribe Now';
}

async function handleUpgrade() {
    if (!selectedPlan || !card) return;

    const btn = document.getElementById('upgrade-btn');
    const btnText = document.getElementById('btn-text');
    const spinner = document.getElementById('spinner');

    btn.disabled = true;
    btnText.textContent = 'Processing...';
    spinner.style.display = 'block';
    clearMessage();

    try {
        const result = await card.tokenize();
        if (result.status !== 'OK') {
            throw new Error(result.errors?.[0]?.message || 'Card tokenization failed');
        }

        const response = await fetch('/api/subscriptions/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: merchantStatus.billing?.email || merchantStatus.subscription?.email || '',
                businessName: merchantStatus.businessName || '',
                plan: selectedPlan,
                sourceId: result.token,
                termsAcceptedAt: new Date().toISOString()
            })
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'Subscription creation failed');
        }

        showMessage('success', 'Subscription activated! Redirecting to dashboard...');
        setTimeout(() => { window.location.href = '/dashboard.html'; }, 2000);

    } catch (error) {
        console.error('Upgrade error:', error);
        showMessage('error', error.message || 'An error occurred. Please try again.');
        btn.disabled = false;
        btnText.textContent = 'Subscribe Now';
        spinner.style.display = 'none';
    }
}

async function loadMerchantStatus() {
    try {
        const response = await fetch('/api/subscriptions/merchant-status');

        if (response.status === 401 || response.status === 403) {
            window.location.href = '/login.html?redirect=/upgrade.html';
            return;
        }

        if (!response.ok) {
            throw new Error('Failed to load subscription status');
        }

        merchantStatus = await response.json();
        document.getElementById('loading').style.display = 'none';

        const sub = merchantStatus.subscription;
        document.getElementById('business-name').textContent = merchantStatus.businessName || '';

        if (sub.status === 'active' || sub.status === 'platform_owner') {
            // Show active subscription info
            document.getElementById('active-content').style.display = 'block';

            if (sub.status === 'platform_owner') {
                document.getElementById('active-status-banner').className = 'status-banner platform_owner';
                document.getElementById('active-status-banner').textContent = 'Platform Owner — no subscription required.';
            }

            if (merchantStatus.billing) {
                document.getElementById('current-plan').textContent = merchantStatus.billing.plan || '-';
                if (merchantStatus.billing.cardBrand && merchantStatus.billing.cardLastFour) {
                    document.getElementById('current-card').textContent =
                        merchantStatus.billing.cardBrand + ' ending in ' + merchantStatus.billing.cardLastFour;
                }
                if (merchantStatus.billing.nextBillingDate) {
                    document.getElementById('next-billing').textContent =
                        new Date(merchantStatus.billing.nextBillingDate).toLocaleDateString();
                }
            }
        } else {
            // Show upgrade form
            document.getElementById('upgrade-content').style.display = 'block';

            const banner = document.getElementById('status-banner');
            if (sub.status === 'trial' && sub.trialDaysRemaining > 0) {
                banner.className = 'status-banner trial';
                banner.textContent = 'Trial: ' + sub.trialDaysRemaining + ' days remaining. Subscribe to continue after your trial.';
            } else {
                banner.className = 'status-banner expired';
                banner.textContent = 'Your trial has ended. Subscribe to continue using SqTools.';
            }

            renderPlans(merchantStatus.plans || []);
            initializeSquare();
        }

    } catch (error) {
        console.error('Failed to load status:', error);
        document.getElementById('loading').style.display = 'none';
        showMessage('error', 'Failed to load subscription status. Please refresh the page.');
    }
}

// Wire up upgrade button
document.getElementById('upgrade-btn').addEventListener('click', handleUpgrade);

// Load on page init
document.addEventListener('DOMContentLoaded', loadMerchantStatus);
