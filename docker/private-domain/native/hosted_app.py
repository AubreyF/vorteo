#!/usr/bin/env python3
"""Serve a trusted web application from a reviewed release on the Host.

The Host must never load code from a folder that container agents can write.
This tool builds a release from one Git commit, keeps live state in a
Host-owned instance directory, and stages a login job without starting it.

Some applications refuse symlinked state, so the instance is one real
directory: release code is synchronised into it, and state paths live beside
that code. Synchronisation never deletes or overwrites a state path.

  build         archive a commit and run its build commands in a new release
  import-state  copy the configured state paths into the instance (cutover); a state
                path with stateSubpaths copies only those live entries
  deploy        synchronise a built release's code into the instance
  stage         write the login job definition without loading it
  activate      load the staged job; refuses without a deployed release and imported state
  deactivate    unload the job, keeping the instance, its state and releases
  status        report releases, the deployed release and the job
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

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tailscale'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from launch_agent import install, label_for, remove  # noqa: E402

NAME = re.compile(r'^[a-z][a-z0-9-]{0,40}$')
COMMIT = re.compile(r'^[0-9a-f]{40}$')
SAFE_RELATIVE = re.compile(r'^(?!/)(?!.*(^|/)\.\.(/|$))[A-Za-z0-9._/@-]+$')


def validate(config):
    if not NAME.match(config.get('name', '')):
        raise ValueError('name must be a short lowercase identifier')
    if not Path(config.get('source', '')).is_absolute():
        raise ValueError('source must be an absolute path to the Git repository')
    subpaths = config.get('stateSubpaths', {})
    if not isinstance(subpaths, dict) or not set(subpaths) <= set(config.get('statePaths', [])):
        raise ValueError('stateSubpaths keys must be state paths')
    for key in ('statePaths', 'stateExcludes'):
        for item in config.get(key, []) + ([part for parts in subpaths.values() for part in parts]
                                           if key == 'stateExcludes' else []):
            if not SAFE_RELATIVE.match(item.rstrip('/*')):
                raise ValueError(f'{key} entries must be relative paths inside the application: {item!r}')
    if not config.get('statePaths'):
        raise ValueError('statePaths must list the live state the application keeps')
    for command in config.get('build', []):
        if not isinstance(command, list) or not command or not all(isinstance(part, str) for part in command):
            raise ValueError('build entries must be argument lists')
    port = config.get('port')
    if not isinstance(port, int) or not 1024 <= port <= 65535:
        raise ValueError('port must be an unprivileged TCP port')
    if not isinstance(config.get('start'), list) or not config['start']:
        raise ValueError('start must be an argument list run with node from the instance directory')
    return config


def load(root):
    return validate(json.loads((root / 'app.json').read_text()))


def private_dir(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or path.stat().st_uid != os.getuid():
        raise ValueError(f'{path} must be a directory owned by this account')
    path.chmod(0o700)
    return path


def state_excludes(config):
    """rsync filters that keep every state path out of code synchronisation."""
    return [f'--exclude=/{item.rstrip("/")}' for item in config['statePaths']]


def run(command, cwd=None, env=None):
    subprocess.run(command, cwd=cwd, env=env, check=True)


def init(args):
    root = private_dir(Path(args.deployment).absolute())
    config = validate(json.loads(Path(args.config).read_text()))
    for name in ('releases', 'instance', 'logs', 'launchd'):
        private_dir(root / name)
    node = Path(args.node).resolve(strict=True)
    record = {**config, 'node': str(node), 'nodeSha256': sha256(node)}
    (root / 'app.json').write_text(json.dumps(record, indent=2) + '\n')
    (root / 'app.json').chmod(0o600)
    print(json.dumps({'initialized': str(root), 'started': False}))


def sha256(path):
    hasher = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def build(args):
    root = Path(args.deployment).absolute()
    config = load(root)
    # Build with the reviewed Node only. Build commands that select another executable
    # themselves are outside this check; review them with the commit.
    if sha256(config['node']) != config['nodeSha256']:
        raise ValueError('Node executable changed since init; review and run init again')
    commit = subprocess.run(['git', '-C', config['source'], 'rev-parse', '--verify', args.commit + '^{commit}'],
                            capture_output=True, text=True, check=True).stdout.strip()
    if not COMMIT.match(commit):
        raise ValueError('Commit did not resolve to a full object name')
    release = root / 'releases' / f'{commit[:12]}-{time.strftime("%Y%m%dT%H%M%S")}'
    staging = Path(tempfile.mkdtemp(dir=root / 'releases', prefix='.build-'))
    try:
        # Only committed content enters a release; uncommitted edits in the checkout never do.
        archive = subprocess.Popen(['git', '-C', config['source'], 'archive', '--format=tar', commit],
                                   stdout=subprocess.PIPE)
        subprocess.run(['tar', '-x', '-C', str(staging)], stdin=archive.stdout, check=True)
        archive.stdout.close()
        if archive.wait() != 0:
            raise RuntimeError('git archive failed')
        for item in config['statePaths']:
            # Tracked files under a state path belong to the instance's state, not to code.
            target = staging / item.rstrip('/')
            if target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            elif target.exists() or target.is_symlink():
                target.unlink()
        # Builds need development dependencies, so NODE_ENV is set only for the running service.
        env = {'HOME': str(Path.home()), 'PATH': f'{Path(config["node"]).parent}:/usr/bin:/bin'}
        for command in config.get('build', []):
            run(['nice', '-n', '10', *command], cwd=staging, env=env)
        manifest = {'commit': commit, 'builtAt': time.time(), 'build': config.get('build', []),
                    'node': config['node'], 'nodeSha256': sha256(config['node'])}
        (staging / '.release.json').write_text(json.dumps(manifest, indent=2) + '\n')
        os.replace(staging, release)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
    print(json.dumps({'release': release.name, 'commit': commit}))


def import_state(args):
    root = Path(args.deployment).absolute()
    config = load(root)
    source = Path(args.source).resolve(strict=True)
    instance = root / 'instance'
    present = [item for item in config['statePaths'] if (instance / item.rstrip('/')).exists()]
    if present and not args.replace:
        raise ValueError('Instance already holds state; pass --replace only during an approved cutover: '
                         + ', '.join(present))
    excludes = [pattern for pattern in config.get('stateExcludes', [])] + list(args.exclude or [])
    copied = []
    for item in config['statePaths']:
        relative = item.rstrip('/')
        origin = source / relative
        if not origin.exists():
            continue
        target = instance / relative
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if target.exists() and args.replace:
            shutil.rmtree(target) if target.is_dir() else target.unlink()
        # rsync keeps modes and times; on APFS the copy is cheap and never touches the source.
        filters = [f'--exclude={pattern[len(relative) + 1:]}' for pattern in excludes
                   if pattern.startswith(relative + '/')]
        only = config.get('stateSubpaths', {}).get(item)
        if origin.is_dir() and only:
            # Copy just the live entries of a folder that also holds scratch; the folder itself
            # stays whole for deploys, so files the application creates later are never deleted.
            target.mkdir(parents=True, exist_ok=True, mode=0o700)
            for part in only:
                if (origin / part).is_dir():
                    run(['rsync', '-a', *filters, f'{origin / part}/', f'{target / part}/'])
                elif (origin / part).exists():
                    run(['rsync', '-a', str(origin / part), str(target / part)])
        elif origin.is_dir():
            run(['rsync', '-a', *filters, f'{origin}/', f'{target}/'])
        else:
            run(['rsync', '-a', str(origin), str(target)])
        copied.append(relative)
    print(json.dumps({'imported': copied, 'from': str(source)}))


def deploy(args):
    root = Path(args.deployment).absolute()
    config = load(root)
    release = (root / 'releases' / args.release).resolve(strict=True)
    if release.parent != (root / 'releases').resolve() or not (release / '.release.json').is_file():
        raise ValueError('Not a built release of this deployment')
    instance = root / 'instance'
    # --delete removes stale code; excluded state paths are neither copied nor deleted.
    run(['rsync', '-a', '--delete', *state_excludes(config), f'{release}/', f'{instance}/'])
    (root / 'deployed.json').write_text(json.dumps({'release': release.name, 'deployedAt': time.time()}) + '\n')
    print(json.dumps({'deployed': release.name}))


def job(root, config):
    label = label_for(f'hosted-app-{config["name"]}', root)
    return {
        'Label': label,
        'ProgramArguments': [config['node'], *config['start']],
        'WorkingDirectory': str(root / 'instance'),
        'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 10, 'ProcessType': 'Interactive',
        'StandardOutPath': str(root / 'logs' / 'app.stdout.log'),
        'StandardErrorPath': str(root / 'logs' / 'app.stderr.log'),
        'EnvironmentVariables': {'HOME': str(Path.home()), 'PATH': '/usr/bin:/bin',
                                 'NODE_ENV': 'production', 'PASEO_PORT': str(config['port']),
                                 **config.get('env', {})},
    }


def stage(args):
    root = Path(args.deployment).absolute()
    config = load(root)
    if sha256(config['node']) != config['nodeSha256']:
        raise ValueError('Node executable changed since init; review and run init again')
    content = job(root, config)
    (root / 'launchd' / 'app.json').write_text(json.dumps(content, indent=2) + '\n')
    print(json.dumps({'staged': content['Label'], 'loaded': False}))


def activate(args, run_launchctl=subprocess.run):
    root = Path(args.deployment).absolute()
    config = load(root)
    if not (root / 'deployed.json').exists():
        raise ValueError('Deploy a release before activating')
    missing = [item for item in config['statePaths'] if not (root / 'instance' / item.rstrip('/')).exists()]
    if missing:
        raise ValueError('Import state before activating; missing: ' + ', '.join(missing))
    if sha256(config['node']) != config['nodeSha256']:
        raise ValueError('Node executable changed since init; review and run init again')
    content = json.loads((root / 'launchd' / 'app.json').read_text())
    install(content, config['start'][0], [], run=run_launchctl)
    print(json.dumps({'activated': content['Label']}))


def deactivate(args, run_launchctl=subprocess.run):
    root = Path(args.deployment).absolute()
    config = load(root)
    remove(job(root, config)['Label'], config['start'][0], run=run_launchctl)
    print(json.dumps({'deactivated': str(root), 'stateRetained': True}))


def status(args):
    root = Path(args.deployment).absolute()
    config = load(root)
    releases = sorted(p.name for p in (root / 'releases').iterdir() if not p.name.startswith('.'))
    deployed = json.loads((root / 'deployed.json').read_text()) if (root / 'deployed.json').exists() else None
    state = {item: (root / 'instance' / item.rstrip('/')).exists() for item in config['statePaths']}
    print(json.dumps({'name': config['name'], 'releases': releases, 'deployed': deployed,
                      'statePresent': state, 'jobStaged': (root / 'launchd' / 'app.json').exists()}))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('init', 'build', 'import-state', 'deploy', 'stage', 'activate', 'deactivate', 'status'):
        command = commands.add_parser(name)
        command.add_argument('--deployment', required=True)
        if name == 'init':
            command.add_argument('--config', required=True)
            command.add_argument('--node', required=True)
        if name == 'build':
            command.add_argument('--commit', required=True)
        if name == 'import-state':
            command.add_argument('--source', required=True)
            command.add_argument('--replace', action='store_true')
            command.add_argument('--exclude', action='append')
        if name == 'deploy':
            command.add_argument('--release', required=True)
    args = parser.parse_args(argv)
    {'init': init, 'build': build, 'import-state': import_state, 'deploy': deploy,
     'stage': stage, 'activate': activate, 'deactivate': deactivate,
     'status': status}[args.command](args)


if __name__ == '__main__':
    main()
