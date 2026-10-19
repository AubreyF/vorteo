#!/usr/bin/env python3
"""Install a native preview consumer without changing either agent daemon."""
import argparse
import json
import os
from pathlib import Path
import shutil
import shlex
import sys
import time

from https_broker import NativeRuntime, atomic, digest, safe_dir, safe_read
from launch_agent import install, label_for, owned_plist


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--deployment', required=True)
    parser.add_argument('--daemon-home', required=True)
    parser.add_argument('--node', required=True)
    parser.add_argument('--cli-entry', required=True)
    parser.add_argument('--tailscale', required=True)
    parser.add_argument('--workspace-policy', choices=['registered', 'approved-roots'], default='registered')
    parser.add_argument('--allowed-root', action='append', default=[])
    parser.add_argument('--restore-after-restart', action=argparse.BooleanOptionalAction, default=False)
    args = parser.parse_args()
    if sys.platform != 'darwin':
        raise ValueError('Native previews currently require macOS')
    root = Path(args.deployment).absolute()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.close(safe_dir(root))
    home = Path(args.daemon_home).absolute()
    os.close(safe_dir(home))
    node = str(Path(args.node).resolve(strict=True))
    cli = str(Path(args.cli_entry).resolve(strict=True))
    tailscale = str(Path(args.tailscale).resolve(strict=True))
    bin_dir = Path.home() / '.local/bin'
    launcher = bin_dir / 'paseo-preview'
    ownership = '# Native preview broker: ' + str(root)
    if launcher.is_symlink() or (launcher.exists() and ownership not in launcher.read_text().splitlines()):
        raise ValueError('Existing preview command belongs to another installation')
    channel = Path.home() / '.local/share/paseo-preview/https'
    label = label_for('https-preview-broker', root)
    owned_plist(label, root / 'https_broker.py', Path.home() / 'Library/LaunchAgents')
    previous = safe_read(root / 'host-config.json') if (root / 'host-config.json').exists() else {}
    config = {
        'runtime': 'native', 'deployment': str(root), 'daemonHome': str(home),
        'cliCommand': [node, cli], 'tailscale': tailscale, 'channel': str(channel),
        'brokerLabel': label, 'workspacePolicy': args.workspace_policy,
        'allowedRoots': args.allowed_root, 'approvedWorkspaces': {},
        'reservedPorts': [443, 6767, 6768, 6770, 6771, 44443],
        'portStart': 32768, 'portEnd': 60999,
        'restoreAfterRestart': args.restore_after_restart,
    }
    if args.workspace_policy == 'approved-roots' and not args.allowed_root:
        raise ValueError('Approved-roots policy requires at least one allowed root')
    runtime = NativeRuntime(config)
    workspaces = runtime.cli(['workspace', 'ls'])
    # Native tasks share the user's authority. This is source separation, not a
    # sandbox boundary. A home-directory workspace must not prohibit installing
    # user tools under that same home; specific project roots remain excluded.
    for workspace in workspaces:
        cwd = Path(workspace['cwd']).resolve()
        if root == cwd or (cwd != Path.home() and cwd in root.parents):
            raise ValueError('Install broker outside registered workspace directories')
    runtime.daemon_identity()
    status = json.loads(runtime.ts(['status', '--json']))
    config.update(hostname=status['Self']['DNSName'].rstrip('.'), nodeId=status['Self']['ID'])
    netmap = json.loads(runtime.ts(['debug', 'netmap']))
    config['packetFilterHash'] = digest(netmap.get('PacketFilter'))
    if not any(destination['Ports']['First'] <= config['portStart'] and destination['Ports']['Last'] >= config['portEnd']
               for rule in netmap.get('PacketFilter', []) for destination in rule.get('Dsts', [])):
        raise ValueError('Existing tailnet policy does not cover preview ports; no grants changed')
    runtime.publication()
    for field in ('runtime', 'daemonHome', 'cliCommand', 'tailscale', 'channel', 'nodeId', 'hostname', 'packetFilterHash', 'workspacePolicy', 'allowedRoots'):
        if field in previous and previous[field] != config[field]:
            raise ValueError('Existing native broker identity or policy differs: ' + field)
    if (channel / 'installed.json').exists():
        marker = safe_read(channel / 'installed.json')
        if marker.get('deployment') != str(root):
            raise ValueError('Preview channel already belongs to another broker')
    for name in ('', 'inbox', 'receipts', 'origins'):
        directory = channel / name
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.close(safe_dir(directory))
    config['channelIdentities'] = {name: [os.stat(channel / name).st_dev, os.stat(channel / name).st_ino]
                                   for name in ('', 'inbox', 'receipts', 'origins')}
    source = Path(__file__).resolve().parent
    names = ['https_broker.py', 'host_config.py', 'launch_agent.py', 'https-preview.py',
             'uninstall-https-broker.py', 'paseo-preview.mjs', 'preview-broker-client.mjs']
    backup = root / 'backups' / str(time.time_ns())
    backup.mkdir(parents=True, mode=0o700)
    for name in [*names, 'host-config.json']:
        if (root / name).exists():
            shutil.copy2(root / name, backup / name)
    for name in names:
        temporary = root / (name + '.install')
        shutil.copyfile(source / name, temporary)
        temporary.chmod(0o700)
        os.replace(temporary, root / name)
    atomic(root / 'host-config.json', config)
    helper = [node, str(root / 'paseo-preview.mjs')]
    bin_dir.mkdir(parents=True, exist_ok=True)
    if launcher.exists():
        shutil.copy2(launcher, backup / 'paseo-preview')
    temporary = bin_dir / 'paseo-preview.install'
    temporary.write_text('#!/bin/sh\n' + ownership + '\nexec ' + shlex.join(helper) + ' "$@"\n')
    temporary.chmod(0o700)
    os.replace(temporary, launcher)
    instructions = Path.home() / '.config/paseo-preview/AGENTS.md'
    instructions.parent.mkdir(parents=True, exist_ok=True)
    if instructions.exists():
        shutil.copy2(instructions, backup / 'AGENTS.md')
    shutil.copyfile(source / 'AGENT-INSTRUCTIONS.md', instructions)
    atomic(channel / 'installed.json', {'version': 1, 'deployment': str(root),
           'cliCommand': config['cliCommand'], 'daemonHome': str(home), 'helperCommand': helper})
    (channel / 'disabled.json').unlink(missing_ok=True)
    content = {
        'Label': label, 'ProgramArguments': [str(Path(sys.executable).resolve()), '-I', str(root / 'https_broker.py')],
        'RunAtLoad': True, 'StartInterval': 10, 'ProcessType': 'Background', 'LowPriorityIO': True,
        'StandardOutPath': str(root / 'https-broker.stdout.log'),
        'StandardErrorPath': str(root / 'https-broker.stderr.log'),
        'EnvironmentVariables': {'HOME': str(Path.home()), 'PATH': '/usr/bin:/bin:/usr/local/bin'},
    }
    install(content, root / 'https_broker.py', [])
    print(json.dumps({'installed': str(root), 'helperCommand': helper, 'backup': str(backup),
                      'label': label, 'daemonRestarted': False}))


if __name__ == '__main__':
    main()
