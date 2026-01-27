/**
 * Set Password page JavaScript
 * Extracted for CSP compliance (P0-4 Phase 2)
 */

const urlParams = new URLSearchParams(window.location.search);
const token = urlParams.get('token');

const loadingState = document.getElementById('loading-state');
const invalidState = document.getElementById('invalid-state');
const passwordForm = document.getElementById('password-form');
const emailDisplay = document.getElementById('email-display');
const errorMessage = document.getElementById('error-message');
const successMessage = document.getElementById('success-message');
const btnSubmit = document.getElementById('btn-submit');
const headerText = document.getElementById('header-text');

// Check if this is a new account or password reset
const isNewAccount = urlParams.get('new') === 'true';
if (isNewAccount) {
  headerText.textContent = 'Welcome! Set up your password';
}

async function verifyToken() {
  if (!token) {
    showInvalid();
    return;
  }

  try {
    const response = await fetch(`/api/auth/verify-reset-token?token=${encodeURIComponent(token)}`);
    const data = await response.json();

    if (data.valid) {
      emailDisplay.textContent = `Setting password for: ${data.email}`;
      loadingState.style.display = 'none';
      passwordForm.style.display = 'block';
    } else {
      showInvalid();
    }
  } catch (error) {
    console.error('Token verification error:', error);
    showInvalid();
  }
}

function showInvalid() {
  loadingState.style.display = 'none';
  invalidState.style.display = 'block';
}

passwordForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const password = document.getElementById('password').value;
  const confirmPassword = document.getElementById('confirm-password').value;

  // Clear messages
  errorMessage.classList.remove('visible');
  successMessage.classList.remove('visible');

  // Validate passwords match
  if (password !== confirmPassword) {
    errorMessage.textContent = 'Passwords do not match';
    errorMessage.classList.add('visible');
    return;
  }

  // Disable button
  btnSubmit.disabled = true;
  btnSubmit.innerHTML = '<span class="spinner"></span>Setting password...';

  try {
    const response = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword: password })
    });

    const data = await response.json();

    if (data.success) {
      successMessage.textContent = data.message;
      successMessage.classList.add('visible');
      btnSubmit.textContent = 'Success!';

      // Redirect to login after 2 seconds
      setTimeout(() => {
        window.location.href = '/login.html?setup=complete';
      }, 2000);
    } else {
      errorMessage.textContent = data.error || 'Failed to set password';
      errorMessage.classList.add('visible');
      btnSubmit.disabled = false;
      btnSubmit.textContent = 'Set Password';
    }
  } catch (error) {
    console.error('Reset password error:', error);
    errorMessage.textContent = 'Unable to connect to server. Please try again.';
    errorMessage.classList.add('visible');
    btnSubmit.disabled = false;
    btnSubmit.textContent = 'Set Password';
  }
});

// Verify token on load
verifyToken();
