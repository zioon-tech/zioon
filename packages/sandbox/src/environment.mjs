export const SANDBOX_HOME = "/root";
export const PERSISTENT_SANDBOX_HOME = "/workspace/.zion/home";

// Internal file operations must not execute user login scripts or inherit their
// output. /etc/profile reaches this hook before Bash reads the user's profile.
export const SANDBOX_PROFILE_HOOK = `
if [ -n "\${ZION_INTERNAL_COMMAND:-}" ]; then
  exec /usr/bin/python3 -c 'import os,base64; c=base64.b64decode(os.environ.pop("ZION_INTERNAL_COMMAND")).decode(); os.environ.pop("BASH_ENV",None); os.environ["PATH"]="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"; os.execve("/bin/bash",["bash","--noprofile","--norc","-c",c],os.environ)'
fi
export HOME=/root
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_CACHE_HOME="$HOME/.cache"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.bun/bin:$HOME/.local/share/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
if [ ! -f "$HOME/.nvm/nvm.sh" ]; then
  export NPM_CONFIG_PREFIX="$HOME/.local"
fi
`;

const LOGIN_ENV_HOOK = `
# Zion persistent shell environment
if [ -f "$HOME/.config/zion/env.sh" ]; then
  . "$HOME/.config/zion/env.sh"
fi
`;

export function sandboxEnvironmentCommand() {
  const python = `
import os,pathlib,shutil,subprocess,json,uuid
workspace=pathlib.Path('/workspace')
home=workspace/'.zion/home'
root=pathlib.Path('/root')
mounts=[line.split() for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines()]
if not any(row[4]=='/workspace' and row[row.index('-')+1] in ('nfs','nfs4') for row in mounts):
    raise RuntimeError('persistent_workspace_not_mounted')
if not home.resolve().is_relative_to(workspace.resolve()):
    raise RuntimeError('persistent_home_outside_workspace')
marker=workspace/'.zion/home-initialized-v1'
if marker.exists() and not home.is_dir(): raise RuntimeError('persistent_home_missing')
home.mkdir(parents=True,exist_ok=True,mode=0o700)
def durable_write(path,content):
    path=path.resolve()
    temporary=path.with_name(path.name+'.zion-'+uuid.uuid4().hex)
    try:
        with open(temporary,'x') as f:
            os.chmod(temporary,path.stat().st_mode & 0o777 if path.exists() else 0o600)
            f.write(content); f.flush(); os.fsync(f.fileno())
        os.replace(temporary,path)
    finally: temporary.unlink(missing_ok=True)
    d=os.open(path.parent,os.O_RDONLY)
    try: os.fsync(d)
    finally: os.close(d)
def seed(source,target):
    if target.exists() or target.is_symlink():
        if source.is_dir() and not source.is_symlink() and target.is_dir() and not target.is_symlink():
            for child in source.iterdir(): seed(child,target/child.name)
        return
    if source.is_dir() and not source.is_symlink():
        target.mkdir(mode=source.stat().st_mode & 0o777)
        for child in source.iterdir(): seed(child,target/child.name)
    elif source.is_symlink(): target.symlink_to(os.readlink(source))
    elif source.is_file():
        shutil.copy2(source,target)
        with open(target,'rb') as f: os.fsync(f.fileno())
if not marker.exists():
    if not os.path.samefile(root,home):
        for child in root.iterdir(): seed(child,home/child.name)
    # Seed only once: deleted configuration must stay deleted after rebuild.
    durable_write(marker,'1\\n')
if not os.path.samefile(root,home):
    if os.path.ismount(root): raise RuntimeError('unexpected_home_mount')
    subprocess.run(['/bin/mount','--bind',str(home),str(root)],check=True)
if not os.path.samefile(root,home): raise RuntimeError('persistent_home_mount_failed')
for directory in ('.local/bin','.local/share','.config/zion','.cache'):
    (home/directory).mkdir(parents=True,exist_ok=True,mode=0o700)
env=home/'.config/zion/env.sh'
if not env.exists():
    durable_write(env,'# Shared by Bash and Terminal. Add exports and toolchain initialization here.\\n'
      'if [ -f "$HOME/.nvm/nvm.sh" ]; then\\n'
      '  unset NPM_CONFIG_PREFIX\\n'
      '  export NVM_DIR="$HOME/.nvm"\\n'
      '  . "$NVM_DIR/nvm.sh"\\n'
      'fi\\n')
profile=next((home/name for name in ('.bash_profile','.bash_login','.profile') if (home/name).exists()),home/'.profile')
hook=${JSON.stringify(LOGIN_ENV_HOOK)}
content=profile.read_text() if profile.exists() else ''
if hook not in content: durable_write(profile,content+hook)
print(json.dumps({'home':'/root','persistentHome':str(home),'version':1}))
`;
  return `/usr/bin/python3 -c "$(printf '%s' '${Buffer.from(python).toString("base64")}' | /usr/bin/base64 -d)"`;
}
