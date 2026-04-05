'use strict';

/**
 * Feature Gate — Client-side nav gating + trial countdown
 *
 * Fetches enabled features and greys out locked tool cards on the dashboard.
 * Also shows a trial countdown banner:
 *   - On any page: if trial has < 3 days remaining, injects a warning banner
 *   - On dashboard (#trial-banner exists): shows banner for all trial states
 * Progressive enhancement — if the fetch fails, all cards remain visible.
 * Platform owners see everything unlocked.
 */
(function () {
    fetch('/api/merchant/features')
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (!data.success) return;
            if (data.is_platform_owner) return;

            var enabled = data.enabled || [];
            var available = data.available || [];
            var cards = document.querySelectorAll('[data-feature]');

            cards.forEach(function (card) {
                var featureKey = card.getAttribute('data-feature');
                if (enabled.indexOf(featureKey) === -1) {
                    card.classList.add('feature-locked');

                    // Find pricing info
                    var mod = available.find(function (m) { return m.key === featureKey; });
                    var priceText = mod ? '$' + (mod.price_cents / 100).toFixed(2) + '/mo' : '';

                    // Add lock badge
                    var badge = document.createElement('a');
                    badge.className = 'feature-lock-badge';
                    badge.href = '/upgrade.html?feature=' + encodeURIComponent(featureKey);
                    badge.innerHTML = '&#x1F512; Upgrade' + (priceText ? ' ' + priceText : '');
                    card.appendChild(badge);
                }
            });

            // Trial countdown banner
            var status = data.subscription_status;
            var daysLeft = data.trial_days_remaining;

            if (status === 'trial') {
                var existingBanner = document.getElementById('trial-banner');
                if (existingBanner) {
                    // Dashboard: always show trial banner
                    showTrialBanner(existingBanner, daysLeft);
                } else if (daysLeft !== null && daysLeft <= 3) {
                    // Other pages: inject banner only when < 3 days remain
                    injectTrialBanner(daysLeft);
                }
            }
        })
        .catch(function () {
            // Silent fail — progressive enhancement
        });

    function showTrialBanner(banner, daysLeft) {
        var textEl = document.getElementById('trial-banner-text');
        var msg = daysLeft !== null
            ? 'Free trial: ' + daysLeft + ' day' + (daysLeft !== 1 ? 's' : '') + ' remaining \u2014'
            : 'You are on a free trial \u2014';
        if (textEl) textEl.textContent = msg;
        banner.style.display = '';
        if (daysLeft !== null && daysLeft <= 3) {
            banner.classList.add('trial-banner-urgent');
        }
    }

    function injectTrialBanner(daysLeft) {
        var banner = document.createElement('div');
        banner.id = 'trial-injected-banner';
        banner.className = 'trial-banner alert warning trial-banner-urgent trial-banner-injected';
        var days = daysLeft + ' day' + (daysLeft !== 1 ? 's' : '');
        banner.innerHTML =
            '<span>Free trial: ' + days + ' remaining \u2014</span>' +
            '<a href="/subscribe.html" class="btn-primary btn-sm">Subscribe Now</a>';

        var container = document.querySelector('.container') || document.body;
        var header = container.querySelector('.header');
        if (header && header.nextSibling) {
            container.insertBefore(banner, header.nextSibling);
        } else {
            container.insertBefore(banner, container.firstChild);
        }
    }
})();
