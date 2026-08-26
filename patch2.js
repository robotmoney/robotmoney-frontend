const fs = require('fs');
let code = fs.readFileSync('scripts/lib/smoke-db-mode.ts', 'utf8');
code = code.replace(/if \(legacyExternal\) \{/g, 'if (false) {');
code = code.replace(/legacyExternal \?/g, 'false ?');
code = code.replace(/r\.url!/g, 'ext.url!');
code = code.replace(/r\.redactedUrl!/g, 'ext.redactedUrl!');
code = code.replace(/r\.host!/g, 'ext.host!');
code = code.replace(/r\.source!/g, 'ext.source!');
fs.writeFileSync('scripts/lib/smoke-db-mode.ts', code);
