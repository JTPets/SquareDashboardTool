const nodemailer = require('nodemailer');
const logger = require('./logger');

class EmailNotifier {
  constructor() {
    this.enabled = process.env.EMAIL_ENABLED === 'true';
    this.errorCount = 0;
    this.lastErrorEmail = null;
    this.emailThrottle = (parseInt(process.env.EMAIL_THROTTLE_MINUTES) || 5) * 60 * 1000; // Default 5 minutes

    if (this.enabled) {
      this.transporter = nodemailer.createTransport({
        service: process.env.EMAIL_SERVICE || 'gmail',
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASSWORD
        }
      });
    }
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
      const mailOptions = {
        from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
        to: process.env.EMAIL_TO,
        subject: `[Square Dashboard Addon] CRITICAL: ${subject}`,
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
      };

      await this.transporter.sendMail(mailOptions);
      this.lastErrorEmail = now;
      logger.info('Critical error email sent', { subject, to: process.env.EMAIL_TO });

    } catch (emailError) {
      logger.error('Failed to send error email', {
        error: emailError.message,
        originalError: error.message
      });
    }
  }

  async sendAlert(subject, body) {
    if (!this.enabled) {
      logger.warn('Email notifications disabled, would have sent alert:', { subject });
      return;
    }

    try {
      const mailOptions = {
        from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
        to: process.env.EMAIL_TO,
        subject: `[Square Dashboard Addon] ALERT: ${subject}`,
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
      };

      await this.transporter.sendMail(mailOptions);
      logger.info('Alert email sent', { subject, to: process.env.EMAIL_TO });

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

    const mailOptions = {
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: process.env.EMAIL_TO,
      subject: '[Square Dashboard Addon] Test Email',
      html: '<h2>✅ Email notifications are working!</h2><p>This is a test email from Square Dashboard Addon Tool.</p>'
    };

    await this.transporter.sendMail(mailOptions);
    logger.info('Test email sent successfully');
  }

  async sendBackup(sqlDump, dbInfo) {
    if (!this.enabled) {
      logger.warn('Email notifications disabled, database backup not sent');
      return;
    }

    try {
      const timestamp = new Date().toISOString().split('T')[0];
      const filename = `square_dashboard_addon_backup_${timestamp}.sql`;
      const sizeInMB = (sqlDump.length / 1024 / 1024).toFixed(2);

      const mailOptions = {
        from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
        to: process.env.EMAIL_TO,
        subject: `[Square Dashboard Addon] Weekly Database Backup - ${timestamp}`,
        html: `
          <h2 style="color: #8b5cf6;">💾 Weekly Database Backup</h2>
          <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
          <p><strong>Database:</strong> ${dbInfo.database || 'square_dashboard_addon'}</p>
          <p><strong>Backup Size:</strong> ${sizeInMB} MB</p>

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
            This backup can be restored using the Database Backup & Restore tool.
          </p>

          <hr>
          <p style="color: #6b7280; font-size: 12px;">
            Server: ${require('os').hostname()}<br>
            This is an automated weekly backup from Square Dashboard Addon Tool.
          </p>
        `,
        attachments: [
          {
            filename: filename,
            content: sqlDump,
            contentType: 'application/sql'
          }
        ]
      };

      await this.transporter.sendMail(mailOptions);
      logger.info('Backup email sent successfully', {
        filename,
        size_mb: sizeInMB,
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
}

module.exports = new EmailNotifier();
