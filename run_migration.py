import os, glob, sys, subprocess

def replace_in_file(path):
    with open(path, 'r') as f:
        content = f.read()

    new_content = content
    # Identifiers
    new_content = new_content.replace('DEMO_PROJECT', 'SMOKE_PROJECT')
    new_content = new_content.replace('demo-state.json', 'smoke-state.json')
    new_content = new_content.replace('robotmoney.demo', 'robotmoney.smoke')
    new_content = new_content.replace('robotmoney-demo', 'robotmoney-smoke')
    new_content = new_content.replace('DEMO_VOLUME', 'SMOKE_VOLUME')
    
    # Specific command strings
    new_content = new_content.replace('bun run demo', 'bun run smoke')
    new_content = new_content.replace('bun demo', 'bun smoke')
    new_content = new_content.replace('bun scripts/demo', 'bun scripts/smoke')
    new_content = new_content.replace('demo:stage', 'smoke:stage')
    new_content = new_content.replace('demo:down', 'smoke:down')
    new_content = new_content.replace('demo:status', 'smoke:status')
    new_content = new_content.replace('demo:clean', 'smoke:clean')
    new_content = new_content.replace('demo:reap', 'smoke:reap')
    
    new_content = new_content.replace('bun run twin', 'bun run smoke:twin')
    new_content = new_content.replace('bun twin', 'bun smoke:twin')
    new_content = new_content.replace('bun scripts/twin', 'bun scripts/smoke-twin')
    new_content = new_content.replace('twin:capture', 'smoke:capture')
    new_content = new_content.replace('twin:rehearse', 'smoke:twin --once')
    new_content = new_content.replace('bun scripts/twin-rehearse.ts', 'bun scripts/smoke-twin-rehearse.ts')
    
    # General source variable naming mapping
    new_content = new_content.replace('demoAttends', 'smokeAttends') # wait, no, contract hasn't changed.
    
    if content != new_content:
        with open(path, 'w') as f:
            f.write(new_content)

def rename_file(old_path, new_path):
    print(f"Renaming {old_path} to {new_path}")
    subprocess.run(["git", "mv", old_path, new_path], check=True)
    # Also update any imports of old_path to new_path across the repo
    old_base = os.path.basename(old_path).replace('.ts', '')
    new_base = os.path.basename(new_path).replace('.ts', '')
    subprocess.run(["find", ".", "-type", "f", "-name", "*.ts", "-o", "-name", "*.json", "-o", "-name", "*.md", "-exec", "sed", "-i", f"s/{old_base}/{new_base}/g", "{}", "+"])

def main():
    # Gather all text files
    for root, dirs, files in os.walk('.'):
        if '.git' in root or 'node_modules' in root: continue
        for file in files:
            if file.endswith(('.ts', '.json', '.md', '.sh', '.yml', '.yaml')):
                replace_in_file(os.path.join(root, file))

    # Rename demo-* and twin-* files
    for root, dirs, files in os.walk('.'):
        if '.git' in root or 'node_modules' in root: continue
        for file in files:
            old_path = os.path.join(root, file)
            if file.startswith('demo-'):
                new_file = file.replace('demo-', 'smoke-')
                rename_file(old_path, os.path.join(root, new_file))
            elif file == 'demo.ts':
                rename_file(old_path, os.path.join(root, 'smoke.ts'))
            elif file.startswith('twin-'):
                new_file = file.replace('twin-', 'smoke-twin-')
                rename_file(old_path, os.path.join(root, new_file))
            elif file == 'twin.ts':
                rename_file(old_path, os.path.join(root, 'smoke-twin.ts'))

if __name__ == "__main__":
    main()
