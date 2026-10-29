#!/usr/bin/env python3
"""Run the private custom-domain gateway natively, outside Docker.

`prepare` stages a gateway beside an existing Docker gateway without starting
anything. `activate` loads its login jobs; run it only in an approved cutover
window after the Docker gateway has stopped, because both would claim the same
tailnet identity. Credentials stay in files and never enter arguments or plists.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

# Source checkouts import the shared helper beside docker/tailscale; prepared deployments carry a copy.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tailscale'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from launch_agent import install, label_for, owned_plist, remove  # noqa: E402

CADDY_LISTEN = '127.0.0.1:8443'
HOSTNAME = re.compile(r'^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$')
NODE_NAME = re.compile(r'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
LOOPBACK = {'127.0.0.1', 'localhost', '::1'}
BINARIES = ('caddy', 'tailscaled', 'tailscale')


def digest(path):
    hasher = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def atomic_write(path, data, mode=0o600):
    descriptor, name = tempfile.mkstemp(dir=path.parent, prefix=path.name + '.')
    try:
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(data)
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def private_dir(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or path.stat().st_uid != os.getuid():
        raise ValueError(f'{path} must be a directory owned by this account')
    path.chmod(0o700)
    return path


def validate_site(site):
    hostname = site.get('hostname', '')
    if not HOSTNAME.match(hostname):
        raise ValueError(f'Invalid public hostname: {hostname!r}')
    if ('redirect' in site) == ('upstream' in site):
        raise ValueError(f'{hostname}: set exactly one of redirect or upstream')
    target = urlsplit(site.get('redirect') or site['upstream'])
    if target.scheme not in ('http', 'https') or not target.hostname or target.username or target.password:
        raise ValueError(f'{hostname}: invalid target URL')
    if 'upstream' in site:
        if target.path not in ('', '/') or target.query or target.fragment:
            raise ValueError(f'{hostname}: upstream must be an origin without a path')
        # Plain HTTP is acceptable only on loopback; anything farther away must verify TLS.
        if target.scheme == 'http' and target.hostname not in LOOPBACK:
            raise ValueError(f'{hostname}: plain HTTP upstreams must be loopback')
        if target.scheme == 'https' and not HOSTNAME.match(site.get('tlsServerName', target.hostname)):
            raise ValueError(f'{hostname}: invalid TLS server name')
        hold = site.get('holdSeconds', 0)
        if not isinstance(hold, int) or not 0 <= hold <= 120:
            raise ValueError(f'{hostname}: holdSeconds must be an integer from 0 to 120')
    return site


def validate_config(config):
    if not NODE_NAME.match(config.get('nodeName', '')):
        raise ValueError('nodeName must be a tailnet machine name')
    sites = config.get('sites')
    if not isinstance(sites, list) or not sites:
        raise ValueError('sites must list at least one site')
    names = [validate_site(site)['hostname'] for site in sites]
    if len(set(names)) != len(names):
        raise ValueError('Duplicate public hostname')
    return config


def caddyfile(config):
    lines = ['{', '\tadmin off', '\tauto_https disable_redirects', '\tservers {', '\t\tprotocols h1 h2', '\t}', '}']
    for site in config['sites']:
        lines += ['', f"https://{site['hostname']}:8443 {{", '\tbind 127.0.0.1', '\ttls {',
                  '\t\tdns cloudflare {env.CF_API_TOKEN}',
                  # Some networks block direct authoritative DNS queries; let the CA validate after propagation.
                  '\t\tpropagation_delay 30s', '\t\tpropagation_timeout -1', '\t}']
        if 'redirect' in site:
            lines.append(f"\tredir {site['redirect']}{{uri}} 302")
        else:
            target = urlsplit(site['upstream'])
            lines += [f"\treverse_proxy {target.scheme}://{target.netloc} {{", '\t\theader_up Host {host}']
            if site.get('holdSeconds'):
                # Hold requests while the upstream restarts instead of failing the page load.
                lines += [f"\t\tlb_try_duration {site['holdSeconds']}s", '\t\tlb_try_interval 250ms']
            if target.scheme == 'https':
                lines += ['\t\ttransport http {', f"\t\t\ttls_server_name {site.get('tlsServerName', target.hostname)}",
                          '\t\t\tdial_timeout 10s', '\t\t\tresponse_header_timeout 30s', '\t\t}']
            lines.append('\t}')
        lines.append('}')
    return '\n'.join(lines) + '\n'


def labels(root):
    return {name: label_for(f'native-gateway-{name}', root) for name in ('caddy', 'tailscaled')}


def job(root, name, label):
    return {
        'Label': label,
        'ProgramArguments': [str(Path(sys.executable).resolve()), '-I', str(root / 'native_gateway.py'),
                             f'run-{name}', '--deployment', str(root)],
        'RunAtLoad': True, 'KeepAlive': True, 'ProcessType': 'Interactive', 'ThrottleInterval': 5,
        'StandardOutPath': str(root / 'logs' / f'{name}.stdout.log'),
        'StandardErrorPath': str(root / 'logs' / f'{name}.stderr.log'),
        'EnvironmentVariables': {'HOME': str(Path.home()), 'PATH': '/usr/bin:/bin'},
    }


def load_record(root):
    record = json.loads((root / 'gateway.json').read_text())
    validate_config(record)
    return record


def verified_binary(root, record, name):
    path = root / 'bin' / name
    if digest(path) != record['binaries'][name]:
        raise ValueError(f'{name} binary does not match its recorded digest')
    return str(path)


def prepare(args):
    root = private_dir(Path(args.deployment).absolute())
    for name in ('bin', 'logs', 'launchd', 'secrets', 'caddy-data', 'caddy-config', 'tailscale-state'):
        private_dir(root / name)
    config = validate_config(json.loads(Path(args.config).read_text()))
    record = {'version': 1, 'nodeName': config['nodeName'], 'sites': config['sites'], 'binaries': {}}
    for name in BINARIES:
        source = Path(getattr(args, name)).resolve(strict=True)
        temporary = root / 'bin' / (name + '.install')
        shutil.copyfile(source, temporary)
        temporary.chmod(0o700)
        os.replace(temporary, root / 'bin' / name)
        record['binaries'][name] = digest(root / 'bin' / name)
    script = root / 'native_gateway.py'
    shutil.copyfile(Path(__file__).resolve(), script.with_suffix('.install'))
    os.replace(script.with_suffix('.install'), script)
    script.chmod(0o700)
    shutil.copyfile(Path(__file__).resolve().parents[2] / 'tailscale' / 'launch_agent.py', root / 'launch_agent.py')
    atomic_write(root / 'Caddyfile', caddyfile(record))
    for name, label in labels(root).items():
        atomic_write(root / 'launchd' / f'{name}.json', json.dumps(job(root, name, label), indent=2) + '\n')
    atomic_write(root / 'gateway.json', json.dumps(record, indent=2) + '\n')
    token = root / 'secrets' / 'cloudflare_dns_token'
    print(json.dumps({'prepared': str(root), 'labels': labels(root), 'tokenPresent': token.is_file(),
                      'started': False}))


def tailscale(root, record, *arguments, run=subprocess.run):
    command = [verified_binary(root, record, 'tailscale'), '--socket', str(root / 'tailscaled.sock'), *arguments]
    return run(command, check=True, capture_output=True, text=True)


def activate(args, run=subprocess.run):
    root = Path(args.deployment).absolute()
    record = load_record(root)
    if not (root / 'secrets' / 'cloudflare_dns_token').is_file():
        raise ValueError('Save the DNS token in secrets/cloudflare_dns_token before activating')
    if not (root / 'tailscale-state' / 'tailscaled.state').is_file() and not args.allow_login:
        raise ValueError('Import the existing gateway node state first, or pass --allow-login for a new node')
    for name in ('tailscaled', 'caddy'):
        content = json.loads((root / 'launchd' / f'{name}.json').read_text())
        install(content, root / 'native_gateway.py', [], run=run)
    if args.allow_login:
        # A new node needs interactive login before it can serve; the owner completes it.
        print(json.dumps({'activated': str(root), 'labels': labels(root), 'next': 'log in, then run activate again'}))
        return
    # The freshly loaded node needs a moment before its socket answers.
    for attempt in range(30):
        try:
            tailscale(root, record, 'serve', '--bg', '--tcp', '443', f'tcp://{CADDY_LISTEN}', run=run)
            break
        except subprocess.CalledProcessError:
            if attempt == 29:
                raise
            time.sleep(1)
    print(json.dumps({'activated': str(root), 'labels': labels(root)}))


def deactivate(args, run=subprocess.run):
    root = Path(args.deployment).absolute()
    for label in labels(root).values():
        remove(label, root / 'native_gateway.py', run=run)
    print(json.dumps({'deactivated': str(root), 'stateRetained': True}))


def status(args):
    root = Path(args.deployment).absolute()
    record = load_record(root)
    jobs = Path.home() / 'Library/LaunchAgents'
    loaded = {}
    for name, label in labels(root).items():
        try:
            loaded[name] = owned_plist(label, root / 'native_gateway.py', jobs) is not None
        except ValueError:
            loaded[name] = 'foreign'
    binaries = {}
    for name in BINARIES:
        try:
            verified_binary(root, record, name)
            binaries[name] = 'verified'
        except (OSError, ValueError) as error:
            binaries[name] = str(error)
    print(json.dumps({'deployment': str(root), 'nodeName': record['nodeName'],
                      'sites': [site['hostname'] for site in record['sites']], 'jobsInstalled': loaded,
                      'binaries': binaries, 'nodeState': (root / 'tailscale-state' / 'tailscaled.state').is_file()}))


def run_caddy(args):
    root = Path(args.deployment).absolute()
    record = load_record(root)
    binary = verified_binary(root, record, 'caddy')
    token = (root / 'secrets' / 'cloudflare_dns_token').read_text().strip()
    if not token:
        raise ValueError('DNS token file is empty')
    environment = {'HOME': str(Path.home()), 'PATH': '/usr/bin:/bin', 'CF_API_TOKEN': token,
                   'XDG_DATA_HOME': str(root / 'caddy-data'), 'XDG_CONFIG_HOME': str(root / 'caddy-config')}
    os.execve(binary, [binary, 'run', '--config', str(root / 'Caddyfile'), '--adapter', 'caddyfile'], environment)


def run_tailscaled(args):
    root = Path(args.deployment).absolute()
    record = load_record(root)
    binary = verified_binary(root, record, 'tailscaled')
    # Userspace networking needs no system extension and leaves the Host's own Tailscale untouched.
    os.execve(binary, [binary, '--tun=userspace-networking', f"--statedir={root / 'tailscale-state'}",
                       f"--socket={root / 'tailscaled.sock'}", '--port=0'],
              {'HOME': str(Path.home()), 'PATH': '/usr/bin:/bin'})


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('prepare', 'activate', 'deactivate', 'status', 'run-caddy', 'run-tailscaled'):
        command = commands.add_parser(name)
        command.add_argument('--deployment', required=True)
        if name == 'prepare':
            command.add_argument('--config', required=True)
            for binary in BINARIES:
                command.add_argument(f'--{binary}', required=True)
        if name == 'activate':
            command.add_argument('--allow-login', action='store_true')
    args = parser.parse_args(argv)
    handlers = {'prepare': prepare, 'activate': activate, 'deactivate': deactivate, 'status': status,
                'run-caddy': run_caddy, 'run-tailscaled': run_tailscaled}
    handlers[args.command](args)


if __name__ == '__main__':
    main()
