const nodemailer = require('nodemailer');
const logger = require('./logger');
const db = require('./database');

/**
 * Send email via Resend HTTP API (no npm package needed)
 * @param {Object} options - { from, to, subject, html, attachments }
 * @param {string} apiKey - Resend API key
 * @returns {Promise<Object>} API response
 */
async function sendViaResend(options, apiKey) {
    const body = {
        from: options.from,
        to: [options.to],
        subject: options.subject,
        html: options.html
    };

    if (options.attachments && options.attachments.length > 0) {
        body.attachments = options.attachments.map(att => ({
            filename: att.filename,
            content: Buffer.isBuffer(att.content)
                ? att.content.toString('base64')
                : att.content,
            content_type: att.contentType || 'application/octet-stream'
        }));
    }

    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Resend API error ${response.status}: ${errorBody}`);
    }

    return response.json();
}

/**
 * Send email via Mailgun HTTP API (no npm package needed)
 * @param {Object} options - { from, to, subject, html, attachments }
 * @param {string} apiKey - Mailgun API key
 * @param {string} domain - Mailgun sending domain
 * @returns {Promise<Object>} API response
 */
async function sendViaMailgun(options, apiKey, domain) {
    const formData = new FormData();
    formData.append('from', options.from);
    formData.append('to', options.to);
    formData.append('subject', options.subject);
    formData.append('html', options.html);

    if (options.attachments && options.attachments.length > 0) {
        for (const att of options.attachments) {
            const content = Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content);
            const blob = new Blob([content], { type: att.contentType || 'application/octet-stream' });
            formData.append('attachment', blob, att.filename);
        }
    }

    const response = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
        method: 'POST',
        headers: {
            'Authorization': 'Basic ' + Buffer.from(`api:${apiKey}`).toString('base64')
        },
        body: formData
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Mailgun API error ${response.status}: ${errorBody}`);
    }

    return response.json();
}

class EmailNotifier {
    constructor() {
        this.enabled = process.env.EMAIL_ENABLED === 'true';
        this.errorCount = 0;
        this.lastErrorEmail = null;
        this.emailThrottle = (parseInt(process.env.EMAIL_THROTTLE_MINUTES) || 5) * 60 * 1000;
        this.provider = (process.env.EMAIL_PROVIDER || 'smtp').toLowerCase();

        if (this.enabled) {
            this._initProvider();
        }
    }

    _initProvider() {
        const fromName = process.env.EMAIL_FROM_NAME || 'SqTools Alerts';
        const fromAddr = process.env.EMAIL_FROM || process.env.EMAIL_USER;
        this.fromAddress = fromName && fromAddr && !fromAddr.includes('<')
            ? `${fromName} <${fromAddr}>`
            : fromAddr;

        if (this.provider === 'resend') {
            this.apiKey = process.env.EMAIL_API_KEY;
            if (!this.apiKey) {
                logger.warn('EMAIL_PROVIDER=resend but EMAIL_API_KEY not set');
            }
        } else if (this.provider === 'mailgun') {
            this.apiKey = process.env.EMAIL_API_KEY;
            this.mailgunDomain = process.env.MAILGUN_DOMAIN;
            if (!this.apiKey) {
                logger.warn('EMAIL_PROVIDER=mailgun but EMAIL_API_KEY not set');
            }
            if (!this.mailgunDomain) {
                logger.warn('EMAIL_PROVIDER=mailgun but MAILGUN_DOMAIN not set');
            }
        } else {
            // Default: SMTP via nodemailer
            this.transporter = nodemailer.createTransport({
                service: process.env.EMAIL_SERVICE || 'gmail',
                auth: {
                    user: process.env.EMAIL_USER,
                    pass: process.env.EMAIL_PASSWORD
                }
            });
        }
    }

    /**
     * Send an email using the configured provider
     * @param {Object} mailOptions - { from, to, subject, html, attachments }
     * @returns {Promise<void>}
     */
    async _send(mailOptions) {
        const options = {
            ...mailOptions,
            from: mailOptions.from || this.fromAddress
        };

        if (this.provider === 'resend') {
            return sendViaResend(options, this.apiKey);
        } else if (this.provider === 'mailgun') {
            return sendViaMailgun(options, this.apiKey, this.mailgunDomain);
        } else {
            return this.transporter.sendMail(options);
        }
    }

    /**
     * Resolve the email recipient for a merchant.
     * Uses merchant's admin_email if available, falls back to platform EMAIL_TO.
     * @param {number|null} merchantId - Optional merchant ID
     * @returns {Promise<string>} Email address to send to
     */
    async _resolveRecipient(merchantId) {
        if (merchantId) {
            try {
                const result = await db.query(
                    'SELECT admin_email FROM merchants WHERE id = $1',
                    [merchantId]
                );
                if (result.rows.length > 0 && result.rows[0].admin_email) {
                    return result.rows[0].admin_email;
                }
            } catch (err) {
                logger.warn('Failed to resolve merchant admin_email, using platform default', {
                    merchantId,
                    error: err.message
                });
            }
        }
        return process.env.EMAIL_TO;
    }

    async sendCritical(subject, error, context = {}) {
        if (!this.enabled) {
            logger.warn('Email notifications disabled, would have sent:', { subject, error: error.message });
            return;
        }

        // Throttle emails to prevent spam
        const now = Date.now();
        if (this.lastErrorEmail && (now - this.lastErrorEmail) < this.emailThrottle) {
            logger.warn('Email throttled, too many errors', { subject });
            return;
        }

        try {
            const recipient = await this._resolveRecipient(context.merchantId);
            await this._send({
                to: recipient,
                subject: `[SqTools] CRITICAL: ${subject}`,
                html: `
          <h2 style="color: #dc2626;">🚨 Critical Error</h2>
          <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
          <p><strong>Error:</strong> ${error.message}</p>
          ${context.endpoint ? `<p><strong>Endpoint:</strong> ${context.endpoint}</p>` : ''}
          ${context.user ? `<p><strong>User:</strong> ${context.user}</p>` : ''}

          <h3>Stack Trace:</h3>
          <pre style="background: #f3f4f6; padding: 10px; overflow-x: auto;">${error.stack || 'No stack trace available'}</pre>

          ${context.details ? `<h3>Additional Details:</h3><pre>${JSON.stringify(context.details, null, 2)}</pre>` : ''}

          <hr>
          <p style="color: #6b7280; font-size: 12px;">
            Server: ${require('os').hostname()}<br>
            Node Version: ${process.version}<br>
            Uptime: ${Math.floor(process.uptime() / 60)} minutes
          </p>
        `
            });

            this.lastErrorEmail = now;
            logger.info('Critical error email sent', { subject, to: recipient });

        } catch (emailError) {
            logger.error('Failed to send error email', {
                error: emailError.message,
                originalError: error.message
            });
        }
    }

    async sendAlert(subject, body, options = {}) {
        if (!this.enabled) {
            logger.warn('Email notifications disabled, would have sent alert:', { subject });
            return;
        }

        try {
            const recipient = await this._resolveRecipient(options.merchantId);
            await this._send({
                to: recipient,
                subject: `[SqTools] ALERT: ${subject}`,
                html: `
          <h2 style="color: #f59e0b;">⚠️ System Alert</h2>
          <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
          <p><strong>Alert:</strong> ${subject}</p>

          <hr>

          <div style="background: #f3f4f6; padding: 15px; border-radius: 5px;">
            <pre style="margin: 0; white-space: pre-wrap; word-wrap: break-word;">${body}</pre>
          </div>

          <hr>
          <p style="color: #6b7280; font-size: 12px;">
            Server: ${require('os').hostname()}<br>
            Node Version: ${process.version}<br>
            Uptime: ${Math.floor(process.uptime() / 60)} minutes
          </p>
        `
            });

            logger.info('Alert email sent', { subject, to: recipient });

        } catch (error) {
            logger.error('Failed to send alert email', {
                error: error.message,
                subject
            });
        }
    }

    async testEmail() {
        if (!this.enabled) {
            throw new Error('Email notifications are disabled. Set EMAIL_ENABLED=true in .env');
        }

        await this._send({
            to: process.env.EMAIL_TO,
            subject: '[SqTools] Test Email',
            html: `<h2>✅ Email notifications are working!</h2>
        <p>This is a test email from SqTools.</p>
        <p><strong>Provider:</strong> ${this.provider}</p>
        <p><strong>From:</strong> ${this.fromAddress}</p>
        <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>`
        });

        logger.info('Test email sent successfully', { provider: this.provider });
    }

    async sendHeartbeat() {
        if (!this.enabled) {
            logger.warn('Email notifications disabled, heartbeat not sent');
            return;
        }

        try {
            const uptime = Math.floor(process.uptime() / 60);
            await this._send({
                to: process.env.EMAIL_TO,
                subject: `[SqTools] Daily Heartbeat — System Healthy`,
                html: `
          <h2 style="color: #10b981;">💚 System Heartbeat</h2>
          <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
          <p>All systems operational. This is an automated daily health check.</p>

          <hr>
          <p style="color: #6b7280; font-size: 12px;">
            Server: ${require('os').hostname()}<br>
            Node Version: ${process.version}<br>
            Uptime: ${uptime} minutes (${(uptime / 60).toFixed(1)} hours)<br>
            Provider: ${this.provider}
          </p>
          <p style="color: #9ca3af; font-size: 11px;">
            If you stop receiving this email, your alerting pipeline is broken.
          </p>
        `
            });

            logger.info('Heartbeat email sent', { provider: this.provider });
        } catch (error) {
            logger.error('Failed to send heartbeat email', {
                error: error.message,
                stack: error.stack
            });
        }
    }

    async sendBackup(compressedBackup, dbInfo, compressionStats = {}) {
        if (!this.enabled) {
            logger.warn('Email notifications disabled, database backup not sent');
            return;
        }

        try {
            const timestamp = new Date().toISOString().split('T')[0];
            const filename = `square_dashboard_addon_backup_${timestamp}.sql.gz`;
            const sizeInMB = (compressedBackup.length / 1024 / 1024).toFixed(2);

            await this._send({
                to: process.env.EMAIL_TO,
                subject: `[SqTools] Weekly Database Backup - ${timestamp}`,
                html: `
          <h2 style="color: #8b5cf6;">💾 Weekly Database Backup</h2>
          <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
          <p><strong>Database:</strong> ${dbInfo.database || 'square_dashboard_addon'}</p>
          <p><strong>Original Size:</strong> ${compressionStats.originalSizeMB || 'N/A'} MB</p>
          <p><strong>Compressed Size:</strong> ${sizeInMB} MB ${compressionStats.compressionRatio ? `(${compressionStats.compressionRatio}% reduction)` : ''}</p>

          <hr>

          <h3>Database Statistics</h3>
          <ul>
            ${dbInfo.tables ? dbInfo.tables.slice(0, 10).map(t =>
                    `<li><strong>${t.tablename}:</strong> ${parseInt(t.row_count).toLocaleString()} rows</li>`
                ).join('') : ''}
          </ul>
          ${dbInfo.tables && dbInfo.tables.length > 10 ? `<p><em>...and ${dbInfo.tables.length - 10} more tables</em></p>` : ''}

          <hr>

          <p style="background: #fef3c7; padding: 10px; border-radius: 5px; border-left: 4px solid #f59e0b;">
            <strong>📎 Attachment:</strong> ${filename}<br>
            <strong>Format:</strong> Gzip-compressed SQL<br>
            To restore: <code>gunzip ${filename}</code> then import the .sql file
          </p>

          <hr>
          <p style="color: #6b7280; font-size: 12px;">
            Server: ${require('os').hostname()}<br>
            This is an automated weekly backup from SqTools.
          </p>
        `,
                attachments: [
                    {
                        filename: filename,
                        content: compressedBackup,
                        contentType: 'application/gzip'
                    }
                ]
            });

            logger.info('Backup email sent successfully', {
                filename,
                compressed_size_mb: sizeInMB,
                original_size_mb: compressionStats.originalSizeMB,
                to: process.env.EMAIL_TO
            });

        } catch (error) {
            logger.error('Failed to send backup email', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    async sendBackupNotification(dbInfo, backupInfo) {
        if (!this.enabled) {
            logger.warn('Email notifications disabled, backup notification not sent');
            return;
        }

        try {
            const timestamp = new Date().toISOString().split('T')[0];

            await this._send({
                to: process.env.EMAIL_TO,
                subject: `[SqTools] Database Backup Saved Locally - ${timestamp}`,
                html: `
          <h2 style="color: #f59e0b;">💾 Database Backup - Saved Locally</h2>
          <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
          <p><strong>Database:</strong> ${dbInfo.database || 'square_dashboard_addon'}</p>

          <hr>

          <p style="background: #fef3c7; padding: 15px; border-radius: 5px; border-left: 4px solid #f59e0b;">
            <strong>⚠️ Note:</strong> ${backupInfo.reason}<br><br>
            The backup has been saved to the server instead of being attached to this email.
          </p>

          <h3>Backup Details</h3>
          <ul>
            <li><strong>Location:</strong> <code>${backupInfo.filepath}</code></li>
            <li><strong>Filename:</strong> ${backupInfo.filename}</li>
            <li><strong>Original Size:</strong> ${backupInfo.originalSizeMB} MB</li>
            <li><strong>Compressed Size:</strong> ${backupInfo.compressedSizeMB} MB (${backupInfo.compressionRatio}% reduction)</li>
          </ul>

          <h3>How to Retrieve</h3>
          <p>SSH into the server and copy the backup file:</p>
          <pre style="background: #f3f4f6; padding: 10px; border-radius: 5px;">scp user@server:${backupInfo.filepath} ./</pre>

          <hr>

          <h3>Database Statistics</h3>
          <ul>
            ${dbInfo.tables ? dbInfo.tables.slice(0, 10).map(t =>
                    `<li><strong>${t.tablename}:</strong> ${parseInt(t.row_count).toLocaleString()} rows</li>`
                ).join('') : ''}
          </ul>
          ${dbInfo.tables && dbInfo.tables.length > 10 ? `<p><em>...and ${dbInfo.tables.length - 10} more tables</em></p>` : ''}

          <hr>
          <p style="color: #6b7280; font-size: 12px;">
            Server: ${require('os').hostname()}<br>
            This is an automated weekly backup from SqTools.
          </p>
        `
            });

            logger.info('Backup notification email sent', {
                filepath: backupInfo.filepath,
                compressed_size_mb: backupInfo.compressedSizeMB,
                to: process.env.EMAIL_TO
            });

        } catch (error) {
            logger.error('Failed to send backup notification email', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Send a staff invitation email with an accept link.
     * @param {Object} opts
     * @param {string} opts.to - Invitee email address
     * @param {string} opts.role - Assigned role (manager, clerk, readonly)
     * @param {string} opts.merchantName - Merchant's business name
     * @param {string} opts.inviteUrl - Full URL to accept the invitation
     * @param {string} opts.invitedByEmail - Email of the person who sent the invite
     */
    async sendStaffInvitation({ to, role, merchantName, inviteUrl, invitedByEmail }) {
        if (!this.enabled) {
            logger.warn('Email notifications disabled, would have sent staff invitation', { to, role });
            return;
        }

        try {
            await this._send({
                to,
                subject: `You've been invited to join ${merchantName} on SqTools`,
                html: `
          <h2>You've been invited!</h2>
          <p><strong>${invitedByEmail}</strong> has invited you to join
          <strong>${merchantName}</strong> on SqTools as a <strong>${role}</strong>.</p>

          <p style="margin: 24px 0;">
            <a href="${inviteUrl}"
               style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">
              Accept Invitation
            </a>
          </p>

          <p style="color:#6b7280;font-size:13px;">
            This invitation expires in 7 days. If you did not expect this invitation, you can ignore it.
          </p>

          <hr>
          <p style="color:#9ca3af;font-size:11px;">SqTools — Square POS Management</p>
        `
            });

            logger.info('Staff invitation email sent', { to, role, merchantName });
        } catch (error) {
            logger.error('Failed to send staff invitation email', { error: error.message, to });
            throw error;
        }
    }

    /**
     * Get current provider name (for diagnostics)
     * @returns {string}
     */
    getProvider() {
        return this.provider;
    }
}

module.exports = new EmailNotifier();
