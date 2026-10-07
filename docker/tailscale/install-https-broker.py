#!/usr/bin/env python3
"""Install the narrow broker into an existing deployment, without restarting Vorteo."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from host_config import discover
from launch_agent import install, label_for, owned_plist
from https_broker import Runtime, WS, atomic, digest, safe_dir


def approve_workspaces(config, approvals, workspaces):
    approved = dict(config.get('approvedWorkspaces', {}))
    roots = list(config['allowedRoots'])
    runtime = Runtime(config)
    for approval in approvals:
        workspace, separator, cwd = approval.partition('=')
        if not separator or not WS.fullmatch(workspace):
            raise ValueError('Use --approve-workspace WORKSPACE_ID=/absolute/container/path')
        match = next((w for w in workspaces if w['workspaceId'] == workspace), None)
        if not match or match.get('archivedAt') or match.get('isolation') != 'worktree' or match['cwd'] != cwd:
            raise ValueError('Approval must match an active worktree and its exact path')
        if workspace in approved and approved[workspace] != cwd:
            raise ValueError('Approved workspace moved; review existing policy before replacing it')
        descriptor = safe_dir(runtime.host_workspace(cwd))
        os.close(descriptor)
        approved[workspace] = cwd
        if cwd not in roots:
            roots.append(cwd)
    return {'approvedWorkspaces': approved, 'allowedRoots': roots}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--container', required=True)
    parser.add_argument('--docker', default=shutil.which('docker'))
    parser.add_argument('--context', default='desktop-linux')
    parser.add_argument('--allowed-root', action='append', required=True)
    parser.add_argument('--workspace-policy', choices=['approved-roots', 'registered'],
                        help='registered admits active mounted workspaces without individual grants; omission preserves existing policy')
    parser.add_argument('--approve-workspace', action='append', default=[], metavar='WORKSPACE_ID=PATH')
    parser.add_argument('--reserved-port', type=int, action='append', default=[443, 6767, 6768, 44443])
    parser.add_argument('--rollback')
    parser.add_argument('--restore-after-restart', action=argparse.BooleanOptionalAction, default=None,
                        help='restore previously verified previews after daemon/container restart; omission preserves existing policy')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        raise ValueError('Install on the existing macOS host')
    c, inspected = discover(args.container, args.docker, args.context)
    root = Path(c['deployment'])
    label = label_for('https-preview-broker', root)
    owned_plist(label, root / 'https_broker.py', Path.home() / 'Library/LaunchAgents')
    c['brokerLabel'] = label
    previous = json.loads((root / 'host-config.json').read_text()) if (root / 'host-config.json').exists() else {}
    c = {**previous, **c}
    if args.restore_after_restart is not None:
        c['restoreAfterRestart'] = args.restore_after_restart
    mappings = {m['Destination']: m['Source'] for m in inspected['Mounts'] if m['Type'] == 'bind'}
    for destination, host in previous.get('hostPathMappings', {}).items():
        if mappings.get(destination) != host:
            raise ValueError('Existing host bind mapping changed; review before reinstalling')
    c['hostPathMappings'] = mappings
    source = Path(__file__).resolve().parent
    # Executables, configuration, ledger and lock must not be reachable through any
    # writable agent bind. Protect both direct mounts and ancestor mounts.
    targets = [root / name for name in ['https_broker.py', 'host_config.py', 'launch_agent.py', 'host-config.json', 'https-broker-ledger.json', 'https-broker.lock']]
    targets += [Path(sys.executable).resolve(), Path(c['docker']).resolve()]
    for target in targets:
        for mount in inspected['Mounts']:
            if mount['Type'] == 'bind' and mount['RW']:
                bound = Path(mount['Source']).resolve()
                if target == bound or bound in target.parents:
                    raise ValueError('Trusted broker target is agent writable: ' + str(target))
    for existing in (Path.home() / 'Library/LaunchAgents').glob('*.plist'):
        record = plistlib.loads(existing.read_bytes())
        if str(root / 'host-recovery.py') in record.get('ProgramArguments', []):
            c['recoveryLabel'] = record['Label']
    home = root / 'data/home'
    channel = home / '.local/share/paseo-preview/https'
    if (channel / 'installed.json').exists():
        previous = json.loads((root / 'host-config.json').read_text())
        if previous['allowedRoots'] != args.allowed_root:
            raise ValueError('Policy differs; review explicit policy update before reinstalling')
    c.update(workspacePolicy=args.workspace_policy or previous.get('workspacePolicy', 'approved-roots'),
             allowedRoots=args.allowed_root, reservedPorts=sorted(set(args.reserved_port) | set(previous.get('reservedPorts', []))),
             portStart=32768, portEnd=60999, channel=str(channel), rollback=args.rollback or previous.get('rollback'))
    if args.approve_workspace:
        c.update(approve_workspaces(c, args.approve_workspace, Runtime(c).cli(['workspace', 'ls'])))
    base = [c['docker'], '--context', c['context']]
    ts = base + ['exec', c['container'], '/usr/local/bin/tailscale', '--socket=/run/tailscale/tailscaled.sock']
    status = json.loads(subprocess.check_output(ts + ['status', '--json']))
    c['hostname'] = status['Self']['DNSName'].rstrip('.')
    c['nodeId'] = status['Self']['ID']
    netmap = json.loads(subprocess.check_output(ts + ['debug', 'netmap']))
    c['packetFilterHash'] = digest(netmap.get('PacketFilter'))
    for field in ('packetFilterHash', 'nodeId', 'hostname'):
        if previous.get(field) and previous[field] != c[field]:
            raise ValueError('Existing network identity or access scope changed; review before reinstalling')
    # Installation does not change grants. The operator reviews this non-secret
    # policy hash against the existing destination range before installation.
    rules = netmap.get('PacketFilter', [])
    if not any(d['Ports']['First'] <= c['portStart'] and d['Ports']['Last'] >= c['portEnd'] for r in rules for d in r.get('Dsts', [])):
        raise ValueError('Existing tailnet access does not cover the preview range')
    for name in ['', 'inbox', 'receipts', 'origins']:
        path = channel / name
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        if path.is_symlink() or path.resolve() != path.absolute():
            raise ValueError('Unsafe request channel')
    c['channelIdentities'] = {name: [os.stat(channel / name).st_dev, os.stat(channel / name).st_ino] for name in ['', 'inbox', 'receipts', 'origins']}
    backup = root / 'backups' / ('https-broker-' + str(__import__('time').time_ns()))
    backup.mkdir(parents=True, mode=0o700)
    for name in ['host-config.json', 'https_broker.py', 'host_config.py', 'launch_agent.py', 'host-recovery.py', 'https-preview.py']:
        if (root / name).exists():
            shutil.copy2(root / name, backup / name)
    for name in ['https_broker.py', 'host_config.py', 'launch_agent.py', 'https-preview.py', 'host-recovery.py', 'uninstall-https-broker.py']:
        temp = root / (name + '.install')
        shutil.copyfile(source / name, temp)
        temp.chmod(0o700)
        os.replace(temp, root / name)
    atomic(root / 'host-config.json', c)
    bin_dir = home / '.local/bin'
    bin_dir.mkdir(parents=True, exist_ok=True)
    for source_name, dest_name in [('paseo-preview.mjs', 'paseo-preview'), ('preview-broker-client.mjs', 'preview-broker-client.mjs')]:
        dest = bin_dir / dest_name
        if dest.exists():
            shutil.copy2(dest, backup / dest_name)
        temp = bin_dir / (dest_name + '.install')
        shutil.copyfile(source / source_name, temp)
        temp.chmod(0o755)
        os.replace(temp, dest)
    instructions = home / '.config/paseo-preview/AGENTS.md'
    if instructions.exists():
        shutil.copy2(instructions, backup / 'AGENTS.md')
    instructions.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source / 'AGENT-INSTRUCTIONS.md', instructions)
    atomic(channel / 'installed.json', {'version': 1})
    (channel / 'disabled.json').unlink(missing_ok=True)
    # Match ownership already used by persistent home, through the container's UID
    # mapping. No new capability or privileged socket is exposed.
    subprocess.run(base + ['exec', c['container'], '/bin/chown', '-R', 'paseo:paseo', '/home/paseo/.local/share/paseo-preview/https'], check=True)
    content = {'Label': label, 'ProgramArguments': [str(Path(sys.executable).resolve()), '-I', str(root / 'https_broker.py')],
               'RunAtLoad': True, 'StartInterval': 10, 'ProcessType': 'Background', 'LowPriorityIO': True,
               'StandardOutPath': str(root / 'https-broker.stdout.log'), 'StandardErrorPath': str(root / 'https-broker.stderr.log'),
               'EnvironmentVariables': {'HOME': str(Path.home()), 'PATH': '/usr/bin:/bin:/usr/local/bin'}}
    # COMPAT(shared-broker-label): added in v0.7.2, remove after 2027-03-16.
    install(content, root / 'https_broker.py', ['local.paseo.https-preview-broker'])
    print(json.dumps({'installed': str(root), 'backup': str(backup), 'label': label, 'containerRestarted': False}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error) if isinstance(error, ValueError) else type(error).__name__)
