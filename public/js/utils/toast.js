/**
 * Shared toast notification utility.
 * Loaded globally before page-specific scripts.
 *
 * Requires a <div class="toast" id="toast"></div> element in the page.
 * Requires <link rel="stylesheet" href="/css/shared.css"> in the page <head>.
 * Supports CSS class "active" or "visible" for show/hide transitions.
 *
 * @param {string} message - Text to display
 * @param {string} [type=''] - Optional type: 'success', 'error', 'warning', 'info'
 */

/* eslint-disable no-unused-vars */

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
