import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import uuid
import hashlib
import shutil
import base64
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "monitor_filesystem", Path(__file__).with_name("preview-monitor-filesystem.py")
)
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


class MonitorFilesystemTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="monitor-fixture-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.target = self.root / "home/paseo/.local/bin/paseo-preview"
        self.target.parent.mkdir(parents=True)
        self.receipts = self.root / "var/lib/vorteo/preview-monitor-maintenance"
        self.receipts.mkdir(parents=True, mode=0o700)
        self.before = b"#!/usr/bin/env node\n// before\n"
        self.candidate = b"#!/usr/bin/env node\n// candidate\n"
        self.target.write_bytes(self.before)
        self.target.chmod(0o755)
        self.binding = {
            "root": str(self.root), "uid": os.getuid(), "gid": os.getgid(),
            "containerId": "a" * 64,
        }
        self.request = {
            "id": str(uuid.uuid4()), "revision": str(uuid.uuid4()),
            "planSha256": "b" * 64, "containerId": "a" * 64,
            "destination": "/home/paseo/.local/bin/paseo-preview",
            "beforeSha256": hashlib.sha256(self.before).hexdigest(),
            "candidateSha256": hashlib.sha256(self.candidate).hexdigest(),
            "candidateBase64": base64.b64encode(self.candidate).decode(),
            "previousBase64": base64.b64encode(self.before).decode(),
        }

    def receipt(self):
        return json.loads((self.receipts / self.request["id"] / "receipt.json").read_text())

    def test_atomic_replacement_retains_exact_before_bytes_and_durable_receipt(self):
        result = monitor.replace_monitor(self.request, self.binding)
        self.assertEqual(result["status"], "installed")
        self.assertEqual(self.target.read_bytes(), self.candidate)
        self.assertEqual(self.target.stat().st_mode & 0o7777, 0o755)
        self.assertEqual(self.target.stat().st_uid, os.getuid())
        self.assertEqual((self.receipts / self.request["id"] / "before").read_bytes(), self.before)
        self.assertEqual(self.receipt(), result)
        self.assertFalse((self.target.parent / ".paseo-preview-maintenance-lock").exists())

    def test_target_replaced_inside_exchange_boundary_retains_unreviewed_bytes(self):
        unreviewed = b"concurrent unreviewed entry"
        real_exchange = monitor.exchange_monitor
        def race(parent, staged):
            replacement = self.target.with_name("concurrent")
            replacement.write_bytes(unreviewed)
            replacement.chmod(0o755)
            replacement.replace(self.target)
            real_exchange(parent, staged)
        with patch.object(monitor, "exchange_monitor", race):
            with self.assertRaises(monitor.MonitorUncertain):
                monitor.replace_monitor(self.request, self.binding)
        receipt = self.receipt()
        self.assertEqual(receipt["status"], "uncertain")
        self.assertEqual(self.target.read_bytes(), self.candidate)
        job = self.receipts / self.request["id"]
        self.assertEqual((job / "before").read_bytes(), self.before)
        self.assertEqual((job / "displaced").read_bytes(), unreviewed)
        self.assertEqual((self.root / receipt["displacedPath"].lstrip("/")).read_bytes(), unreviewed)
        self.assertEqual(receipt["displacedSha256"], monitor.digest(unreviewed))
        self.assertTrue((self.target.parent / ".paseo-preview-maintenance-lock").exists())
        with self.assertRaises(ValueError):
            monitor.replace_monitor(self.request, self.binding)

    def test_same_bytes_different_inode_inside_exchange_never_reports_success(self):
        real_exchange = monitor.exchange_monitor
        def race(parent, staged):
            replacement = self.target.with_name("concurrent")
            replacement.write_bytes(self.before)
            replacement.chmod(0o755)
            replacement.replace(self.target)
            real_exchange(parent, staged)
        with patch.object(monitor, "exchange_monitor", race):
            with self.assertRaises(monitor.MonitorUncertain):
                monitor.replace_monitor(self.request, self.binding)
        self.assertEqual(self.receipt()["status"], "uncertain")
        self.assertEqual((self.receipts / self.request["id"] / "displaced").read_bytes(), self.before)

    def test_unsupported_exchange_fails_closed_without_ordinary_rename(self):
        with patch.object(monitor, "exchange_monitor", side_effect=OSError("unsupported")):
            with self.assertRaises(monitor.MonitorUncertain):
                monitor.replace_monitor(self.request, self.binding)
        self.assertEqual(self.target.read_bytes(), self.before)
        self.assertEqual(self.receipt()["status"], "uncertain")

    def test_same_request_never_replays_after_success(self):
        monitor.replace_monitor(self.request, self.binding)
        with self.assertRaises(ValueError):
            monitor.replace_monitor(self.request, self.binding)
        self.assertEqual(self.target.read_bytes(), self.candidate)

    def test_before_bytes_are_rechecked_immediately_before_commit(self):
        def change(phase):
            if phase == "commit-intent":
                self.target.write_bytes(b"concurrent replacement")
        with self.assertRaises(monitor.MonitorUncertain):
            monitor.replace_monitor(self.request, self.binding, change)
        self.assertEqual(self.target.read_bytes(), b"concurrent replacement")
        self.assertEqual(self.receipt()["status"], "uncertain")

    def test_replaced_parent_before_commit_does_not_redirect_writes(self):
        original = self.target.parent.with_name("detached-bin")
        def change(phase):
            if phase == "before-commit":
                self.target.parent.rename(original)
                self.target.parent.mkdir()
                self.target.write_bytes(b"new directory sentinel")
                self.target.chmod(0o755)
        with self.assertRaises(monitor.MonitorUncertain):
            monitor.replace_monitor(self.request, self.binding, change)
        self.assertEqual(self.target.read_bytes(), b"new directory sentinel")
        self.assertEqual((original / "paseo-preview").read_bytes(), self.before)
        self.assertEqual(self.receipt()["status"], "uncertain")

    def test_replaced_ancestor_after_commit_never_reports_installed(self):
        ancestor = self.target.parent.parent
        detached = ancestor.with_name("detached-local")
        bait = self.root / "bait"
        (bait / "bin").mkdir(parents=True)
        (bait / "bin/paseo-preview").write_bytes(b"symlink sentinel")
        def change(phase):
            if phase == "after-commit":
                ancestor.rename(detached)
                ancestor.symlink_to(bait, target_is_directory=True)
        with self.assertRaises(monitor.MonitorUncertain):
            monitor.replace_monitor(self.request, self.binding, change)
        self.assertEqual(self.target.read_bytes(), b"symlink sentinel")
        self.assertEqual((detached / "bin/paseo-preview").read_bytes(), self.candidate)
        self.assertEqual(self.receipt()["status"], "uncertain")

    def test_replaced_root_after_receipt_preserves_uncertainty_in_pinned_receipt_directory(self):
        detached = self.root.with_name(self.root.name + "-detached")
        self.addCleanup(shutil.rmtree, detached)
        def change(phase):
            if phase == "after-receipt":
                self.root.rename(detached)
                self.root.mkdir(mode=0o700)
        with self.assertRaises(monitor.MonitorUncertain):
            monitor.replace_monitor(self.request, self.binding, change)
        saved = detached / "var/lib/vorteo/preview-monitor-maintenance" / self.request["id"] / "receipt.json"
        self.assertEqual(json.loads(saved.read_text())["status"], "uncertain")
        self.assertFalse((self.root / "home").exists())

    def test_directory_permissions_are_rejected_and_never_repaired(self):
        parent = self.target.parent
        def change(phase):
            if phase == "before-commit":
                parent.chmod(0o777)
        with self.assertRaises(monitor.MonitorUncertain):
            monitor.replace_monitor(self.request, self.binding, change)
        self.assertEqual(parent.stat().st_mode & 0o7777, 0o777)
        self.assertEqual(self.target.read_bytes(), self.before)

    def test_interrupted_dispatch_retains_intent_and_never_replays_or_rolls_back(self):
        class Interrupted(BaseException):
            pass
        def crash(phase):
            if phase == "after-commit":
                raise Interrupted()
        with self.assertRaises(Interrupted):
            monitor.replace_monitor(self.request, self.binding, crash)
        self.assertEqual(self.receipt()["status"], "uncertain")
        self.assertTrue(self.receipt()["commitAttempted"])
        self.assertEqual(self.target.read_bytes(), self.candidate)
        with self.assertRaises(ValueError):
            monitor.replace_monitor(self.request, self.binding)
        self.assertEqual(self.target.read_bytes(), self.candidate)

    def test_abandoned_lock_blocks_another_request_without_overwriting_target(self):
        (self.target.parent / ".paseo-preview-maintenance-lock").mkdir(mode=0o700)
        with self.assertRaises(monitor.MonitorUncertain):
            monitor.replace_monitor(self.request, self.binding)
        self.assertEqual(self.target.read_bytes(), self.before)
        self.assertFalse(self.receipt()["commitAttempted"])

    def test_changed_container_or_fixed_destination_is_rejected(self):
        for field, value in [("containerId", "c" * 64), ("destination", "/arbitrary")]:
            with self.subTest(field=field):
                request = dict(self.request, **{field: value})
                with self.assertRaises(ValueError):
                    monitor.replace_monitor(request, self.binding)
        self.assertEqual(self.target.read_bytes(), self.before)

    def test_wrong_owner_binding_is_rejected_without_chown(self):
        binding = dict(self.binding, uid=self.binding["uid"] + 1)
        with self.assertRaises(ValueError):
            monitor.replace_monitor(self.request, binding)
        self.assertEqual(self.target.stat().st_uid, os.getuid())
        self.assertEqual(self.target.read_bytes(), self.before)

    def test_linked_target_is_rejected(self):
        alias = self.target.with_name("alias")
        os.link(self.target, alias)
        with self.assertRaises(ValueError):
            monitor.replace_monitor(self.request, self.binding)
        self.assertEqual(self.target.read_bytes(), self.before)

    def test_wrong_mode_and_changed_artifact_bytes_are_rejected(self):
        self.target.chmod(0o775)
        with self.assertRaises(ValueError):
            monitor.replace_monitor(self.request, self.binding)
        self.assertEqual(self.target.stat().st_mode & 0o7777, 0o775)
        request = dict(self.request, candidateBase64=base64.b64encode(b"substituted").decode())
        with self.assertRaises(ValueError):
            monitor.replace_monitor(request, self.binding)

    def test_stage_replaced_at_final_commit_boundary_is_uncertain(self):
        def race(phase):
            if phase == "commit-intent":
                stage = self.target.with_name(".paseo-preview." + self.request["id"] + ".staged")
                stage.unlink()
                stage.write_bytes(b"substituted")
                stage.chmod(0o755)
        with self.assertRaises(monitor.MonitorUncertain):
            monitor.replace_monitor(self.request, self.binding, race)
        self.assertEqual(self.target.read_bytes(), self.before)
        self.assertEqual(self.receipt()["status"], "uncertain")

    def test_reviewed_ancestry_must_match_before_any_receipt_creation(self):
        observation = monitor.inspect_monitor(self.binding)
        self.request["ancestrySha256"] = observation["ancestrySha256"]
        self.target.parent.rename(self.target.parent.with_name("old-bin"))
        self.target.parent.mkdir()
        self.target.write_bytes(self.before)
        self.target.chmod(0o755)
        with self.assertRaises(ValueError):
            monitor.replace_monitor(self.request, self.binding)
        self.assertFalse((self.receipts / self.request["id"]).exists())

    def test_receipt_directory_replacement_after_commit_never_reports_success(self):
        def race(phase):
            if phase == "after-commit":
                self.receipts.rename(self.receipts.with_name("old-receipts"))
                self.receipts.mkdir(mode=0o700)
        with self.assertRaises(monitor.MonitorUncertain):
            monitor.replace_monitor(self.request, self.binding, race)
        old = self.receipts.with_name("old-receipts") / self.request["id"]
        self.assertEqual(json.loads((old / "receipt.json").read_text())["status"], "uncertain")
        self.assertEqual(list(self.receipts.iterdir()), [])

    def test_lock_replacement_at_commit_boundary_requires_inspection(self):
        def race(phase):
            if phase == "commit-intent":
                lock = self.target.parent / ".paseo-preview-maintenance-lock"
                lock.rename(lock.with_name("detached-lock"))
                lock.mkdir(mode=0o700)
        with self.assertRaises(monitor.MonitorUncertain):
            monitor.replace_monitor(self.request, self.binding, race)
        self.assertEqual(self.target.read_bytes(), self.before)


if __name__ == "__main__":
    unittest.main()
