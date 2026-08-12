module.exports = {
  apps: [
    {
      name:        'ship-tracker',
      script:      'tracker.js',
      cwd:         '/root/coding/shipTracking',
      watch:       false,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
        // NOTE: these are NOT the authoritative values. tracker.js line 1 runs
        // require('dotenv').config({ override: true }), so .env beats BOTH this
        // block and /root/.pm2/dump.pm2. Real precedence:
        //     .env  >  pm2 env  >  config.js default
        // Change .env when moving the endpoint. Kept here only so the three
        // sources agree; a mismatch here is silently ignored at runtime.
        // Also note /proc/<pid>/environ shows the LAUNCH-time env, not what
        // dotenv rewrote in memory — it will lie to you when debugging this.
        LLAMA_URL:   'http://127.0.0.1:8081',
        LLAMA_MODEL: 'Qwen3-8B-Q4_K_M.gguf',
      },
      // Log files — viewable with: pm2 logs ship-tracker
      out_file:  './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
