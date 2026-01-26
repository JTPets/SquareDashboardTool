/**
 * Event Delegation Module
 *
 * Provides a pattern for handling events without inline handlers (onclick, onchange, etc.)
 * This enables removal of 'unsafe-inline' from Content Security Policy.
 *
 * ## Usage
 *
 * 1. Include this script in your HTML:
 *    <script src="/js/event-delegation.js"></script>
 *
 * 2. Replace inline handlers with data attributes:
 *
 *    BEFORE (inline handler - requires unsafe-inline):
 *    <button onclick="refreshLogs()">Refresh</button>
 *
 *    AFTER (data attribute - CSP compliant):
 *    <button data-action="refreshLogs">Refresh</button>
 *
 * 3. For change events:
 *
 *    BEFORE:
 *    <select onchange="filterLogs()">
 *
 *    AFTER:
 *    <select data-change="filterLogs">
 *
 * 4. For submit events:
 *
 *    BEFORE:
 *    <form onsubmit="submitForm(); return false;">
 *
 *    AFTER:
 *    <form data-submit="submitForm">
 *
 * 5. Register your handlers using the global PageActions object:
 *
 *    PageActions.register({
 *      refreshLogs: function(element, event) {
 *        // Your handler code here
 *        loadLogs();
 *      },
 *      filterLogs: function(element, event) {
 *        // element is the element that triggered the action
 *        // event is the original DOM event
 *        applyFilter(element.value);
 *      }
 *    });
 *
 * 6. For actions with parameters, use data-action-param:
 *
 *    <button data-action="viewItem" data-action-param="123">View Item</button>
 *
 *    PageActions.register({
 *      viewItem: function(element, event, param) {
 *        // param will be "123"
 *        openItemModal(param);
 *      }
 *    });
 *
 * ## Supported Events
 *
 * - data-action: click events
 * - data-change: change events (for inputs, selects)
 * - data-submit: form submit events (automatically prevents default)
 * - data-blur: blur events
 * - data-focus: focus events
 * - data-keyup: keyup events
 * - data-keydown: keydown events
 * - data-input: input events
 *
 * Created as part of P0-4 CSP migration (2026-01-26)
 */

(function() {
    'use strict';

    // Registry for action handlers
    const handlers = {};

    /**
     * Register action handlers
     * @param {Object} actions - Object mapping action names to handler functions
     */
    function register(actions) {
        if (typeof actions !== 'object' || actions === null) {
            console.error('PageActions.register: expected object, got', typeof actions);
            return;
        }

        for (const [name, handler] of Object.entries(actions)) {
            if (typeof handler !== 'function') {
                console.error(`PageActions.register: handler for "${name}" is not a function`);
                continue;
            }
            handlers[name] = handler;
        }
    }

    /**
     * Execute an action handler
     * @param {string} actionName - Name of the action to execute
     * @param {HTMLElement} element - Element that triggered the action
     * @param {Event} event - Original DOM event
     * @returns {*} - Return value from handler
     */
    function executeAction(actionName, element, event) {
        if (!actionName) {
            return;
        }

        const handler = handlers[actionName];

        if (handler) {
            const param = element.dataset.actionParam;
            try {
                return handler(element, event, param);
            } catch (error) {
                console.error(`PageActions: Error executing "${actionName}":`, error);
            }
        } else if (typeof window[actionName] === 'function') {
            // Fallback: check for global function (for gradual migration)
            const param = element.dataset.actionParam;
            try {
                return window[actionName](param, element, event);
            } catch (error) {
                console.error(`PageActions: Error executing global "${actionName}":`, error);
            }
        } else {
            console.warn(`PageActions: No handler registered for "${actionName}"`);
        }
    }

    /**
     * Find closest element with a data attribute
     * @param {HTMLElement} element - Starting element
     * @param {string} attr - Attribute name (without "data-" prefix)
     * @returns {HTMLElement|null}
     */
    function findClosest(element, attr) {
        const dataAttr = `data-${attr}`;
        while (element && element !== document.body) {
            if (element.hasAttribute(dataAttr)) {
                return element;
            }
            element = element.parentElement;
        }
        return null;
    }

    // Event delegation setup
    function setupDelegation() {
        // Click events
        document.addEventListener('click', function(event) {
            const target = findClosest(event.target, 'action');
            if (target) {
                event.preventDefault();
                executeAction(target.dataset.action, target, event);
            }
        });

        // Change events
        document.addEventListener('change', function(event) {
            const target = event.target;
            if (target.dataset.change) {
                executeAction(target.dataset.change, target, event);
            }
        });

        // Submit events
        document.addEventListener('submit', function(event) {
            const form = event.target;
            if (form.dataset.submit) {
                event.preventDefault();
                executeAction(form.dataset.submit, form, event);
            }
        });

        // Blur events
        document.addEventListener('blur', function(event) {
            const target = event.target;
            if (target.dataset.blur) {
                executeAction(target.dataset.blur, target, event);
            }
        }, true);

        // Focus events
        document.addEventListener('focus', function(event) {
            const target = event.target;
            if (target.dataset.focus) {
                executeAction(target.dataset.focus, target, event);
            }
        }, true);

        // Keyup events
        document.addEventListener('keyup', function(event) {
            const target = event.target;
            if (target.dataset.keyup) {
                executeAction(target.dataset.keyup, target, event);
            }
        });

        // Keydown events
        document.addEventListener('keydown', function(event) {
            const target = event.target;
            if (target.dataset.keydown) {
                executeAction(target.dataset.keydown, target, event);
            }
        });

        // Input events
        document.addEventListener('input', function(event) {
            const target = event.target;
            if (target.dataset.input) {
                executeAction(target.dataset.input, target, event);
            }
        });
    }

    // Export PageActions object
    window.PageActions = {
        register: register,
        execute: executeAction
    };

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupDelegation);
    } else {
        setupDelegation();
    }

    console.log('PageActions: Event delegation initialized');
})();
