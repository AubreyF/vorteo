"""Non-secret host settings shared by recovery, installer and HTTPS broker."""
import json
import os
from pathlib import Path
import subprocess


def load(path=None):
    path = Path(path or os.environ.get('PASEO_HOST_CONFIG', Path(__file__).with_name('host-config.json')))
    if path.is_file():
        value = json.loads(path.read_text())
    else:
        names = {'deployment': 'PASEO_DEPLOYMENT_DIR', 'container': 'PASEO_CONTAINER_NAME',
                 'rollback': 'PASEO_ROLLBACK_CONTAINER_NAME', 'docker': 'PASEO_DOCKER_BIN',
                 'context': 'PASEO_DOCKER_CONTEXT'}
        value = {key: os.environ.get(env) for key, env in names.items()}
        value['docker'] = value['docker'] or '/usr/local/bin/docker'
        value['context'] = value['context'] or 'desktop-linux'
    native = value.get('runtime') == 'native'
    required = ('deployment', 'daemonHome', 'cliCommand', 'tailscale') if native else ('deployment', 'container', 'docker', 'context')
    missing = [key for key in required if not value.get(key)]
    if missing:
        raise ValueError('Missing host configuration: ' + ', '.join(missing) + '. Run the host installer against the existing deployment; no container was created.')
    if native:
        paths = [value['deployment'], value['daemonHome'], value['tailscale']]
        command = value['cliCommand']
        if not isinstance(command, list) or not command or any(not isinstance(part, str) or not Path(part).is_absolute() for part in command):
            raise ValueError('Native CLI command must contain pinned absolute paths')
        if any(not Path(part).is_absolute() for part in paths):
            raise ValueError('Native broker paths must be absolute')
        return value
    if not Path(value['deployment']).is_absolute() or not Path(value['docker']).is_absolute():
        raise ValueError('Host deployment and Docker executable must be absolute paths')
    return value


def discover(container, docker='/usr/local/bin/docker', context='desktop-linux'):
    inspected = json.loads(subprocess.check_output([docker, '--context', context, 'inspect', container], text=True))[0]
    home = next(m for m in inspected['Mounts'] if m['Destination'] == '/home/paseo' and m['Type'] == 'bind')
    root = Path(home['Source']).parent.parent
    if Path(home['Source']) != root / 'data/home' or not (root / 'compose.yaml').is_file():
        raise ValueError('Deployment mounts disagree; inspect existing Compose configuration')
    return {'deployment': str(root), 'container': inspected['Name'].lstrip('/'), 'docker': str(Path(docker).resolve()), 'context': context}, inspected
