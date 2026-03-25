module.exports = {
  apps: [
    {
      name:        'ship-tracker',
      script:      'tracker.js',
      cwd:         '/Users/YOUR_USERNAME/coding/shipTracking', // ← update this
      watch:       false,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
      },
      // Log files — viewable with: pm2 logs ship-tracker
      out_file:  './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
