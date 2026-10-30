import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import native_gateway as gateway  # noqa: E402


def config(**overrides):
    value = {
        'nodeName': 'example-gateway',
        'sites': [
            {'hostname': 'old.example.com', 'redirect': 'https://app.example.com'},
            {'hostname': 'app.example.com', 'upstream': 'http://127.0.0.1:6770', 'holdSeconds': 30},
            {'hostname': 'site.example.com', 'upstream': 'https://preview.example-tailnet.ts.net:32774'},
        ],
    }
    value.update(overrides)
    return value


class ValidationTests(unittest.TestCase):
    def test_rejects_remote_plain_http_upstream(self):
        bad = config(sites=[{'hostname': 'app.example.com', 'upstream': 'http://10.0.0.5:6770'}])
        with self.assertRaisesRegex(ValueError, 'loopback'):
            gateway.validate_config(bad)

    def test_rejects_upstream_with_path_or_credentials(self):
        for upstream in ('http://127.0.0.1:6770/api', 'https://user:secret@host.example.com'):
            with self.subTest(upstream=upstream), self.assertRaises(ValueError):
                gateway.validate_config(config(sites=[{'hostname': 'app.example.com', 'upstream': upstream}]))

    def test_rejects_duplicate_and_invalid_hostnames(self):
        site = {'hostname': 'app.example.com', 'redirect': 'https://other.example.com'}
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            gateway.validate_config(config(sites=[site, dict(site)]))
        with self.assertRaisesRegex(ValueError, 'hostname'):
            gateway.validate_config(config(sites=[{'hostname': 'App.example.com\n}', 'redirect': 'https://a.com'}]))

    def test_rejects_unbounded_hold(self):
        with self.assertRaisesRegex(ValueError, 'holdSeconds'):
            gateway.validate_config(config(sites=[{'hostname': 'app.example.com',
                                                   'upstream': 'http://127.0.0.1:1', 'holdSeconds': 600}]))


class CaddyfileTests(unittest.TestCase):
    def test_generates_each_site_kind(self):
        text = gateway.caddyfile(gateway.validate_config(config()))
        self.assertIn('redir https://app.example.com{uri} 302', text)
        self.assertIn('reverse_proxy http://127.0.0.1:6770 {', text)
        self.assertIn('lb_try_duration 30s', text)
        self.assertIn('tls_server_name preview.example-tailnet.ts.net', text)
        self.assertEqual(text.count('bind 127.0.0.1'), 3)
        # The token is read from the environment at run time, never written to the file.
        self.assertIn('{env.CF_API_TOKEN}', text)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'gateway'
        for name in gateway.BINARIES:
            (self.base / name).write_bytes(name.encode())
        (self.base / 'config.json').write_text(json.dumps(config()))

    def prepare(self):
        args = mock.Mock(deployment=str(self.root), config=str(self.base / 'config.json'),
                         **{name: str(self.base / name) for name in gateway.BINARIES})
        with mock.patch('builtins.print'):
            gateway.prepare(args)

    def test_prepare_stages_jobs_without_starting_anything(self):
        with mock.patch.object(gateway, 'install') as install, mock.patch.object(subprocess, 'run') as run:
            self.prepare()
        install.assert_not_called()
        run.assert_not_called()
        record = json.loads((self.root / 'gateway.json').read_text())
        self.assertEqual(set(record['binaries']), set(gateway.BINARIES))
        caddy_job = json.loads((self.root / 'launchd' / 'caddy.json').read_text())
        self.assertEqual(caddy_job['ProgramArguments'][-3:], ['run-caddy', '--deployment', str(self.root)])
        self.assertNotIn('CF_API_TOKEN', json.dumps(caddy_job))
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)

    def test_run_refuses_a_replaced_binary(self):
        self.prepare()
        (self.root / 'bin' / 'caddy').write_bytes(b'replaced')
        with mock.patch.object(gateway.os, 'execve') as execve, self.assertRaisesRegex(ValueError, 'digest'):
            gateway.run_caddy(mock.Mock(deployment=str(self.root)))
        execve.assert_not_called()

    def test_run_caddy_passes_token_only_through_environment(self):
        self.prepare()
        (self.root / 'secrets' / 'cloudflare_dns_token').write_text('token-value\n')
        with mock.patch.object(gateway.os, 'execve') as execve:
            gateway.run_caddy(mock.Mock(deployment=str(self.root)))
        binary, argv, environment = execve.call_args.args
        self.assertNotIn('token-value', ' '.join(argv))
        self.assertEqual(environment['CF_API_TOKEN'], 'token-value')

    def test_activate_requires_token_and_migrated_node_state(self):
        self.prepare()
        args = mock.Mock(deployment=str(self.root), allow_login=False)
        with self.assertRaisesRegex(ValueError, 'DNS token'):
            gateway.activate(args)
        (self.root / 'secrets' / 'cloudflare_dns_token').write_text('token')
        with self.assertRaisesRegex(ValueError, 'node state'):
            gateway.activate(args)

    def test_activate_loads_jobs_then_configures_serve(self):
        self.prepare()
        (self.root / 'secrets' / 'cloudflare_dns_token').write_text('token')
        (self.root / 'tailscale-state' / 'tailscaled.state').write_text('{}')
        calls = []
        with mock.patch.object(gateway, 'install', lambda content, *a, **k: calls.append(content['Label'])), \
                mock.patch('builtins.print'):
            gateway.activate(mock.Mock(deployment=str(self.root), allow_login=False),
                             run=lambda command, **kwargs: calls.append(command[3:]))
        self.assertEqual(calls[:2], [gateway.labels(self.root)['tailscaled'], gateway.labels(self.root)['caddy']])
        self.assertEqual(calls[2], ['serve', '--bg', '--tcp', '443', 'tcp://127.0.0.1:8443'])


if __name__ == '__main__':
    unittest.main()
