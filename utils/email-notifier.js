const nodemailer = require('nodemailer');
const logger = require('./logger');

class EmailNotifier {
  constructor() {
    this.enabled = process.env.EMAIL_ENABLED === 'true';
    this.errorCount = 0;
    this.lastErrorEmail = null;
    this.emailThrottle = (parseInt(process.env.EMAIL_THROTTLE_MINUTES) || 5) * 60 * 1000; // Default 5 minutes

    if (this.enabled) {
      this.transporter = nodemailer.createTransporter({
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
        subject: `[JTPets] CRITICAL: ${subject}`,
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
        subject: `[JTPets] ALERT: ${subject}`,
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
      subject: '[JTPets] Test Email',
      html: '<h2>✅ Email notifications are working!</h2><p>This is a test email from JTPets Inventory System.</p>'
    };

    await this.transporter.sendMail(mailOptions);
    logger.info('Test email sent successfully');
  }
}

module.exports = new EmailNotifier();
