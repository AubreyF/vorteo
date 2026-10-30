"""Exercise host scripts with a recording Docker CLI, without touching a daemon."""
import json
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parent


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        binary = self.root / 'bin'
        binary.mkdir()
        docker = binary / 'docker'
        docker.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args=sys.argv[1:]
with open(os.environ['DOCKER_RECORD'], 'a') as stream: stream.write(json.dumps(args)+'\\n')
if args[:2]==['image','inspect'] and '--format' in args:
    if 'container-contract' in args[3]: print(os.environ.get('TEST_CONTRACT','tailscale-v1'))
    elif 'gate-contract' in args[3]: print(os.environ.get('TEST_GATE_CONTRACT','v1'))
    else: print('example/paseo@sha256:'+'a'*64)
elif args[0]=='run' and 'test' in args:
    sys.exit(int(os.environ.get('TEST_GATE_CAPABLE_EXIT','0')))
elif args[0]=='build': Path(args[args.index('--iidfile')+1]).write_text('sha256:'+'d'*64)
elif args[0]=='run': print('b'*64+'c'*12)
elif args[0]=='inspect':
    queue=Path(os.environ['TEST_HEALTH']) if 'TEST_HEALTH' in os.environ else None
    states=queue.read_text().split() if queue and queue.exists() else []
    print(states[0] if states else 'healthy')
    if states: queue.write_text(' '.join(states[1:]))
elif args[0]=='compose' and 'ps' in args: print('owned-container')
elif args[0]=='compose' and '--url' in args: print('https://test.example.ts.net')
''')
        docker.chmod(0o700)
        self.record = self.root / 'docker.jsonl'
        self.env = {**os.environ, 'PATH': str(binary) + os.pathsep + os.environ['PATH'], 'DOCKER_RECORD': str(self.record)}
        self.deployment = self.root / 'private instance'

    def install(self):
        return subprocess.run(['bash', str(SOURCE / 'install.sh'), str(self.deployment), 'example/paseo:review'], env=self.env, capture_output=True, text=True)

    def calls(self):
        return [json.loads(line) for line in self.record.read_text().splitlines()]

    def test_install_pins_image_and_keeps_credentials_private(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        config = (self.deployment / '.env').read_text()
        self.assertIn('PASEO_IMAGE=example/paseo@sha256:'+'a'*64, config)
        self.assertIn('PASEO_INSTANCE=paseo-'+'c'*12, config)
        self.assertIn('PASEO_PASSWORD='+'b'*64, config)
        self.assertNotIn('b'*64, result.stdout + result.stderr)
        self.assertEqual((self.deployment / '.env').stat().st_mode & 0o777, 0o600)
        self.assertTrue((self.deployment / 'workspace').is_dir())
        self.assertTrue(any('up' in call and 'paseo' in call for call in self.calls()))
        self.assertFalse(any('--remove-orphans' in call for call in self.calls()))

    def test_projects_folder_is_mounted_at_its_own_path(self):
        folder = self.root / 'dev'
        folder.mkdir()
        self.env['PASEO_PROJECTS_FOLDER'] = str(folder)
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        override = json.loads((self.deployment / 'projects-folder.compose.json').read_text())
        service = override['services']['paseo']
        real = str(folder.resolve())
        self.assertEqual(service['environment'], {'PASEO_PROJECTS_ROOT': real})
        self.assertEqual(service['volumes'], [{'type': 'bind', 'source': real, 'target': real, 'bind': {'create_host_path': False}}])
        up = [call for call in self.calls() if call[0] == 'compose' and 'up' in call][-1]
        self.assertIn(str(self.deployment / 'projects-folder.compose.json'), up)

    def test_projects_folder_rejects_unsafe_paths_before_creating_state(self):
        folder = self.root / 'bad$name'
        folder.mkdir()
        self.env['PASEO_PROJECTS_FOLDER'] = str(folder)
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.deployment.exists())

    def test_host_loopback_port_publishes_only_on_loopback(self):
        self.env['PASEO_HOST_LOOPBACK_PORT'] = '6768'
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        override = json.loads((self.deployment / 'host-loopback.compose.json').read_text())
        service = override['services']['paseo']
        self.assertEqual(service['environment'], {'PASEO_LISTEN': '0.0.0.0:6767'})
        self.assertEqual(service['ports'], [{'host_ip': '127.0.0.1', 'published': '6768', 'target': 6767, 'protocol': 'tcp'}])
        up = [call for call in self.calls() if call[0] == 'compose' and 'up' in call][-1]
        self.assertIn(str(self.deployment / 'host-loopback.compose.json'), up)

    def test_default_install_publishes_no_host_port(self):
        self.assertEqual(self.install().returncode, 0)
        self.assertFalse((self.deployment / 'host-loopback.compose.json').exists())

    def test_host_loopback_port_rejects_invalid_ports_before_creating_state(self):
        for port in ['80', '70000', '6768; touch bad', '0']:
            self.env['PASEO_HOST_LOOPBACK_PORT'] = port
            result = self.install()
            self.assertNotEqual(result.returncode, 0, port)
            self.assertFalse(self.deployment.exists())

    def test_default_builds_checkout_without_registry(self):
        result = subprocess.run(['bash', str(SOURCE / 'install.sh'), str(self.deployment)], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        build = next(call for call in self.calls() if call[0] == 'build')
        source_commit = subprocess.check_output(['git', '-C', str(SOURCE.parent.parent), 'rev-parse', 'HEAD'], text=True).strip()
        self.assertIn('PASEO_BUILD_COMMIT=' + source_commit, build)
        self.assertFalse(any(call[0] == 'pull' for call in self.calls()))

    def test_existing_directory_is_never_touched(self):
        self.deployment.mkdir()
        sentinel = self.deployment / 'keep'
        sentinel.write_text('active installation')
        self.assertNotEqual(self.install().returncode, 0)
        self.assertEqual(sentinel.read_text(), 'active installation')
        self.assertFalse(self.record.exists())

    def test_old_image_is_rejected_before_creating_state(self):
        self.env['TEST_CONTRACT'] = '<no value>'
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('predates integrated Tailscale', result.stderr)
        self.assertFalse(self.deployment.exists())
        self.assertFalse(any('up' in call for call in self.calls()))

    def test_update_preserves_credentials_and_previous_pin(self):
        self.assertEqual(self.install().returncode, 0)
        before = (self.deployment / '.env').read_text()
        result = subprocess.run(['bash', str(self.deployment / 'update.sh'), 'example/paseo:next'], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.deployment / '.env.previous').read_text(), before)
        self.assertIn('PASEO_PASSWORD='+'b'*64, (self.deployment / '.env').read_text())
        self.assertFalse(any('--remove-orphans' in call or 'down' in call for call in self.calls()))

    def test_update_restores_previous_image_when_new_one_is_unhealthy(self):
        self.assertEqual(self.install().returncode, 0)
        before = (self.deployment / '.env').read_text()
        health = self.root / 'health'
        health.write_text('exited healthy')
        self.env['TEST_HEALTH'] = str(health)
        result = subprocess.run(['bash', str(self.deployment / 'update.sh'), 'example/paseo:next'], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual((self.deployment / '.env').read_text(), before)
        self.assertIn('previous image', result.stderr)
        ups = [call for call in self.calls() if call[0] == 'compose' and 'up' in call]
        self.assertEqual(len(ups), 3)

    def test_shared_folder_apply_preserves_base_configuration_and_credentials(self):
        self.assertEqual(self.install().returncode, 0)
        before = (self.deployment / '.env').read_text()
        pending = self.deployment / 'shared-folders.pending.json'
        pending.write_text(json.dumps({'services': {'paseo': {'volumes': []}}}))
        result = subprocess.run(['bash', str(self.deployment / 'share-folder.sh'), '--apply'], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.deployment / '.env').read_text(), before)
        self.assertFalse(pending.exists())
        up = [call for call in self.calls() if call[0] == 'compose' and 'up' in call][-1]
        self.assertIn(str(self.deployment / 'compose.yaml'), up)
        self.assertIn(str(self.deployment / 'shared-folders.compose.json'), up)
        self.assertIn('--no-deps', up)
        self.assertFalse(any('--remove-orphans' in call or 'down' in call for call in self.calls()))

    def test_invalid_image_is_rejected_without_docker(self):
        result = subprocess.run(['bash', str(SOURCE / 'install.sh'), str(self.deployment), '$(touch bad)'], env=self.env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.deployment.exists())
        self.assertFalse(any(call[0] in ['pull', 'run', 'image'] for call in self.calls()))


class GateModeTests(InstallTests):
    """Gate mode: Dev behind the installation gate, created for a Host installation."""

    def setUp(self):
        super().setUp()
        self.folder = self.root / 'dev'
        self.folder.mkdir()
        self.env.update({
            'PASEO_NETWORK_MODE': 'gate',
            'PASEO_PROJECTS_FOLDER': str(self.folder),
            'PASEO_PUBLIC_HOSTNAME': 'host.example.ts.net',
            'PASEO_CORS_ORIGINS': 'https://host.example.ts.net:44444,http://localhost:6770',
            'PASEO_GATE_IMAGE': 'example/gate:review',
            'PASEO_GATE_RELAY_PORT': '6790',
            'PASEO_GATE_SUBNET': '172.31.251.0/24',
            'PASEO_GATE_ROUTES': 'host.example.ts.net:44444',
        })

    def env_file(self):
        return dict(line.split('=', 1) for line in (self.deployment / '.env').read_text().splitlines())

    # The Tailscale-mode cases above do not apply to a gate deployment.
    test_projects_folder_is_mounted_at_its_own_path = None
    test_host_loopback_port_publishes_only_on_loopback = None
    test_default_install_publishes_no_host_port = None
    test_host_loopback_port_rejects_invalid_ports_before_creating_state = None
    test_shared_folder_apply_preserves_base_configuration_and_credentials = None
    test_update_preserves_credentials_and_previous_pin = None

    def test_gate_install_writes_marker_settings_and_gate_config(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.deployment / '.gate-mode').is_file())
        self.assertFalse((self.deployment / 'projects-folder.compose.json').exists())
        settings = self.env_file()
        self.assertEqual(settings['PASEO_GATE_IMAGE'], 'example/paseo@sha256:'+'a'*64)
        self.assertEqual(settings['PASEO_PUBLIC_HOSTNAME'], 'host.example.ts.net')
        self.assertEqual(settings['PASEO_PROJECTS_FOLDER'], str(self.folder.resolve()))
        self.assertEqual(settings['PASEO_GATE_RELAY_PORT'], '6790')
        self.assertEqual(settings['PASEO_GATE_ADDRESS'], '172.31.251.2')
        self.assertEqual(settings['PASEO_INSTALLATION_PENDING'], '1')
        self.assertEqual((self.deployment / '.env').stat().st_mode & 0o777, 0o600)
        config = json.loads((self.deployment / 'gate/config.json').read_text())
        self.assertEqual(config['environments'], [{'name': 'dev', 'generation': 'paseo-'+'c'*12, 'subnet': '172.31.251.0/24'}])
        self.assertEqual(config['relays'], [{'listen': ':6768', 'target': 'paseo:6767', 'environment': 'dev'}])
        self.assertEqual(config['routes'], ['host.example.ts.net:44444'])
        self.assertEqual(config['policy'], 'standard')
        up = [call for call in self.calls() if call[0] == 'compose' and 'up' in call][-1]
        self.assertIn(str(self.deployment / 'compose.gate.yaml'), up)
        self.assertNotIn(str(self.deployment / 'compose.yaml'), up)
        self.assertEqual(up[up.index('up') + 1:], ['-d', '--pull', 'never', 'paseo', 'gate'])
        self.assertNotIn('b'*64, result.stdout + result.stderr)
        self.assertFalse(any('--url' in call for call in self.calls()))

    def test_gate_install_builds_the_gate_image_when_none_is_given(self):
        del self.env['PASEO_GATE_IMAGE']
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        builds = [call for call in self.calls() if call[0] == 'build']
        self.assertTrue(any('sh.paseo.gate-contract=v1' in call for call in builds))

    def test_gate_install_rejects_unsafe_settings_before_creating_state(self):
        cases = [
            ('PASEO_PUBLIC_HOSTNAME', 'Host.Example'),
            ('PASEO_PUBLIC_HOSTNAME', ''),
            ('PASEO_CORS_ORIGINS', 'https://ok.example,javascript:x'),
            ('PASEO_GATE_RELAY_PORT', '80'),
            ('PASEO_GATE_SUBNET', '10.0.0.0/8'),
            ('PASEO_GATE_SUBNET', '172.31.999.0/24'),
            ('PASEO_GATE_ROUTES', 'host:443,"bad"'),
            ('PASEO_HOST_LOOPBACK_PORT', '6768'),
            ('PASEO_NETWORK_MODE', 'bridge'),
            ('PASEO_INSTALLATION_PENDING', 'yes'),
        ]
        for key, value in cases:
            env = dict(self.env)
            env[key] = value
            result = subprocess.run(['bash', str(SOURCE / 'install.sh'), str(self.deployment), 'example/paseo:review'], env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0, (key, value))
            self.assertFalse(self.deployment.exists(), (key, value))

    def test_gate_install_needs_a_projects_folder(self):
        del self.env['PASEO_PROJECTS_FOLDER']
        self.assertNotEqual(self.install().returncode, 0)
        self.assertFalse(self.deployment.exists())

    def test_gate_install_rejects_an_image_without_gate_support(self):
        self.env['TEST_GATE_CAPABLE_EXIT'] = '1'
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('predates gate mode', result.stderr)
        self.assertFalse(self.deployment.exists())

    def test_gate_install_rejects_a_non_gate_image(self):
        self.env['TEST_GATE_CONTRACT'] = '<no value>'
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('not a gate image', result.stderr)
        self.assertFalse(self.deployment.exists())

    def test_gate_update_recreates_dev_and_gate(self):
        self.assertEqual(self.install().returncode, 0)
        before = (self.deployment / '.env').read_text()
        result = subprocess.run(['bash', str(self.deployment / 'update.sh'), 'example/paseo:next', 'example/gate:next'], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.deployment / '.env.previous').read_text(), before)
        self.assertIn('PASEO_PASSWORD='+'b'*64, (self.deployment / '.env').read_text())
        up = [call for call in self.calls() if call[0] == 'compose' and 'up' in call][-1]
        self.assertIn(str(self.deployment / 'compose.gate.yaml'), up)
        self.assertEqual(up[up.index('up') + 1:], ['-d', '--pull', 'never', 'paseo', 'gate'])
        self.assertFalse(any('--remove-orphans' in call or 'down' in call for call in self.calls()))


class GateSwitchTests(InstallTests):
    """gate.sh moves an existing Tailscale-mode deployment to gate mode and back."""

    def gate(self, command, **extra):
        folder = self.root / 'dev'
        folder.mkdir(exist_ok=True)
        env = {**self.env, 'PASEO_IMAGE': 'example/paseo:gate', 'PASEO_GATE_IMAGE': 'example/gate:review',
               'PASEO_PUBLIC_HOSTNAME': 'host.example.ts.net', 'PASEO_PROJECTS_FOLDER': str(folder), **extra}
        return subprocess.run(['bash', str(self.deployment / 'gate.sh'), command], env=env, capture_output=True, text=True)

    def test_enable_keeps_identity_and_saves_tailscale_settings(self):
        self.assertEqual(self.install().returncode, 0)
        before = (self.deployment / '.env').read_text()
        result = self.gate('enable')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.deployment / '.env.tailscale-mode').read_text(), before)
        after = (self.deployment / '.env').read_text()
        self.assertIn('PASEO_INSTANCE=paseo-'+'c'*12, after)
        self.assertIn('PASEO_PASSWORD='+'b'*64, after)
        self.assertTrue((self.deployment / '.gate-mode').exists())
        compose = [call for call in self.calls() if call[0] == 'compose']
        down = next(call for call in compose if 'down' in call)
        self.assertIn(str(self.deployment / 'compose.yaml'), down)
        self.assertNotIn('-v', down)
        self.assertIn('--remove-orphans', down)
        self.assertIn(str(self.deployment / 'compose.gate.yaml'), [call for call in compose if 'up' in call][-1])
        # Networks a hand-built gate left behind are removed, so Compose cannot reuse their old subnet.
        calls = self.calls()
        removed = calls.index(['network', 'rm', 'paseo-' + 'c' * 12 + '_environment'])
        last_up = max(index for index, call in enumerate(calls) if call[0] == 'compose' and 'up' in call)
        self.assertLess(removed, last_up)

    def test_failed_health_rolls_back_to_tailscale_mode(self):
        self.assertEqual(self.install().returncode, 0)
        before = (self.deployment / '.env').read_text()
        health = self.root / 'health'
        health.write_text(' '.join(['exited'] * 200))
        self.env['TEST_HEALTH'] = str(health)
        result = self.gate('enable')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('rolling back', result.stderr)
        self.assertEqual((self.deployment / '.env').read_text(), before)
        self.assertFalse((self.deployment / '.gate-mode').exists())
        up = [call for call in self.calls() if call[0] == 'compose' and 'up' in call][-1]
        self.assertIn(str(self.deployment / 'compose.yaml'), up)

    def test_invalid_settings_change_nothing(self):
        self.assertEqual(self.install().returncode, 0)
        before = (self.deployment / '.env').read_text()
        result = self.gate('enable', PASEO_GATE_SUBNET='192.168.1.0/24')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.deployment / '.env').read_text(), before)
        self.assertFalse((self.deployment / '.env.tailscale-mode').exists())
        self.assertFalse(any('down' in call for call in self.calls()))


class BrowserRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="browser runtime '")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        spec = importlib.util.spec_from_file_location(
            'browser_runtime', SOURCE.parent.parent / 'scripts/setup-browser-runtime.py')
        self.runtime = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.runtime)

    def test_launcher_preserves_the_executable_and_survives_repeated_setup(self):
        browser = self.root / 'chrome'
        shutil.copy2(sys.executable, browser)
        original = browser.read_bytes()
        libraries = self.root / 'runtime'
        libraries.mkdir()
        self.runtime.wrap_browser(browser, libraries)
        self.runtime.wrap_browser(browser, libraries)
        self.assertEqual(browser.with_name('chrome.paseo-real').read_bytes(), original)
        result = subprocess.run([str(browser), '-c', 'print("working")'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'working')

    def test_unknown_launcher_is_preserved(self):
        browser = self.root / 'chrome'
        original = '#!/bin/sh\necho custom launcher\n'
        browser.write_text(original)
        with self.assertRaisesRegex(RuntimeError, 'unknown browser launcher'):
            self.runtime.wrap_browser(browser, self.root)
        self.assertEqual(browser.read_text(), original)

    def test_missing_original_is_not_replaced(self):
        browser = self.root / 'chrome'
        original = '#!/bin/sh\n' + self.runtime.MARKER + '\n'
        browser.write_text(original)
        with self.assertRaisesRegex(RuntimeError, 'Missing original browser executable'):
            self.runtime.wrap_browser(browser, self.root)
        self.assertEqual(browser.read_text(), original)


if __name__ == '__main__':
    unittest.main()
