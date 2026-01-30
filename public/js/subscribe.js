/**
 * Subscribe page JavaScript
 * Externalized from subscribe.html for CSP compliance (P0-4 Phase 2)
 * Note: Square Web Payments SDK is loaded dynamically based on environment
 */

// Set year in footer
document.getElementById('year').textContent = new Date().getFullYear();

// State
let selectedPlan = null;
let card = null;
let payments = null;

// Promo code state
let appliedPromo = null;

// Plan data
const plans = {
  monthly: {
    name: 'Monthly Plan (Intro)',
    price: 999,
    displayPrice: '$9.99',
    period: '/month'
  },
  annual: {
    name: 'Annual Plan (Intro)',
    price: 9999,
    displayPrice: '$99.99',
    period: '/year'
  }
};

// Terms modal functions
function openTermsModal() {
  document.getElementById('terms-modal').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeTermsModal() {
  document.getElementById('terms-modal').classList.remove('active');
  document.body.style.overflow = '';
}

function acceptTerms() {
  document.getElementById('terms-accepted').checked = true;
  closeTermsModal();
}

// Apply promo code
async function applyPromoCode() {
  const codeInput = document.getElementById('promo-code');
  const messageEl = document.getElementById('promo-message');
  const code = codeInput.value.trim();

  if (!code) {
    messageEl.className = 'promo-message error';
    messageEl.textContent = 'Please enter a promo code';
    messageEl.style.display = 'block';
    return;
  }

  if (!selectedPlan) {
    messageEl.className = 'promo-message error';
    messageEl.textContent = 'Please select a plan first';
    messageEl.style.display = 'block';
    return;
  }

  try {
    const response = await fetch('/api/subscriptions/promo/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        plan: selectedPlan,
        priceCents: plans[selectedPlan].price
      })
    });

    const result = await response.json();

    if (result.valid) {
      appliedPromo = result;
      messageEl.className = 'promo-message success';
      messageEl.textContent = `\u2713 ${result.discountDisplay} applied!`;
      messageEl.style.display = 'block';
      codeInput.disabled = true;

      // Update order summary with discount
      updateOrderSummary();
    } else {
      appliedPromo = null;
      messageEl.className = 'promo-message error';
      messageEl.textContent = result.error || 'Invalid promo code';
      messageEl.style.display = 'block';
      updateOrderSummary();
    }
  } catch (error) {
    console.error('Promo validation error:', error);
    messageEl.className = 'promo-message error';
    messageEl.textContent = 'Failed to validate code. Please try again.';
    messageEl.style.display = 'block';
  }
}

// Update order summary with discount
function updateOrderSummary() {
  if (!selectedPlan) return;

  const plan = plans[selectedPlan];
  const discountRow = document.getElementById('discount-row');
  const discountLabel = document.getElementById('discount-label');
  const discountAmount = document.getElementById('discount-amount');
  const totalPrice = document.getElementById('total-price');

  if (appliedPromo && appliedPromo.discountCents > 0) {
    discountRow.style.display = 'flex';
    discountLabel.textContent = `Discount (${appliedPromo.code})`;
    discountAmount.textContent = `-$${(appliedPromo.discountCents / 100).toFixed(2)}`;

    const finalPrice = (plan.price - appliedPromo.discountCents) / 100;
    totalPrice.textContent = finalPrice > 0 ? `$${finalPrice.toFixed(2)} CAD` : 'FREE';
  } else {
    discountRow.style.display = 'none';
    totalPrice.textContent = plan.displayPrice + ' CAD';
  }
}

// Clear promo when changing plans
function clearPromo() {
  appliedPromo = null;
  const codeInput = document.getElementById('promo-code');
  const messageEl = document.getElementById('promo-message');
  codeInput.value = '';
  codeInput.disabled = false;
  messageEl.style.display = 'none';
  document.getElementById('discount-row').style.display = 'none';
}

// Load Square SDK dynamically based on environment
function loadSquareSDK(environment) {
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

// Initialize Square Payments
async function initializeSquare() {
  try {
    // Fetch application ID, location ID, and environment from server
    const config = await fetch('/api/square/payment-config').then(r => r.json());

    if (!config.applicationId) {
      console.error('Square application ID not configured');
      return;
    }

    // Load the correct SDK for the environment
    await loadSquareSDK(config.environment);
    console.log(`Loaded Square SDK for ${config.environment} environment`);

    payments = Square.payments(config.applicationId, config.locationId);

    // Create card payment method
    card = await payments.card();
    await card.attach('#card-container');

    console.log('Square Payments initialized');
  } catch (error) {
    console.error('Failed to initialize Square Payments:', error);
    showMessage('error', 'Payment system unavailable. Please try again later.');
  }
}

// Select plan
function selectPlan(element, event, planKey) {
  // Support both direct call and event delegation
  if (typeof element === 'string') {
    planKey = element;
  }

  selectedPlan = planKey;
  const plan = plans[planKey];

  // Clear any applied promo when changing plans
  clearPromo();

  // Update button states
  document.querySelectorAll('.select-btn').forEach(btn => {
    btn.classList.remove('selected');
    btn.textContent = btn.textContent.replace('Selected', 'Select');
  });

  const selectedCard = document.getElementById(`card-${planKey}`);
  const btn = selectedCard.querySelector('.select-btn');
  btn.classList.add('selected');
  btn.textContent = 'Selected';

  // Update order summary
  document.getElementById('plan-name').textContent = plan.name;
  document.getElementById('plan-price').textContent = plan.displayPrice;
  document.getElementById('total-price').textContent = plan.displayPrice + ' CAD';

  // Show checkout section
  document.getElementById('checkout-section').classList.add('active');

  // Scroll to checkout
  document.getElementById('checkout-section').scrollIntoView({ behavior: 'smooth' });

  // Initialize Square if not already done
  if (!payments) {
    initializeSquare();
  }
}

// Show message
function showMessage(type, text) {
  const msg = document.getElementById('message');
  msg.className = `message ${type}`;
  msg.textContent = text;
  msg.scrollIntoView({ behavior: 'smooth' });
}

// Handle subscription
// Note: For event delegation, global functions receive (element, event, param)
// event.preventDefault() is already called by the event delegation system for data-submit
async function handleSubscribe(element, event, param) {
  if (!selectedPlan) {
    showMessage('error', 'Please select a plan first.');
    return;
  }

  if (!card) {
    showMessage('error', 'Payment system not ready. Please refresh and try again.');
    return;
  }

  const email = document.getElementById('email').value.trim();
  const business = document.getElementById('business').value.trim();

  if (!email) {
    showMessage('error', 'Please enter your email address.');
    return;
  }

  // Validate terms acceptance
  const termsAccepted = document.getElementById('terms-accepted').checked;
  if (!termsAccepted) {
    showMessage('error', 'Please accept the Terms of Service to continue.');
    return;
  }

  // Disable button and show loading
  const btn = document.getElementById('subscribe-btn');
  const btnText = document.getElementById('btn-text');
  const spinner = document.getElementById('spinner');

  btn.disabled = true;
  btnText.textContent = 'Processing...';
  spinner.style.display = 'block';

  try {
    // Tokenize the card
    const result = await card.tokenize();

    if (result.status !== 'OK') {
      throw new Error(result.errors?.[0]?.message || 'Card tokenization failed');
    }

    // Submit to server
    const response = await fetch('/api/subscriptions/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        businessName: business,
        plan: selectedPlan,
        sourceId: result.token,
        promoCode: appliedPromo?.code || null,
        termsAcceptedAt: new Date().toISOString()
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Subscription creation failed');
    }

    // Success! Check if we need to set up a password
    if (data.passwordSetupUrl) {
      showMessage('success', 'Account created! Redirecting to set up your password...');
      setTimeout(() => {
        window.location.href = data.passwordSetupUrl + '&new=true';
      }, 2000);
    } else {
      showMessage('success', 'Subscription created successfully! Redirecting to login...');
      setTimeout(() => {
        window.location.href = '/login.html?subscribed=true';
      }, 2000);
    }

  } catch (error) {
    console.error('Subscription error:', error);
    showMessage('error', error.message || 'An error occurred. Please try again.');

    btn.disabled = false;
    btnText.textContent = 'Start Free Trial';
    spinner.style.display = 'none';
  }
}

// Initialize event listeners
document.addEventListener('DOMContentLoaded', () => {
  // Close modal on overlay click
  document.getElementById('terms-modal').addEventListener('click', function(e) {
    if (e.target === this) closeTermsModal();
  });

  // Close modal on escape key
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeTermsModal();
  });
});

// Expose functions to global scope for event delegation
window.selectPlan = selectPlan;
window.applyPromoCode = applyPromoCode;
window.openTermsModal = openTermsModal;
window.closeTermsModal = closeTermsModal;
window.acceptTerms = acceptTerms;
window.handleSubscribe = handleSubscribe;
