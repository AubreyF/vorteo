import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest

import scratch_reaper
from scratch_reaper import busy_paths, plan, process_snapshot, remove, visibility_gaps

HAS_GIT = shutil.which('git') is not None
GIT_ENV = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@example.com',
           'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@example.com'}


def git(path, *args):
    subprocess.run(['git', '-C', str(path), *args], check=True, capture_output=True, env=GIT_ENV)


class ScratchReaperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'scratch'
        self.root.mkdir()
        self.old = time.time() - 30 * 86400

    def age(self, path):
        for directory, names, files in os.walk(path, topdown=False):
            for item in names + files:
                os.utime(os.path.join(directory, item), (self.old, self.old), follow_symlinks=False)
            os.utime(directory, (self.old, self.old))

    def make(self, name, files=('file',)):
        path = self.root / name
        path.mkdir()
        for file in files:
            (path / file).parent.mkdir(parents=True, exist_ok=True)
            (path / file).write_text('x')
        self.age(path)
        return path

    def reasons(self, held=frozenset()):
        stale, kept = plan(self.root, 7, held=set(held))
        return {Path(item['path']).name: item.get('reason') for item in stale + kept}

    def repository(self, path, remote=True):
        """A clone whose HEAD exists on its remote; the remote lives outside the scratch root."""
        origin = self.base / ('origin-' + path.name)
        subprocess.run(['git', 'init', '-q', '--bare', str(origin)], check=True, env=GIT_ENV)
        subprocess.run(['git', 'clone', '-q', str(origin), str(path)], check=True, capture_output=True, env=GIT_ENV)
        (path / 'file').write_text('x')
        git(path, 'add', 'file')
        git(path, 'commit', '-q', '-m', 'one')
        if remote:
            git(path, 'push', '-q', 'origin', 'HEAD')
        return path

    def test_old_untouched_directory_is_stale(self):
        self.make('old')
        self.assertEqual(self.reasons(), {'old': None})

    def test_recent_file_deep_inside_keeps_entry(self):
        path = self.make('active', files=('a/b/c/file',))
        (path / 'a/b/c/file').touch()
        self.assertEqual(self.reasons(), {'active': 'recently modified'})

    def test_process_working_directory_keeps_entry(self):
        path = self.make('busy')
        self.assertEqual(self.reasons(held={str(path / 'sub')}), {'busy': 'in use by a process'})

    def test_similar_prefix_is_not_treated_as_in_use(self):
        self.make('work')
        self.assertEqual(self.reasons(held={str(self.root / 'work-other')}), {'work': None})

    def test_running_executable_and_mapped_files_count_as_in_use(self):
        runtime = self.make('node-runtime', files=('bin/node',))
        library = self.make('libs', files=('lib.so',))
        process = self.base / 'proc' / '42'
        (process / 'fd').mkdir(parents=True)
        os.symlink(str(runtime / 'bin/node') + ' (deleted)', process / 'exe')
        (process / 'maps').write_text(f'0-1 r-xp 0 00:00 1 {library}/lib.so\n0-1 rw-p 0 00:00 0 [heap]\n')
        held = busy_paths(self.base / 'proc')
        self.assertIn(str(runtime / 'bin/node'), held)
        reasons = self.reasons(held=held)
        self.assertEqual(reasons['node-runtime'], 'in use by a process')
        self.assertEqual(reasons['libs'], 'in use by a process')

    def test_unreadable_subtree_keeps_entry(self):
        path = self.make('locked', files=('inner/file',))
        os.chmod(path / 'inner', 0)
        self.addCleanup(os.chmod, path / 'inner', 0o700)
        if os.access(path / 'inner', os.R_OK):
            self.skipTest('running with privileges that ignore permissions')
        self.assertEqual(self.reasons(), {'locked': 'part of it cannot be read'})

    def test_bare_repository_is_always_kept(self):
        path = self.make('mirror', files=('HEAD', 'objects/x', 'refs/heads/x'))
        self.assertEqual(self.reasons(), {'mirror': 'contains a bare repository'})

    @unittest.skipUnless(HAS_GIT, 'git is required')
    def test_nested_repository_with_uncommitted_work_keeps_its_wrapper(self):
        wrapper = self.root / 'wrapper'
        (wrapper / 'deep').mkdir(parents=True)
        repo = self.repository(wrapper / 'deep' / 'repo')
        (repo / 'file').write_text('changed')
        self.age(wrapper)
        self.assertEqual(self.reasons(), {'wrapper': 'uncommitted changes in deep/repo'})

    @unittest.skipUnless(HAS_GIT, 'git is required')
    def test_unique_branch_beside_a_pushed_head_is_kept(self):
        repo = self.repository(self.root / 'checkout')
        git(repo, 'checkout', '-q', '-b', 'side')
        (repo / 'side').write_text('x')
        git(repo, 'add', 'side')
        git(repo, 'commit', '-q', '-m', 'side work')
        git(repo, 'checkout', '-q', '-')
        self.age(repo)
        self.assertEqual(self.reasons(), {'checkout': 'unpushed commits'})

    @unittest.skipUnless(HAS_GIT, 'git is required')
    def test_stash_is_kept_and_a_fully_pushed_clone_is_stale(self):
        stashed = self.repository(self.root / 'stashed')
        (stashed / 'file').write_text('stash me')
        git(stashed, 'stash', '-q')
        clean = self.repository(self.root / 'clean')
        self.age(stashed)
        self.age(clean)
        self.assertEqual(self.reasons(), {'stashed': 'stashed changes', 'clean': None})

    def test_visibility_lost_after_planning_keeps_the_candidate(self):
        old = self.make('old')
        stale, _ = plan(self.root, 7, held=set())
        self.assertEqual([item['path'] for item in stale], [str(old)])
        # A process the reaper cannot inspect appears after planning.
        hidden = self.base / 'proc' / '42'
        (hidden / 'fd').mkdir(parents=True)
        os.chmod(hidden / 'fd', 0)
        self.addCleanup(os.chmod, hidden / 'fd', 0o700)
        if os.access(hidden / 'fd', os.R_OK):
            self.skipTest('running with privileges that ignore permissions')
        self.assertTrue(process_snapshot(self.base / 'proc')[1])
        removed, failed = remove(stale, 7, proc=self.base / 'proc')
        self.assertEqual(removed, [])
        self.assertEqual(failed[0]['reason'], 'kept at deletion: process visibility incomplete')
        # The process table disappearing entirely refuses the same way.
        removed, failed = remove(stale, 7, proc=self.base / 'gone-proc')
        self.assertEqual((removed, failed[0]['gaps']), ([], ['process table unavailable']))
        self.assertTrue(old.exists())

    @unittest.skipUnless(HAS_GIT, 'git is required')
    def test_commit_held_only_by_a_custom_ref_is_kept(self):
        repo = self.repository(self.root / 'recovered')
        git(repo, 'checkout', '-q', '-b', 'temporary')
        (repo / 'old-work').write_text('x')
        git(repo, 'add', 'old-work')
        git(repo, 'commit', '-q', '-m', 'old work')
        git(repo, 'update-ref', 'refs/recovery/old-work', 'HEAD')
        git(repo, 'checkout', '-q', '-')
        git(repo, 'branch', '-q', '-D', 'temporary')
        self.age(repo)
        self.assertEqual(self.reasons(), {'recovered': 'unpushed commits'})

    def test_missing_process_table_blocks_deletion(self):
        self.assertEqual(visibility_gaps(self.base / 'no-proc'), ['process table unavailable'])

    def test_deletion_rechecks_safety_and_reports_failures(self):
        resumed = self.make('resumed')
        stuck = self.make('stuck', files=('inner/file',))
        removable = self.make('removable')
        stale, _ = plan(self.root, 7, held=set())
        self.assertEqual(len(stale), 3)
        (resumed / 'new').write_text('work resumed after the scan')
        os.chmod(stuck / 'inner', 0o500)
        self.addCleanup(os.chmod, stuck / 'inner', 0o700)
        self.age(stuck)
        (self.base / 'complete-proc').mkdir()
        removed, failed = remove(stale, 7, proc=self.base / 'complete-proc')
        self.assertEqual(removed, [str(removable)])
        reasons = {Path(item['path']).name: item['reason'] for item in failed}
        self.assertEqual(reasons['resumed'], 'kept at deletion: recently modified')
        if not os.access(stuck / 'inner', os.W_OK):
            self.assertEqual(reasons['stuck'], 'removal incomplete')
        self.assertTrue(resumed.exists())


if __name__ == '__main__':
    unittest.main()
