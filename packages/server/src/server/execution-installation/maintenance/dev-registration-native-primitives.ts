/** Exact read-only Python primitives shared with the reviewed registration program.
 * Data only: importing this module performs no I/O or native execution. */
export const DEV_REGISTRATION_NATIVE_PRIMITIVES = String.raw`def digest(data): return hashlib.sha256(data).hexdigest()
def identity(s): return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
def no_mount(file):
    check(not any(file==root or file.startswith(root.rstrip('/')+'/') for root in request['writableMounts']),'Registration destination is guest mounted')
def protected(file,directory=False):
    no_mount(file)
    current=file
    while True:
        s=os.lstat(current)
        check(os.path.realpath(current)==current and s.st_uid==0 and not s.st_mode&0o022,'Unprotected native registration path')
        check(stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode) or stat.S_ISSOCK(s.st_mode),'Unsupported native registration object')
        parent=os.path.dirname(current)
        if parent==current: break
        current=parent
    if directory: check(stat.S_ISDIR(os.lstat(file).st_mode),'Expected protected directory')
def read(file,limit=268435456):
    fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        before=os.fstat(fd);check(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_size<=limit,'Unsafe source file')
        chunks=[];total=0
        while True:
            chunk=os.read(fd,65536)
            if not chunk: break
            total+=len(chunk);check(total<=limit,'Oversized source file');chunks.append(chunk)
        check(identity(before)==identity(os.fstat(fd))==identity(os.lstat(file)),'Source changed while reading')
        return b''.join(chunks)
    finally: os.close(fd)
def pin(file,protected_path=False):
    if protected_path: protected(file['path'])
    data=read(file['path']);check(len(data)==file['size'] and digest(data)==file['sha256'],'Pinned source changed');return data
def process(pid):
    with open('/proc/'+str(pid)+'/stat') as f: raw=f.read()
    fields=raw[raw.rfind(')')+2:].strip().split();check(fields[0] not in ('Z','T','t','X'),'Process is not running')
    with open('/proc/'+str(pid)+'/status') as f: status=f.read().splitlines()
    def ids(name):
        values=next(line for line in status if line.startswith(name+':')).split()[1:]
        check(len(values)==4 and len(set(values))==1,'Process credentials differ');return int(values[0])
    with open('/proc/'+str(pid)+'/cmdline','rb') as f: argv=[s.decode() for s in f.read(65537).split(b'\0') if s]
    with open('/proc/sys/kernel/random/boot_id') as f: boot=f.read().strip()
    return dict(pid=pid,parentPid=int(fields[1]),uid=ids('Uid'),gid=ids('Gid'),bootId=boot,startIdentity=fields[19],executable=os.path.realpath('/proc/'+str(pid)+'/exe'),argumentsSha256=digest(json.dumps(argv,separators=(',',':'),ensure_ascii=False).encode()))
def protected_record(file):
    protected(file);return json.loads(read(file,65536))
`;
