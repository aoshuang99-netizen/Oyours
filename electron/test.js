const { app } = require('electron');
console.log('app type:', typeof app);
console.log('app methods:', Object.keys(app).slice(0, 10));
