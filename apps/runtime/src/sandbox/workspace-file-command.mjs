// JSON is transported as base64, never interpolated as shell arguments.
// Filesystem semantics live here; provider APIs remain transport adapters.
export function workspaceFileCommand(name, args, { payloadPath = "", fileRoots = [] } = {}) {
  const payload = Buffer.from(JSON.stringify({ ...args, name, fileRoots })).toString("base64");
  if (payloadPath && !/^\/tmp\/zion-workspace-[a-f0-9-]+\.json$/.test(payloadPath)) {
    throw new Error("Invalid workspace payload path");
  }
  const python = `
import os,json,base64,pathlib,hashlib,re,fnmatch,time,uuid
a=json.loads(${payloadPath
    ? `pathlib.Path('${payloadPath}').read_bytes()`
    : `base64.b64decode('${payload}')`})
raw_roots=[pathlib.Path(r).absolute() for r in a.get('fileRoots',[])]
roots=[root.resolve() for root in raw_roots]
def allowed(path): return not roots or any(path.is_relative_to(root) for root in roots)
raw=pathlib.Path(a.get('path') or '/workspace').absolute()
p=raw.resolve()
if not allowed(p): raise ValueError('file_outside_grant')
name=a['name']
plugin=bool(a.get('_plugin_data'))
MAX_BYTES=4*1024*1024
if plugin and any(part.endswith('.zion-lock') for part in raw.parts):
    raise ValueError('plugin_data_lock_path_reserved')
out={}
def reject_symlinks():
    current=raw
    while True:
        if current.is_symlink(): raise ValueError('plugin_data_symlink_denied')
        if current==current.parent or any(current==root for root in raw_roots): break
        current=current.parent
def load():
    if p.stat().st_size>MAX_BYTES: raise ValueError('file_size_limit')
    with open(p,'r',encoding='utf-8') as f: content=f.read(MAX_BYTES+1)
    if len(content.encode())>MAX_BYTES: raise ValueError('file_size_limit')
    return content
def commit(content):
    if len(content.encode())>MAX_BYTES: raise ValueError('file_size_limit')
    p.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    temporary=p.with_name(p.name+'.zion-'+uuid.uuid4().hex)
    try:
        with open(temporary,'x',encoding='utf-8') as f:
            os.chmod(temporary,(p.stat().st_mode & 0o777) if p.exists() else 0o600)
            f.write(content); f.flush(); os.fsync(f.fileno())
        os.replace(temporary,p)
    finally: temporary.unlink(missing_ok=True)
    d=os.open(p.parent,os.O_RDONLY); os.fsync(d); os.close(d)
if name=='read':
    content=load(); lines=content.splitlines(keepends=True)
    offset=int(a.get('offset') or 0); limit=int(a.get('limit') or 200)
    out={'path':str(p),'content':content if plugin else ''.join(lines[offset:offset+limit]),'content_hash':hashlib.sha256(content.encode()).hexdigest(),'truncated':False if plugin else offset+limit<len(lines)}
elif name in ('write','edit'):
    if plugin: reject_symlinks()
    p.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    lock=pathlib.Path(str(p)+'.zion-lock') if plugin else None
    if lock:
        deadline=time.time()+10
        while True:
            try: lock.mkdir(mode=0o700); break
            except FileExistsError:
                if time.time()>=deadline: raise ValueError('plugin_data_file_locked')
                time.sleep(.025)
    try:
        if plugin: reject_symlinks()
        if p.is_dir(): raise ValueError('file_path_required')
        exists=p.exists()
        current=load() if exists else ''
        actual=hashlib.sha256(current.encode()).hexdigest() if exists else None
        if 'expected_hash' in a and a['expected_hash']!=actual: raise ValueError('content_hash_conflict')
        if a.get('create_only') and exists:
            out={'path':str(p),'content_hash':actual,'written':False,'created':False}
        else:
            if name=='write': content=a['content']
            else:
                if not exists: raise FileNotFoundError(str(p))
                old=a['old_string']; count=current.count(old)
                if not old or count==0: raise ValueError('edit_text_not_found')
                if count>1 and not a.get('replace_all'): raise ValueError('edit_text_ambiguous')
                content=current.replace(old,a['new_string'],-1 if a.get('replace_all') else 1)
            commit(content)
            out={'path':str(p),'content_hash':hashlib.sha256(content.encode()).hexdigest(),'written':True,'created':not exists}
    finally:
        if lock and lock.exists(): lock.rmdir()
elif name=='tree' and plugin and a.get('_plugin_entries'):
    if not p.exists(): raise FileNotFoundError(str(p))
    if not p.is_dir(): raise ValueError('directory_path_required')
    entries=[]
    for q in sorted(p.iterdir(),key=lambda item:item.name):
        if q.is_symlink() or q.name.endswith('.zion-lock'): continue
        resolved=q.resolve()
        if not allowed(resolved): continue
        entries.append({
            'name':q.name,
            'path':str(resolved),
            'type':'directory' if q.is_dir() else 'file'
        })
        if len(entries)>=200: break
    out={'path':str(p),'entries':entries,'truncated':len(entries)>=200}
else:
    files=[]; matches=[]; scanned=0
    pattern=a.get('pattern','*')
    regex=re.compile(pattern,re.I if a.get('i') else 0) if name=='grep' else None
    for base,dirs,names in os.walk(p,followlinks=False):
        dirs[:]=sorted(d for d in dirs if not pathlib.Path(base,d).is_symlink())
        for f in sorted(names):
            if plugin and f.endswith('.zion-lock'): continue
            q=pathlib.Path(base,f); scanned+=1
            if scanned>5000: break
            if q.is_symlink() or not allowed(q.resolve()): continue
            rel=str(q.relative_to(p))
            if name=='glob' and not (fnmatch.fnmatch(rel,pattern) or fnmatch.fnmatch(f,pattern)): continue
            if name=='tree' and len(q.relative_to(p).parts)>int(a.get('max_depth') or 3): continue
            if name=='grep':
                globs=a.get('glob') or []
                if globs and not any(fnmatch.fnmatch(rel,g) or fnmatch.fnmatch(f,g) for g in globs): continue
                if q.stat().st_size>MAX_BYTES: continue
                try:
                    with open(q,'r',encoding='utf-8') as f: text=f.read(MAX_BYTES+1)
                    if len(text.encode())>MAX_BYTES: continue
                except (UnicodeError,OSError): continue
                count=0
                for number,line in enumerate(text.splitlines(),1):
                    if regex.search(line):
                        count+=1
                        if a.get('output_mode') not in ('count','files_with_matches'): matches.append({'path':str(q),'line':number,'text':line[:2000]})
                        if count>=200: break
                if count and a.get('output_mode')=='count': matches.append({'path':str(q),'count':count})
                elif count and a.get('output_mode')=='files_with_matches': matches.append({'path':str(q)})
            else: files.append(str(q))
            if len(files)+len(matches)>=200: break
        if scanned>5000 or len(files)+len(matches)>=200: break
    out={'path':str(p),'files':files,'matches':matches,'truncated':scanned>5000 or len(files)+len(matches)>=200}
print(json.dumps(out,ensure_ascii=False))
`;
  const execute = `python3 -c "$(printf '%s' '${Buffer.from(python).toString("base64")}' | base64 -d)"`;
  return payloadPath
    ? `${execute}; code=$?; rm -f '${payloadPath}'; exit $code`
    : execute;
}
