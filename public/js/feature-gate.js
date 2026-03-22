'use strict';

/**
 * Feature Gate — Client-side nav gating
 *
 * Fetches enabled features and greys out locked tool cards on the dashboard.
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
        })
        .catch(function () {
            // Silent fail — progressive enhancement
        });
})();
