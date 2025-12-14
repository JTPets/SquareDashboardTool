/**
 * User-Friendly Error Helper
 * Square Dashboard Addon Tool
 *
 * Converts technical errors into friendly messages for users
 */

const ErrorHelper = {
    // Map technical errors to user-friendly messages
    friendlyMessages: {
        // Network errors
        'Failed to fetch': 'Unable to connect to the server. Please check your internet connection and try again.',
        'NetworkError': 'Network connection lost. Please check your internet and refresh the page.',
        'net::ERR_CONNECTION_REFUSED': 'Cannot connect to the server. Please ensure the application is running.',
        'ECONNREFUSED': 'Server is not responding. Please try again in a moment.',

        // HTTP status errors
        '400': 'The request was invalid. Please check your input and try again.',
        '401': 'You are not authorized. Please log in again.',
        '403': 'Access denied. You don\'t have permission for this action.',
        '404': 'The requested resource was not found.',
        '408': 'Request timed out. Please try again.',
        '429': 'Too many requests. Please wait a moment before trying again.',
        '500': 'Server error occurred. Our team has been notified. Please try again later.',
        '502': 'Server is temporarily unavailable. Please try again in a few minutes.',
        '503': 'Service is temporarily unavailable. Please try again later.',
        '504': 'Request timed out. The server is taking too long to respond.',

        // Square API errors
        'UNAUTHORIZED': 'Square authorization expired. Please reconnect your Square account.',
        'ACCESS_TOKEN_EXPIRED': 'Square session expired. Please reconnect your Square account.',
        'ACCESS_TOKEN_REVOKED': 'Square access was revoked. Please reconnect your Square account.',
        'RATE_LIMITED': 'Square API rate limit reached. Please wait a moment and try again.',
        'SERVICE_UNAVAILABLE': 'Square service is temporarily unavailable. Please try again later.',
        'INVALID_API_KEY': 'Square API configuration error. Please contact support.',

        // Database errors
        'ECONNRESET': 'Database connection was reset. Please refresh the page.',
        'connection refused': 'Database is not available. Please try again later.',
        'timeout': 'Operation timed out. Please try again.',

        // Validation errors
        'VALIDATION_ERROR': 'Please check your input and try again.',
        'MISSING_REQUIRED_PARAMETER': 'Required information is missing. Please fill in all required fields.',
        'INVALID_VALUE': 'One or more values are invalid. Please check your input.'
    },

    // Context-specific messages
    contextMessages: {
        sync: {
            error: 'Failed to sync data with Square. Your local data may be out of date.',
            timeout: 'Sync is taking longer than expected. It will continue in the background.'
        },
        inventory: {
            load: 'Unable to load inventory data. Please refresh the page.',
            update: 'Failed to update inventory. Please try again.',
            sync: 'Inventory sync failed. Changes may not be reflected in Square yet.'
        },
        catalog: {
            load: 'Unable to load catalog. Please refresh the page.',
            update: 'Failed to update item. Please try again.'
        },
        orders: {
            load: 'Unable to load orders. Please refresh the page.',
            create: 'Failed to create order. Please check your items and try again.'
        },
        vendor: {
            load: 'Unable to load vendor data. Please refresh the page.',
            import: 'Failed to import vendor catalog. Please check the file format.'
        },
        settings: {
            save: 'Failed to save settings. Please try again.',
            load: 'Unable to load settings. Using default values.'
        }
    },

    /**
     * Get a user-friendly error message
     * @param {Error|string} error - The error object or message
     * @param {string} context - Optional context (sync, inventory, catalog, etc.)
     * @param {string} action - Optional action (load, update, create, etc.)
     * @returns {string} User-friendly error message
     */
    getFriendlyMessage(error, context = null, action = null) {
        const errorMsg = typeof error === 'string' ? error : (error?.message || String(error));

        // Check for context-specific message first
        if (context && action && this.contextMessages[context]?.[action]) {
            return this.contextMessages[context][action];
        }

        // Check for known error patterns
        for (const [pattern, friendlyMsg] of Object.entries(this.friendlyMessages)) {
            if (errorMsg.includes(pattern) || errorMsg.toUpperCase().includes(pattern)) {
                return friendlyMsg;
            }
        }

        // Check for HTTP status code in error
        const statusMatch = errorMsg.match(/\b(4\d{2}|5\d{2})\b/);
        if (statusMatch && this.friendlyMessages[statusMatch[1]]) {
            return this.friendlyMessages[statusMatch[1]];
        }

        // Default friendly message
        return 'Something went wrong. Please try again. If the problem persists, contact support.';
    },

    /**
     * Show error in a toast notification (if available) or alert
     * @param {Error|string} error - The error
     * @param {string} context - Optional context
     * @param {string} action - Optional action
     */
    showError(error, context = null, action = null) {
        const message = this.getFriendlyMessage(error, context, action);

        // Log original error for debugging
        console.error('Error details:', error);

        // Try to use toast if available, otherwise use alert
        if (typeof showToast === 'function') {
            showToast(message, 'error');
        } else if (typeof Toast !== 'undefined' && Toast.show) {
            Toast.show(message, 'error');
        } else {
            alert(message);
        }
    },

    /**
     * Handle fetch response and throw friendly error if not ok
     * @param {Response} response - Fetch response
     * @param {string} context - Optional context
     * @param {string} action - Optional action
     * @returns {Response} The response if ok
     */
    async handleResponse(response, context = null, action = null) {
        if (!response.ok) {
            let errorData = {};
            try {
                errorData = await response.json();
            } catch (e) {
                // Response wasn't JSON
            }

            const errorMsg = errorData.error || errorData.message || `HTTP ${response.status}`;
            const friendlyMsg = this.getFriendlyMessage(errorMsg, context, action);

            const error = new Error(friendlyMsg);
            error.status = response.status;
            error.originalError = errorMsg;
            throw error;
        }
        return response;
    },

    /**
     * Wrap an async function with error handling
     * @param {Function} fn - Async function to wrap
     * @param {string} context - Context for error messages
     * @param {string} action - Action for error messages
     * @returns {Function} Wrapped function
     */
    withErrorHandling(fn, context, action) {
        return async (...args) => {
            try {
                return await fn(...args);
            } catch (error) {
                this.showError(error, context, action);
                throw error;
            }
        };
    }
};

// Make available globally
window.ErrorHelper = ErrorHelper;
