/**
 * Index/Landing page JavaScript
 * Extracted for CSP compliance (P0-4 Phase 2)
 */

// Set current year in footer
document.getElementById('year').textContent = new Date().getFullYear();

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', function (e) {
    e.preventDefault();
    const target = document.querySelector(this.getAttribute('href'));
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});

// Global handlers for event delegation
function navigateToLogin() {
  window.location.href = '/login.html';
}

// Expose functions to global scope for event delegation
window.navigateToLogin = navigateToLogin;
