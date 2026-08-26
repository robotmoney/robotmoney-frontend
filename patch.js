const fs = require('fs');
let code = fs.readFileSync('scripts/lib/smoke-db-mode.ts', 'utf8');
code = code.replace(
  '    // off so hand it a canonical argv rather than this one.\n      envFilePath: opts.envFilePath,\n    });',
  '    // off so hand it a canonical argv rather than this one.\n    const ext = resolveExternalPg(["--db", "external"], {\n      envFilePath: opts.envFilePath,\n    });'
);
fs.writeFileSync('scripts/lib/smoke-db-mode.ts', code);
