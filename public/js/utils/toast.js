/**
 * Shared toast notification utility.
 * Loaded globally before page-specific scripts.
 *
 * Requires a <div class="toast" id="toast"></div> element in the page.
 * Supports CSS class "active" or "visible" for show/hide transitions.
 *
 * @param {string} message - Text to display
 * @param {string} [type=''] - Optional type: 'success', 'error', 'warning', 'info'
 */

/* eslint-disable no-unused-vars */

// Inject base toast styles once (pages may override in their own <style> blocks)
(function () {
  if (document.getElementById('toast-util-styles')) return;
  var style = document.createElement('style');
  style.id = 'toast-util-styles';
  style.textContent =
    '.toast {' +
      'position: fixed; top: 20px; right: 20px;' +
      'padding: 12px 20px; border-radius: 8px;' +
      'color: white; font-weight: 500;' +
      'box-shadow: 0 4px 12px rgba(0,0,0,0.15);' +
      'z-index: 10000; max-width: 400px;' +
      'background: #333;' +
      'transform: translateX(120%);' +
      'transition: transform 0.3s ease, opacity 0.3s ease;' +
      'opacity: 0;' +
    '}' +
    '.toast.active, .toast.visible {' +
      'transform: translateX(0); opacity: 1;' +
    '}' +
    '.toast.success { background: #10b981; }' +
    '.toast.error { background: #ef4444; }' +
    '.toast.warning { background: #f59e0b; }' +
    '.toast.info { background: #3b82f6; }';
  document.head.appendChild(style);
})();

function showToast(message, type) {
  type = type || '';
  var toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast ' + type;
  toast.classList.add('active', 'visible');

  setTimeout(function () {
    toast.classList.remove('active', 'visible');
  }, 3000);
}
