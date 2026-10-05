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
    print(os.environ.get('TEST_CONTRACT','tailscale-v1') if 'container-contract' in args[3] else 'example/paseo@sha256:'+'a'*64)
elif args[0]=='build': Path(args[args.index('--iidfile')+1]).write_text('sha256:'+'d'*64)
elif args[0]=='run': print('b'*64+'c'*12)
elif args[0]=='inspect': print('healthy')
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
