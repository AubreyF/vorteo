import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

from scratch_reaper import plan


class ScratchReaperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.old = time.time() - 30 * 86400

    def make(self, name, files=('file',), age=None):
        path = self.root / name
        path.mkdir()
        for file in files:
            (path / file).parent.mkdir(parents=True, exist_ok=True)
            (path / file).write_text('x')
        stamp = self.old if age is None else age
        for directory, names, items in os.walk(path, topdown=False):
            for item in names + items:
                os.utime(os.path.join(directory, item), (stamp, stamp))
            os.utime(directory, (stamp, stamp))
        return path

    def reasons(self, **kwargs):
        stale, kept = plan(self.root, 7, held=kwargs.pop('held', set()), **kwargs)
        return {Path(item['path']).name: item.get('reason') for item in stale + kept}

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

    def test_git_checkout_with_unique_work_is_kept(self):
        self.make('checkout', files=('.git/HEAD',))

        def dirty(command, **kwargs):
            output = ' M file\n' if 'status' in command else ''
            return subprocess.CompletedProcess(command, 0, output, '')

        def unpushed(command, **kwargs):
            output = 'abc123 local commit\n' if 'log' in command else ''
            return subprocess.CompletedProcess(command, 0, output, '')

        def clean(command, **kwargs):
            return subprocess.CompletedProcess(command, 0, '', '')

        import scratch_reaper
        original = scratch_reaper.shutil.which
        scratch_reaper.shutil.which = lambda name: '/usr/bin/git'
        self.addCleanup(setattr, scratch_reaper.shutil, 'which', original)
        self.assertEqual(self.reasons(run=dirty), {'checkout': 'uncommitted changes'})
        self.assertEqual(self.reasons(run=unpushed), {'checkout': 'unpushed commits'})
        self.assertEqual(self.reasons(run=clean), {'checkout': None})


if __name__ == '__main__':
    unittest.main()
