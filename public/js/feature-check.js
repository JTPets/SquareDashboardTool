'use strict';

/**
 * Feature Check — Page-level gate
 *
 * Include this script on gated pages with a data-feature-key attribute on the script tag.
 * If the merchant doesn't have the feature, shows an upgrade prompt overlay.
 * Platform owners always pass. Fails open (if fetch fails, page loads normally).
 *
 * Usage:
 *   <script src="/js/feature-check.js" data-feature-key="cycle_counts"></script>
 */
(function () {
    var scripts = document.getElementsByTagName('script');
    var currentScript = scripts[scripts.length - 1];
    var featureKey = currentScript.getAttribute('data-feature-key');
    if (!featureKey) return;

    fetch('/api/merchant/features')
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (!data.success) return;
            if (data.is_platform_owner) return;

            var enabled = data.enabled || [];
            if (enabled.indexOf(featureKey) !== -1) return;

            // Find module info
            var available = data.available || [];
            var mod = available.find(function (m) { return m.key === featureKey; });
            var moduleName = mod ? mod.name : featureKey;
            var priceText = mod ? '$' + (mod.price_cents / 100).toFixed(2) + '/mo' : '';

            // Build overlay
            var overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(255,255,255,0.95);z-index:10000;display:flex;align-items:center;justify-content:center;';

            var card = document.createElement('div');
            card.style.cssText = 'background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.15);padding:40px;max-width:440px;text-align:center;';
            card.innerHTML =
                '<div style="font-size:48px;margin-bottom:16px;">&#x1F512;</div>' +
                '<h2 style="margin:0 0 8px;color:#333;">Feature Locked</h2>' +
                '<p style="color:#666;margin:0 0 20px;">This feature requires the <strong>' + moduleName + '</strong> module' +
                (priceText ? ' &mdash; ' + priceText : '') + '</p>' +
                '<a href="/upgrade.html?feature=' + encodeURIComponent(featureKey) + '" ' +
                'style="display:inline-block;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;' +
                'padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;">Upgrade Now</a>' +
                '<br><a href="/dashboard.html" style="display:inline-block;margin-top:12px;color:#888;font-size:14px;">Back to Dashboard</a>';

            overlay.appendChild(card);
            document.body.appendChild(overlay);
        })
        .catch(function () {
            // Silent fail — page loads normally
        });
})();
