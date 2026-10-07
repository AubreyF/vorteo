#!/usr/bin/env python3
"""Bounded host consumer. Requests are data; all host commands are fixed argv."""
import fcntl
import hashlib
from itertools import islice
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import uuid
sys.path.insert(0, str(Path(__file__).resolve().parent))
from host_config import load

MAX_BYTES = 4096
ID = re.compile(r'^[a-f0-9-]{36}$')
WS = re.compile(r'^wks_[a-zA-Z0-9_-]{1,80}$')
SERVICE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def safe_read(path, limit=65536):
    # Reject symlinks in every component, not only the leaf.
    path = Path(path).absolute()
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:-1]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        leaf = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            info = os.fstat(leaf)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
                raise ValueError('Unsafe file or size bound exceeded')
            data = os.read(leaf, limit + 1)
            if len(data) > limit:
                raise ValueError('Size bound exceeded')
            return json.loads(data)
        finally:
            os.close(leaf)
    finally:
        os.close(fd)


def safe_dir(path):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in Path(path).absolute().parts[1:]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except Exception:
        os.close(fd)
        raise


def atomic(path, value, mode=0o600):
    path = Path(path)
    fd = safe_dir(path.parent)
    name = '.' + str(uuid.uuid4())
    try:
        out = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=fd)
        with os.fdopen(out, 'w') as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.rename(name, path.name, src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        try:
            os.unlink(name, dir_fd=fd)
        except FileNotFoundError:
            pass
        os.close(fd)


def validate(request, now):
    if not isinstance(request, dict) or set(request) - {'id', 'operation', 'workspaceId', 'service', 'preferredPort', 'createdAt'}:
        raise ValueError('Unsupported request fields')
    if not ID.fullmatch(str(request.get('id', ''))) or not WS.fullmatch(str(request.get('workspaceId', ''))) or not SERVICE.fullmatch(str(request.get('service', ''))):
        raise ValueError('Invalid request identity')
    if request.get('operation') not in ('start', 'restart', 'stop', 'status'):
        raise ValueError('Unsupported lifecycle operation')
    created = request.get('createdAt')
    if type(created) not in (float, int) or not now - 120 <= created <= now + 5:
        raise ValueError('Request expired or clock differs')
    port = request.get('preferredPort')
    if port is not None and (type(port) is not int or not 32768 <= port <= 60999):
        raise ValueError('Invalid preferred frontend port')
    return request


class RecoveryPending(RuntimeError):
    """Recovery can be retried without discarding the owner's running intent."""


class Runtime:
    def __init__(self, config):
        self.c = config
        self.base = [config['docker'], '--context', config['context']]

    def command(self, args, timeout=12):
        result = subprocess.run(args, capture_output=True, timeout=timeout, check=True,
                                env={'PATH': '/usr/bin:/bin:/usr/local/bin', 'HOME': str(Path.home())})
        if len(result.stdout) > 4 * 1024 * 1024:
            raise ValueError('Runtime response too large')
        return result.stdout.decode()

    def docker(self, args):
        return self.command(self.base + args)

    def cli(self, args):
        # Never run an agent-writable helper as administrator. Only the installed CLI,
        # with privileges removed, talks to the current daemon.
        return json.loads(self.docker(['exec', self.c['container'], '/usr/bin/setpriv', '--reuid=paseo', '--regid=paseo', '--init-groups', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '/usr/local/bin/paseo', *args, '--json']))

    def ts(self, args):
        return self.docker(['exec', self.c['container'], '/usr/local/bin/tailscale', '--socket=/run/tailscale/tailscaled.sock', *args])

    def daemon_identity(self):
        # A PID alone can be reused, including across a container restart.
        code = r"""
const fs=require('node:fs');const path=require('node:path');const found=[];
const home=process.env.PASEO_HOME||path.join(require('node:os').homedir(),'.paseo');
const owner=JSON.parse(fs.readFileSync(path.join(home,'paseo.pid'),'utf8')).pid;
if(!Number.isSafeInteger(owner)||owner<=0)process.exit(1);
const boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
for(const pid of fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p))){
  try{
    const status=fs.readFileSync(`/proc/${pid}/status`,'utf8');
    if(!/^Name:\s+Paseo Daemon$/m.test(status))continue;
    const parent=Number(status.match(/^PPid:\s+(\d+)$/m)?.[1]);
    if(Number(pid)!==owner&&parent!==owner)continue;
    const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');
    found.push(`${boot}:${pid}:${stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]}`);
  }catch(e){if(!['ENOENT','EACCES','ESRCH'].includes(e.code))throw e;}
}
if(found.length!==1)process.exit(1);
process.stdout.write(found[0]);
"""
        return self.docker(['exec', '--user', 'paseo', self.c['container'], '/usr/local/bin/node', '-e', code]).strip()

    def preflight(self):
        status = json.loads(self.ts(['status', '--json']))
        if status['Self']['ID'] != self.c['nodeId'] or status['Self']['DNSName'].rstrip('.') != self.c['hostname']:
            raise ValueError('Tailscale identity changed; administrator review required')
        netmap = json.loads(self.ts(['debug', 'netmap']))
        if digest(netmap.get('PacketFilter')) != self.c['packetFilterHash']:
            raise ValueError('Tailnet access scope changed; administrator review required')
        self.publication()

    def publication(self):
        value = json.loads(self.ts(['serve', 'status', '--json']))
        if any(value.get('AllowFunnel', {}).values()):
            raise ValueError('Unexpected Funnel state; administrator review required')
        return value

    def host_workspace(self, cwd):
        path = Path(cwd)
        if not path.is_absolute() or '..' in path.parts:
            raise ValueError('Invalid container workspace path')
        mappings = dict(self.c.get('hostPathMappings', {}))
        mappings['/home/paseo'] = str(Path(self.c['deployment']) / 'data/home')
        for container_root in sorted(mappings, key=len, reverse=True):
            host_root = Path(mappings[container_root])
            if not host_root.is_absolute() or '..' in host_root.parts:
                raise ValueError('Invalid administrator host mapping')
            if cwd == container_root or cwd.startswith(container_root.rstrip('/') + '/'):
                return host_root / path.relative_to(container_root)
        if 'hostPathMappings' not in self.c:
            return path
        raise ValueError('Workspace has no verified host bind mapping')

    def workspace_path_allowed(self, cwd):
        policy = self.c.get('workspacePolicy', 'approved-roots')
        if policy == 'registered':
            # Registration replaces per-directory grants, never host mount verification.
            if 'hostPathMappings' not in self.c:
                raise ValueError('Registered workspace policy requires verified host bind mappings')
            return True
        if policy != 'approved-roots':
            raise ValueError('Unsupported workspace policy')
        return any(cwd == root or cwd.startswith(root.rstrip('/') + '/') for root in self.c['allowedRoots'])

    def current(self, workspace, service):
        workspaces = self.cli(['workspace', 'ls'])
        match = next((w for w in workspaces if w['workspaceId'] == workspace), None)
        if not match or match.get('archivedAt') or match.get('isolation') not in ('local', 'worktree'):
            raise ValueError('Unknown, archived or unsupported workspace')
        cwd = match['cwd']
        if not self.workspace_path_allowed(cwd):
            raise ValueError('Workspace is outside administrator policy')
        approved = self.c.get('approvedWorkspaces', {})
        if workspace in approved and approved[workspace] != cwd:
            raise ValueError('Approved workspace moved')
        if self.c.get('workspacePolicy', 'approved-roots') != 'registered' and match['isolation'] == 'worktree' and approved.get(workspace) != cwd:
            raise ValueError('Worktree requires explicit administrator approval')
        path = self.host_workspace(cwd)
        cfg = safe_read(path / 'paseo.json')
        definition = cfg.get('scripts', {}).get(service)
        scripts = self.cli(['script', 'ls', '--workspace', workspace])
        entry = next((s for s in scripts if s['scriptName'] == service), None)
        if not entry or entry['type'] != 'service' or not isinstance(definition, dict) or definition.get('type') != 'service':
            raise ValueError('Unknown registered service')
        return {**entry, 'cwd': cwd, 'fingerprint': digest(definition), 'workspaceId': workspace, 'service': service}

    def registered_ports(self):
        ports = set()
        seen = set()
        for workspace in self.cli(['workspace', 'ls'])[:256]:
            cwd = workspace['cwd']
            if cwd in seen:
                continue
            seen.add(cwd)
            if not self.workspace_path_allowed(cwd):
                continue
            path = self.host_workspace(cwd)
            try:
                cfg = safe_read(path / 'paseo.json')
            except FileNotFoundError:
                continue
            for definition in cfg.get('scripts', {}).values():
                if isinstance(definition, dict) and definition.get('type') == 'service' and type(definition.get('port')) is int:
                    ports.add(definition['port'])
        return ports

    def lifecycle(self, operation, entry):
        return self.cli(['script', operation, entry['service'], '--workspace', entry['workspaceId']])

    def listener_identity(self, port, terminal):
        # Prove that the loopback listener belongs to the managed terminal, not
        # merely that some HTTP process has reused a formerly allocated port.
        code = r"""
const fs=require('node:fs');const port=Number(process.argv[1]);const terminal=process.argv[2];
const sockets=fs.readFileSync('/proc/net/tcp','utf8').trim().split('\n').slice(1).map(l=>l.trim().split(/\s+/)).filter(a=>a[3]==='0A'&&parseInt(a[1].split(':')[1],16)===port&&['0100007F','00000000'].includes(a[1].split(':')[0])).map(a=>'socket:['+a[9]+']');
const found=[];const boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
for(const pid of fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p)).slice(0,8192))try{
 const fds=fs.readdirSync('/proc/'+pid+'/fd');
 if(!fds.some(fd=>{try{return sockets.includes(fs.readlinkSync('/proc/'+pid+'/fd/'+fd))}catch{return false}}))continue;
 const env=fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\0');
 if(!env.includes('PASEO_TERMINAL_ID='+terminal))throw Error('Listener is not owned by the managed terminal');
 const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');found.push(boot+':'+pid+':'+stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]);
}catch(e){if(e.message==='Listener is not owned by the managed terminal')throw e;}
if(found.length!==1)throw Error('Expected exactly one managed loopback listener');console.log(found[0]);
"""
        return self.docker(['exec', '--user', 'paseo', self.c['container'], '/usr/local/bin/node', '-e', code, str(port), terminal]).strip()

    def backend_ready(self, port):
        # Fixed program, numeric argument only. Loopback is the only target.
        code = "fetch('http://127.0.0.1:'+process.argv[1]+'/',{signal:AbortSignal.timeout(2500),redirect:'manual'}).then(r=>{process.exit(r.status>=200&&r.status<400?0:1)}).catch(()=>process.exit(1))"
        self.docker(['exec', '--user', 'paseo', self.c['container'], '/usr/local/bin/node', '-e', code, str(port)])

    def free(self, port):
        code = "const s=require('node:net').createServer();s.on('error',()=>process.exit(1));s.listen(Number(process.argv[1]),'0.0.0.0',()=>s.close());"
        self.docker(['exec', '--user', 'paseo', self.c['container'], '/usr/local/bin/node', '-e', code, str(port)])

    def set_mapping(self, port, backend):
        self.ts(['serve', '--bg', f'--https={port}', f'http://127.0.0.1:{backend}'])

    def remove_mapping(self, port):
        self.ts(['serve', f'--https={port}', 'off'])

    def verify(self, url):
        self.command(['/usr/bin/curl', '--fail', '--silent', '--show-error', '--max-time', '8', '--output', '/dev/null', url])


class Broker:
    def __init__(self, config, runtime=None):
        self.c = config
        self.root = Path(config['deployment'])
        self.runtime = runtime or Runtime(config)
        self.ledger_path = self.root / 'https-broker-ledger.json'
        self.channel = Path(config['channel'])
        self.ledger = safe_read(self.ledger_path, 2 * 1024 * 1024) if self.ledger_path.exists() else {'entries': {}, 'requests': {}}

    def save(self):
        atomic(self.ledger_path, self.ledger)

    def key(self, r):
        return r['workspaceId'] + '.' + r['service']

    def route(self, entry):
        return {'Handlers': {'/': {'Proxy': f"http://127.0.0.1:{entry['backend']}"}}}

    def address(self, entry):
        return f"{self.c['hostname']}:{entry['frontend']}"

    def remove(self, entry):
        config = self.runtime.publication()
        address = self.address(entry)
        web = config.get('Web', {}).get(address)
        tcp = config.get('TCP', {}).get(str(entry['frontend']))
        if web is None and tcp is None:
            return
        if web != self.route(entry) or tcp != {'HTTPS': True}:
            raise ValueError('Owned mapping changed externally; no mutation performed')
        self.runtime.remove_mapping(entry['frontend'])
        after = self.runtime.publication()
        if address in after.get('Web', {}) or str(entry['frontend']) in after.get('TCP', {}):
            raise ValueError('Mapping removal not confirmed')

    def reserve(self, r, current):
        key = self.key(r)
        existing = self.ledger['entries'].get(key)
        config = self.runtime.publication()  # Funnel check BEFORE every mutation/adoption.
        if existing:
            if r.get('preferredPort', existing['frontend']) != existing['frontend']:
                raise ValueError('Stable reservation differs from requested origin')
            if existing['cwd'] != current['cwd']:
                raise ValueError('Workspace moved; administrator review required')
            return existing
        if len(self.ledger['entries']) >= 32:
            raise ValueError('Reservation limit reached; administrator review required')
        allocated = {e['frontend'] for e in self.ledger['entries'].values() if 'frontend' in e}
        forbidden = set(self.c['reservedPorts']) | allocated | {current.get('port')} | self.runtime.registered_ports()
        ports = [r['preferredPort']] if 'preferredPort' in r else range(self.c['portStart'], self.c['portEnd'] + 1)
        for port in ports:
            if not self.c['portStart'] <= port <= self.c['portEnd'] or port in forbidden or str(port) in config.get('TCP', {}):
                continue
            if any(address.endswith(':' + str(port)) for address in config.get('Web', {})):
                continue
            try:
                self.runtime.free(port)
            except subprocess.SubprocessError:
                continue
            entry = {'workspaceId': r['workspaceId'], 'service': r['service'], 'frontend': port, 'cwd': current['cwd'], 'fingerprint': current['fingerprint'], 'desired': 'stopped', 'stoppedAt': 0}
            self.ledger['entries'][key] = entry
            self.save()
            return entry
        raise ValueError('Requested HTTPS port is reserved, occupied or outside policy')

    def activate(self, entry):
        daemon = self.runtime.daemon_identity() if self.c.get('restoreAfterRestart') else None
        current = self.runtime.current(entry['workspaceId'], entry['service'])
        if current['cwd'] != entry['cwd'] or current['fingerprint'] != entry['fingerprint']:
            raise ValueError('Service configuration identity changed')
        port = current.get('port')
        if current.get('lifecycle') != 'running' or not current.get('terminalId'):
            raise ValueError('Managed service stopped; explicit start required')
        if type(port) is not int or not 32768 <= port <= 60999 or port in self.c['reservedPorts'] or any(e.get('frontend') == port for e in self.ledger['entries'].values()):
            raise ValueError('Backend allocation conflicts with control plane or frontend')
        if entry.get('terminal') and (entry['terminal'] != current['terminalId'] or entry.get('backend') != port):
            raise ValueError('Service process identity changed; explicit start required')
        entry.update(backend=port, terminal=current['terminalId'])
        self.save()
        self.runtime.backend_ready(port)
        listener = self.runtime.listener_identity(port, current['terminalId'])
        if entry.get('listener') and entry['listener'] != listener:
            raise ValueError('Backend listener process changed; explicit start required')
        entry['listener'] = listener
        self.save()
        before = self.runtime.publication()
        address = self.address(entry)
        web = before.get('Web', {}).get(address)
        tcp = before.get('TCP', {}).get(str(entry['frontend']))
        if web is not None or tcp is not None:
            if web != self.route(entry) or tcp != {'HTTPS': True}:
                raise ValueError('Publication conflict; unrelated mapping preserved')
        else:
            self.runtime.free(entry['frontend'])
            # Ownership is persisted before mutation so a crash is recoverable.
            entry['mappingIntent'] = True
            self.save()
            self.runtime.set_mapping(entry['frontend'], port)
        after = self.runtime.publication()
        if after.get('Web', {}).get(address) != self.route(entry) or after.get('TCP', {}).get(str(entry['frontend'])) != {'HTTPS': True}:
            raise ValueError('HTTPS mapping verification failed')
        url = f'https://{address}/'
        self.runtime.verify(url)
        again = self.runtime.current(entry['workspaceId'], entry['service'])
        if (again['fingerprint'], again.get('terminalId'), again.get('port'), again.get('lifecycle')) != (entry['fingerprint'], entry['terminal'], port, 'running'):
            raise ValueError('Service changed during verification')
        if daemon is not None:
            if self.runtime.daemon_identity() != daemon:
                self.remove(entry)
                raise RecoveryPending('Daemon changed during verification')
            entry['daemon'] = daemon
            entry.pop('recovery', None)
        entry.pop('error', None)
        entry.update(status='ready', url=url)
        self.save()
        return {'status': 'ready', 'url': url, 'frontendPort': entry['frontend'], 'backendPort': port}

    def restore_after_restart(self, entry):
        if not self.c.get('restoreAfterRestart') or not entry.get('daemon'):
            return
        daemon = self.runtime.daemon_identity()
        if daemon == entry['daemon']:
            return
        current = self.runtime.current(entry['workspaceId'], entry['service'])
        if current['cwd'] != entry['cwd'] or current['fingerprint'] != entry['fingerprint']:
            raise ValueError('Service configuration identity changed')
        recovery = entry.get('recovery', {})
        if recovery.get('daemon') != daemon:
            recovery = {'daemon': daemon, 'attempts': 0, 'retryAt': 0}
        if current['lifecycle'] == 'running':
            if not recovery.get('terminal') or current.get('terminalId') != recovery['terminal']:
                raise ValueError('Unrecognized service after daemon restart; explicit start required')
            return
        # Remove the stale route before allowing the daemon to allocate a new backend.
        self.remove(entry)
        if recovery['attempts'] >= 3:
            raise RecoveryPending('Recovery failed three times; explicit start required')
        if time.time() < recovery['retryAt']:
            raise RecoveryPending('Waiting before retrying preview recovery')
        recovery.update(attempts=recovery['attempts'] + 1, retryAt=time.time() + 30 * (2 ** recovery['attempts']))
        entry.update(recovery=recovery, status='pending')
        entry.pop('url', None)
        self.save()
        atomic(self.channel / 'origins' / (self.key(entry) + '.json'),
               {'origin': f'https://{self.address(entry)}', 'workspaceId': entry['workspaceId'], 'service': entry['service']}, mode=0o644)
        started = self.runtime.lifecycle('start', current)
        if self.runtime.daemon_identity() != daemon:
            raise RecoveryPending('Daemon changed while starting preview')
        terminal = started.get('terminalId')
        if not terminal or started.get('lifecycle') != 'running':
            raise RecoveryPending('Preview start did not return a running terminal')
        # Only the acknowledged managed start may replace the old process identity.
        recovery['terminal'] = terminal
        entry.update(terminal=terminal, backend=started['port'])
        entry.pop('listener', None)
        self.save()

    def handle(self, r):
        now = time.time()
        validate(r, now)
        key = self.key(r)
        entry = self.ledger['entries'].get(key)
        if entry and r['operation'] in ('start', 'restart') and r['createdAt'] <= entry.get('stoppedAt', 0):
            raise ValueError('Start predates explicit stop; submit a new request')
        if r['operation'] == 'status':
            if not entry:
                return {'status': 'failed', 'error': 'No HTTPS reservation'}
            if entry['desired'] == 'stopped':
                return {'status': 'stopped', 'frontendPort': entry.get('frontend')}
            try:
                return self.activate(entry)
            except Exception:
                if entry.get('backend'):
                    self.remove(entry)
                raise
        if r['operation'] == 'stop':
            if not entry:
                current = self.runtime.current(r['workspaceId'], r['service'])
                entry = {'workspaceId': r['workspaceId'], 'service': r['service'], 'cwd': current['cwd']}
                # A stop without a reservation still needs a durable replay barrier.
                self.ledger['entries'][key] = entry
            entry.update(desired='stopped', status='stopped', stoppedAt=now)
            entry.pop('url', None)
            self.save()
            if entry.get('backend'):
                self.remove(entry)
            current = self.runtime.current(r['workspaceId'], r['service'])
            if current['lifecycle'] == 'running':
                self.runtime.lifecycle('stop', current)
            return {'status': 'stopped'}
        current = self.runtime.current(r['workspaceId'], r['service'])
        if entry and 'frontend' not in entry:
            del self.ledger['entries'][key]
            entry = None
        entry = self.reserve(r, current)
        if r['operation'] == 'start' and current['lifecycle'] == 'running' and entry['fingerprint'] != current['fingerprint']:
            if entry.get('backend'):
                self.remove(entry)
            raise ValueError('Running service configuration changed; use explicit restart')
        if entry.get('backend') and (r['operation'] == 'restart' or entry.get('fingerprint') != current['fingerprint'] or entry.get('terminal') != current.get('terminalId')):
            self.remove(entry)
            entry.pop('terminal', None)
            entry.pop('listener', None)
        if r['operation'] == 'restart' and current['lifecycle'] == 'running':
            self.runtime.lifecycle('stop', current)
            current = self.runtime.current(r['workspaceId'], r['service'])
        entry.update(desired='running', status='pending', fingerprint=current['fingerprint'])
        entry.pop('recovery', None)
        self.save()
        # This is startup configuration, not a verified browser link.
        atomic(self.channel / 'origins' / (key + '.json'), {'origin': f'https://{self.address(entry)}', 'workspaceId': r['workspaceId'], 'service': r['service']}, mode=0o644)
        if current['lifecycle'] != 'running':
            self.runtime.lifecycle('start', current)
            entry.pop('terminal', None)
            entry.pop('listener', None)
        try:
            return self.activate(entry)
        except subprocess.SubprocessError:
            if entry.get('mappingIntent'):
                self.remove(entry)
            entry.update(status='pending')
            self.save()
            return {'status': 'pending', 'message': 'Backend or HTTPS is not ready; inspect status', 'frontendPort': entry['frontend']}

    def reconcile(self):
        deadline = time.monotonic() + 20
        entries = list(self.ledger['entries'].values())[:32]
        if not entries:
            return
        cursor = self.ledger.get('reconcileCursor', 0) % len(entries)
        for index in range(len(entries)):
            if time.monotonic() > deadline:
                break
            entry = entries[(cursor + index) % len(entries)]
            self.ledger['reconcileCursor'] = (cursor + index + 1) % len(entries)
            self.save()
            if not entry.get('backend'):
                continue
            try:
                if entry['desired'] == 'stopped':
                    self.remove(entry)
                    continue
                self.restore_after_restart(entry)
                self.activate(entry)
            except Exception as error:
                # Fail closed on process/config changes. Never revive a stopped service.
                if isinstance(error, ValueError):
                    entry.update(desired='stopped', stoppedAt=time.time())
                entry.update(status='pending' if isinstance(error, RecoveryPending) else 'failed',
                             error=str(error) if isinstance(error, (ValueError, RecoveryPending)) else type(error).__name__)
                entry.pop('url', None)
                try:
                    self.remove(entry)
                except Exception:
                    entry['error'] = 'Mapping removal requires administrator review'
                self.save()

    def run(self):
        # The entire channel must still be the installation's original directories.
        for name, identity in self.c['channelIdentities'].items():
            path = self.channel / name
            info = path.lstat()
            if not stat.S_ISDIR(info.st_mode) or [info.st_dev, info.st_ino] != identity or path.resolve() != path.absolute():
                raise ValueError('Request channel replaced; administrator review required')
        self.runtime.preflight()
        with (self.root / 'https-broker.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            # Reload inside the lock to serialize concurrent consumers.
            if self.ledger_path.exists():
                self.ledger = safe_read(self.ledger_path, 2 * 1024 * 1024)
            requests = []
            for path in islice((self.channel / 'inbox').iterdir(), 128):
                if not ID.fullmatch(path.stem) or path.suffix != '.json':
                    continue
                try:
                    r = safe_read(path, MAX_BYTES)
                    validate(r, time.time())
                    if r['id'] != path.stem:
                        raise ValueError('Filename identity mismatch')
                    requests.append((path, r))
                except (ValueError, OSError):
                    atomic(self.channel / 'receipts' / path.name, {'status': 'failed', 'error': 'Invalid, unsafe or expired request'}, mode=0o644)
                    path.unlink(missing_ok=True)
            requests.sort(key=lambda item: (item[1]['operation'] != 'stop', item[1]['createdAt']))
            deadline = time.monotonic() + 40
            for path, r in requests[:16]:
                if time.monotonic() > deadline:
                    break
                old = self.ledger['requests'].get(r['id'])
                if old:
                    result = {'status': 'failed', 'error': 'Request already consumed; submit status with a new ID'}
                else:
                    # Journal before action. Crash leaves an indeterminate request that must
                    # be inspected, never replayed as a fresh start.
                    self.ledger['requests'][r['id']] = time.time()
                    self.save()
                    try:
                        result = self.handle(r)
                    except Exception as error:
                        result = {'status': 'failed', 'error': str(error) if isinstance(error, ValueError) else type(error).__name__}
                atomic(self.channel / 'receipts' / path.name, {'id': r['id'], **result}, mode=0o644)
                path.unlink(missing_ok=True)
            self.ledger['requests'] = {k: v for k, v in self.ledger['requests'].items() if v > time.time() - 600}
            self.save()
            for receipt in islice((self.channel / 'receipts').iterdir(), 128):
                if ID.fullmatch(receipt.stem) and receipt.suffix == '.json' and receipt.lstat().st_mtime < time.time() - 86400:
                    receipt.unlink(missing_ok=True)
            if time.monotonic() < deadline:
                self.reconcile()


if __name__ == '__main__':
    try:
        Broker(load()).run()
    except BlockingIOError:
        pass
    except Exception as error:
        print('HTTPS broker check failed: ' + (str(error) if isinstance(error, ValueError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
