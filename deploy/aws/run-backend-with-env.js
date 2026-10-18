const fs = require('fs');

const environmentFile = '/etc/belorella/backend-env.json';
const config = JSON.parse(fs.readFileSync(environmentFile, 'utf8'));
for (const [name, value] of Object.entries(config)) {
  if (value !== undefined && value !== null) process.env[name] = String(value);
}

require('/opt/belorella/current/backend/index.js');

