/**
 * Login page JavaScript
 * Extracted for CSP compliance (P0-4 Phase 2)
 */

const form = document.getElementById('login-form');
const errorMessage = document.getElementById('error-message');
const sessionMessage = document.getElementById('session-message');
const btnLogin = document.getElementById('btn-login');

// Check for session expired message in URL
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('expired') === 'true') {
  sessionMessage.classList.add('visible');
}

// Get return URL from query params
const returnUrl = urlParams.get('returnUrl') || '/dashboard.html';

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  // Clear previous errors
  errorMessage.classList.remove('visible');
  sessionMessage.classList.remove('visible');

  // Disable button and show loading
  btnLogin.disabled = true;
  btnLogin.innerHTML = '<span class="spinner"></span>Signing in...';

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      credentials: 'include'
    });

    const data = await response.json();

    if (response.ok && data.success) {
      // Login successful - redirect
      window.location.href = returnUrl;
    } else {
      // Login failed
      errorMessage.textContent = data.error || 'Login failed. Please check your credentials.';
      errorMessage.classList.add('visible');
      btnLogin.disabled = false;
      btnLogin.textContent = 'Sign In';
    }
  } catch (error) {
    console.error('Login error:', error);
    errorMessage.textContent = 'Unable to connect to server. Please try again.';
    errorMessage.classList.add('visible');
    btnLogin.disabled = false;
    btnLogin.textContent = 'Sign In';
  }
});

// Focus email field on load
document.getElementById('email').focus();

// ==================== FORGOT PASSWORD ====================
const loginForm = document.getElementById('login-form');
const forgotForm = document.getElementById('forgot-form');
const forgotLink = document.getElementById('forgot-password-link');
const backToLogin = document.getElementById('back-to-login');
const forgotError = document.getElementById('forgot-error');
const forgotSuccess = document.getElementById('forgot-success');
const btnForgot = document.getElementById('btn-forgot');

// Check for setup complete message
if (urlParams.get('setup') === 'complete') {
  sessionMessage.textContent = 'Password set successfully! Please log in.';
  sessionMessage.style.background = '#f0fdf4';
  sessionMessage.style.borderColor = '#86efac';
  sessionMessage.style.color = '#16a34a';
  sessionMessage.classList.add('visible');
}

forgotLink.addEventListener('click', (e) => {
  e.preventDefault();
  loginForm.style.display = 'none';
  forgotForm.style.display = 'block';
  document.getElementById('forgot-email').focus();
});

backToLogin.addEventListener('click', (e) => {
  e.preventDefault();
  forgotForm.style.display = 'none';
  loginForm.style.display = 'block';
  forgotError.classList.remove('visible');
  forgotSuccess.style.display = 'none';
  document.getElementById('email').focus();
});

forgotForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const email = document.getElementById('forgot-email').value.trim();

  // Clear messages
  forgotError.classList.remove('visible');
  forgotSuccess.style.display = 'none';

  // Disable button
  btnForgot.disabled = true;
  btnForgot.innerHTML = '<span class="spinner"></span>Sending...';

  try {
    const response = await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });

    const data = await response.json();

    if (data.success) {
      forgotSuccess.textContent = data.message;
      forgotSuccess.style.display = 'block';
      btnForgot.textContent = 'Email Sent';

      // In development mode, show the reset link
      if (data.resetUrl) {
        // Validate URL is relative path (not javascript: or external)
        const safeUrl = data.resetUrl.startsWith('/') ? data.resetUrl : '';
        if (safeUrl) {
          forgotSuccess.innerHTML = `${escapeHtml(data.message)}<br><br><strong>Development mode:</strong><br><a href="${escapeHtml(safeUrl)}" style="color: #16a34a;">Click here to reset password</a>`;
        } else {
          forgotSuccess.textContent = data.message;
        }
      }
    } else {
      forgotError.textContent = data.error || 'Failed to send reset email';
      forgotError.classList.add('visible');
      btnForgot.disabled = false;
      btnForgot.textContent = 'Send Reset Link';
    }
  } catch (error) {
    console.error('Forgot password error:', error);
    forgotError.textContent = 'Unable to connect to server. Please try again.';
    forgotError.classList.add('visible');
    btnForgot.disabled = false;
    btnForgot.textContent = 'Send Reset Link';
  }
});
