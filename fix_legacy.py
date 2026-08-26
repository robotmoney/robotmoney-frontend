with open("scripts/lib/smoke-main.ts", "r") as f:
    c = f.read()
c = c.replace('const LEGACY_STAGE_FLAG = "--stage";\n', '')
c = c.replace('const usedLegacyStageFlag = process.argv.includes(LEGACY_STAGE_FLAG);\n', '')
c = c.replace('const staticPortMode = process.argv.includes(STATIC_PORT_FLAG) || usedLegacyStageFlag;\n', 'const staticPortMode = process.argv.includes(STATIC_PORT_FLAG);\n')
import re
c = re.sub(r'if \(usedLegacyStageFlag\) \{.*?\n\}\n', '', c, flags=re.DOTALL)
with open("scripts/lib/smoke-main.ts", "w") as f:
    f.write(c)
