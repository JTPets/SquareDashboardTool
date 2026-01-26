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

  async sendBackup(compressedBackup, dbInfo, compressionStats = {}) {
    if (!this.enabled) {
      logger.warn('Email notifications disabled, database backup not sent');
      return;
    }

    try {
      const timestamp = new Date().toISOString().split('T')[0];
      const filename = `square_dashboard_addon_backup_${timestamp}.sql.gz`;
      const sizeInMB = (compressedBackup.length / 1024 / 1024).toFixed(2);

      const mailOptions = {
        from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
        to: process.env.EMAIL_TO,
        subject: `[Square Dashboard Addon] Weekly Database Backup - ${timestamp}`,
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
            This is an automated weekly backup from Square Dashboard Addon Tool.
          </p>
        `,
        attachments: [
          {
            filename: filename,
            content: compressedBackup,
            contentType: 'application/gzip'
          }
        ]
      };

      await this.transporter.sendMail(mailOptions);
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

      const mailOptions = {
        from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
        to: process.env.EMAIL_TO,
        subject: `[Square Dashboard Addon] Database Backup Saved Locally - ${timestamp}`,
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
            This is an automated weekly backup from Square Dashboard Addon Tool.
          </p>
        `
      };

      await this.transporter.sendMail(mailOptions);
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
}

module.exports = new EmailNotifier();
