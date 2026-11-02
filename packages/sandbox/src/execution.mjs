// Each invocation owns a process session. A durable cancel marker also fences a
// launch whose SDK acknowledgement arrives after Runtime has already cancelled.
export function executionIdentity(id) {
  if (!/^[a-f0-9-]{36}$/.test(String(id))) throw new Error("Invalid sandbox execution id");
  return { id, record: `/tmp/zion-execution-${id}.json`, cancel: `/tmp/zion-execution-${id}.cancel` };
}

export function executionCommand(command, execution, { internal = false } = {}) {
  const { id, record, cancel } = executionIdentity(execution.id);
  const python = `
import os,sys,json,pathlib,base64
record=pathlib.Path(${JSON.stringify(record)})
cancel=pathlib.Path(${JSON.stringify(cancel)})
if cancel.exists(): sys.exit(125)
if os.getpgrp()==os.getpid():
    child=os.fork()
    if child:
        _,status=os.waitpid(child,0)
        sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 137)
os.setsid()
pid=os.getpid()
start=pathlib.Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19]
with record.open('x') as f:
    json.dump({'id':${JSON.stringify(id)},'pid':pid,'start':start},f); f.flush(); os.fsync(f.fileno())
if cancel.exists(): sys.exit(125)
os.environ['ZION_EXECUTION_ID']=${JSON.stringify(id)}
os.environ.pop('BASH_ENV',None)
command=base64.b64decode(${JSON.stringify(Buffer.from(command).toString("base64"))}).decode()
os.execve('/bin/bash',${internal ? "['bash','--noprofile','--norc','-c',command]" : "['bash','-l','-c',command]"},os.environ)
`;
  return `exec /usr/bin/python3 -c "$(printf '%s' '${Buffer.from(python).toString("base64")}' | /usr/bin/base64 -d)"`;
}

export function cancelExecutionCommand(execution) {
  const { id, record, cancel } = executionIdentity(execution.id);
  const python = `
import os,json,pathlib,signal,time
record=pathlib.Path(${JSON.stringify(record)})
cancel=pathlib.Path(${JSON.stringify(cancel)})
with cancel.open('a') as f: f.flush(); os.fsync(f.fileno())
token=${JSON.stringify(`ZION_EXECUTION_ID=${id}`)}.encode()
owned=None
if record.exists():
    owned=json.loads(record.read_text())
    if owned.get('id')!=${JSON.stringify(id)}: raise RuntimeError('execution_identity_mismatch')
def processes():
    rows=[]
    for path in pathlib.Path('/proc').iterdir():
        if not path.name.isdigit(): continue
        try:
            stat=(path/'stat').read_text().rsplit(')',1)[1].split()
            if stat[0]=='Z': continue
            try: tagged=token in (path/'environ').read_bytes().split(b'\\0')
            except PermissionError: tagged=False
            rows.append((int(path.name),int(stat[2]),stat[19],tagged))
        except FileNotFoundError: pass
        except ProcessLookupError: pass
        except PermissionError: pass
    return rows
for attempt in range(100):
    rows=processes()
    # A recycled PID/group cannot match the original start time or UUID.
    groups={pid for pid,pgid,start,tag in rows if tag and pid==pgid}
    if owned and any(pid==owned['pid'] and start==owned['start'] for pid,pgid,start,tag in rows):
        groups.add(owned['pid'])
    if owned and any(pgid==owned['pid'] and tag for pid,pgid,start,tag in rows):
        groups.add(owned['pid'])
    targets=[pid for pid,pgid,start,tag in rows if tag or pgid in groups]
    if not targets:
        print(json.dumps({'stopped':True})); break
    for pgid in groups:
        try: os.killpg(pgid,signal.SIGKILL)
        except ProcessLookupError: pass
    for pid in targets:
        try: os.kill(pid,signal.SIGKILL)
        except ProcessLookupError: pass
    time.sleep(0.05)
else: raise RuntimeError('execution_termination_unconfirmed')
`;
  return `/usr/bin/python3 -c "$(printf '%s' '${Buffer.from(python).toString("base64")}' | /usr/bin/base64 -d)"`;
}
