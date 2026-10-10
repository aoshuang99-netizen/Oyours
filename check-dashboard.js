const http = require('http');

function fetchJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: 'localhost', port: 3002, path: path, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

(async () => {
  try {
    const dashboard = await fetchJson('/api/v14/dashboard');
    console.log('=== DASHBOARD ===');
    console.log(JSON.stringify({
      devices: dashboard.devices,
      nurturing: dashboard.nurturing,
      contentGenerator: dashboard.contentGenerator,
      dauController: dashboard.dauController,
      websiteAnalytics: dashboard.websiteAnalytics,
      trafficRouter: dashboard.trafficRouter,
      eventBus: dashboard.eventBus,
      decision: dashboard.decision,
      proactiveMarketing: dashboard.proactiveMarketing,
    }, null, 2));
  } catch (e) {
    console.error('Error:', e.message);
  }
})();
