'use strict';
const fs = require('fs');
const p = process.argv[2];
const s = fs.readFileSync(p, 'utf8');
const m = s.match(/server\s*:\s*"([A-Za-z0-9+/=]{1000,})"/);
if (!m) { console.log('NO_SERVER_FIELD'); process.exit(0); }
const dec = Buffer.from(m[1], 'base64').toString('utf8');
console.log('decoded_len', dec.length);
console.log('has_sanitizeChat', dec.includes('sanitizeChat'));
console.log('has_fullwidth_norm', dec.includes('\\uFF5C'));
console.log('has_workspace_attachment_rule', dec.includes('workspace_attachment'));