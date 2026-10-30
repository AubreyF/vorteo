import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hosted_app as app  # noqa: E402


def git(repo, *args):
    subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True,
                   env={**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@example.com',
                        'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@example.com'})


class HostedAppTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.repo = base / 'repo'
        (self.repo / 'server').mkdir(parents=True)
        (self.repo / 'server' / 'main.mjs').write_text('committed\n')
        (self.repo / 'private').mkdir()
        (self.repo / 'private' / 'tracked.txt').write_text('tracked state\n')
        git(self.repo, 'init', '-q')
        git(self.repo, 'add', '-A')
        git(self.repo, 'commit', '-q', '-m', 'one')
        self.root = base / 'deployment'
        self.config = base / 'app.json'
        self.config.write_text(json.dumps({
            'name': 'example', 'source': str(self.repo), 'port': 47900, 'start': ['server/main.mjs'],
            'statePaths': ['.runtime', 'private', 'local.config.json'],
            'stateExcludes': ['private/node_modules'],
            'build': [['sh', '-c', 'echo built > built.txt']],
        }))
        with mock.patch('builtins.print'):
            app.init(mock.Mock(deployment=str(self.root), config=str(self.config), node=sys.executable))

    def quiet(self, handler, **kwargs):
        with mock.patch('builtins.print') as printed:
            handler(mock.Mock(deployment=str(self.root), **kwargs))
        return json.loads(printed.call_args.args[0])

    def test_rejects_paths_outside_the_application(self):
        for bad in ('../escape', '/absolute', 'a/../../b'):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                app.validate({'name': 'x', 'source': '/repo', 'port': 2000, 'start': ['a'], 'statePaths': [bad]})

    def test_release_holds_only_committed_code_without_state(self):
        (self.repo / 'server' / 'main.mjs').write_text('uncommitted edit\n')
        release = self.quiet(app.build, commit='HEAD')['release']
        built = self.root / 'releases' / release
        self.assertEqual((built / 'server' / 'main.mjs').read_text(), 'committed\n')
        self.assertTrue((built / 'built.txt').is_file())
        self.assertFalse((built / 'private').exists())
        manifest = json.loads((built / '.release.json').read_text())
        self.assertEqual(len(manifest['commit']), 40)

    def test_build_refuses_a_replaced_node_executable(self):
        record = json.loads((self.root / 'app.json').read_text())
        fake = Path(self.temp.name) / 'node'
        fake.write_text('original')
        record.update(node=str(fake), nodeSha256=app.sha256(fake))
        (self.root / 'app.json').write_text(json.dumps(record))
        fake.write_text('replaced')
        with self.assertRaisesRegex(ValueError, 'Node executable changed'):
            self.quiet(app.build, commit='HEAD')
        self.assertEqual([p for p in (self.root / 'releases').iterdir()], [])

    def test_deploy_replaces_code_and_never_touches_state(self):
        instance = self.root / 'instance'
        (instance / 'private').mkdir(parents=True)
        (instance / 'private' / 'live.db').write_text('live\n')
        (instance / 'local.config.json').write_text('{"port": 47900}\n')
        (instance / 'stale-code.mjs').write_text('old\n')
        release = self.quiet(app.build, commit='HEAD')['release']
        self.quiet(app.deploy, release=release)
        self.assertEqual((instance / 'private' / 'live.db').read_text(), 'live\n')
        self.assertEqual((instance / 'local.config.json').read_text(), '{"port": 47900}\n')
        self.assertFalse((instance / 'stale-code.mjs').exists())
        self.assertEqual((instance / 'server' / 'main.mjs').read_text(), 'committed\n')

    def test_import_copies_state_and_refuses_to_overwrite(self):
        live = Path(self.temp.name) / 'live'
        (live / 'private' / 'node_modules').mkdir(parents=True)
        (live / 'private' / 'data.json').write_text('{}\n')
        (live / 'private' / 'node_modules' / 'big').write_text('x\n')
        (live / 'local.config.json').write_text('{}\n')
        result = self.quiet(app.import_state, source=str(live), replace=False, exclude=None)
        self.assertEqual(sorted(result['imported']), ['local.config.json', 'private'])
        self.assertTrue((self.root / 'instance' / 'private' / 'data.json').is_file())
        self.assertFalse((self.root / 'instance' / 'private' / 'node_modules').exists())
        with self.assertRaisesRegex(ValueError, 'already holds state'):
            self.quiet(app.import_state, source=str(live), replace=False, exclude=None)

    def test_import_copies_only_listed_live_entries_of_a_scratch_folder(self):
        record = json.loads((self.root / 'app.json').read_text())
        record['stateSubpaths'] = {'.runtime': ['live', 'identity.json']}
        (self.root / 'app.json').write_text(json.dumps(record))
        live = Path(self.temp.name) / 'live'
        for name in ('live', 'scratch-build'):
            (live / '.runtime' / name).mkdir(parents=True)
            (live / '.runtime' / name / 'file').write_text(name)
        (live / '.runtime' / 'identity.json').write_text('{}')
        self.quiet(app.import_state, source=str(live), replace=False, exclude=None)
        runtime = self.root / 'instance' / '.runtime'
        self.assertEqual(sorted(p.name for p in runtime.iterdir()), ['identity.json', 'live'])

    def test_activate_requires_a_deployed_release_and_imported_state(self):
        self.quiet(app.stage)
        with self.assertRaisesRegex(ValueError, 'Deploy a release'):
            app.activate(mock.Mock(deployment=str(self.root)), run_launchctl=mock.Mock())
        release = self.quiet(app.build, commit='HEAD')['release']
        self.quiet(app.deploy, release=release)
        with self.assertRaisesRegex(ValueError, 'Import state'):
            app.activate(mock.Mock(deployment=str(self.root)), run_launchctl=mock.Mock())

    def test_stage_writes_a_job_without_loading_it(self):
        with mock.patch.object(subprocess, 'run') as launched:
            result = self.quiet(app.stage)
        launched.assert_not_called()
        self.assertFalse(result['loaded'])
        content = json.loads((self.root / 'launchd' / 'app.json').read_text())
        self.assertEqual(content['WorkingDirectory'], str(self.root / 'instance'))
        self.assertEqual(content['EnvironmentVariables']['PASEO_PORT'], '47900')


if __name__ == '__main__':
    unittest.main()
