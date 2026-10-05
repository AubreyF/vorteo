#!/usr/bin/env python3
"""Repair Playwright Chromium in existing Debian 12 containers without root or restart."""

import argparse
import fcntl
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import xml.sax.saxutils

MARKER = "# paseo shared browser runtime v1"
BROWSER_NAMES = {"chrome", "headless_shell", "chrome-headless-shell"}


def run(args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def browser_paths(cache):
    if not cache.is_dir():
        return
    for directory in sorted(cache.iterdir()):
        if not directory.name.startswith(("chromium-", "chromium_headless_shell-")):
            continue
        for name in BROWSER_NAMES:
            for candidate in sorted(directory.glob(f"*/{name}")):
                if candidate.is_file():
                    yield candidate


def wrap_browser(browser, runtime):
    with browser.open("rb") as source:
        header = source.read(256)
    real = browser.with_name(browser.name + ".paseo-real")
    if header.startswith(b"\x7fELF"):
        # Preserve the old entrypoint until the atomic launcher replacement is ready.
        temporary_real = real.with_suffix(".pending")
        shutil.copy2(browser, temporary_real)
        temporary_real.replace(real)
    elif MARKER.encode() not in header:
        raise RuntimeError(f"Refusing to replace an unknown browser launcher: {browser}")
    elif not real.is_file():
        raise RuntimeError(f"Missing original browser executable: {real}")
    library_dirs = sorted((runtime / "root/usr/lib").glob("*-linux-gnu"))
    library_dirs += sorted((runtime / "root/lib").glob("*-linux-gnu"))
    libraries = ":".join(str(directory) for directory in library_dirs)
    launcher = "\n".join([
        "#!/usr/bin/env bash",
        MARKER,
        "set -e",
        f"export LD_LIBRARY_PATH={shlex.quote(libraries)}${{LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}}",
        f"export FONTCONFIG_FILE={shlex.quote(str(runtime / 'fonts.conf'))}",
        f"exec {shlex.quote(str(real))} \"$@\"",
        "",
    ])
    temporary = browser.with_name(browser.name + ".paseo-pending")
    temporary.write_text(launcher)
    temporary.chmod(0o755)
    temporary.replace(browser)
    run([str(browser), "--version"])


def install_runtime(runtime, packages):
    with tempfile.TemporaryDirectory(prefix="paseo-browser-apt-") as temporary:
        staging = Path(temporary)
        lists = staging / "lists"
        archives = staging / "archives"
        (lists / "partial").mkdir(parents=True)
        (archives / "partial").mkdir(parents=True)
        # All writable APT paths are private. Download-only never invokes dpkg installation.
        options = [
            "-o", f"Dir::State::lists={lists}",
            "-o", f"Dir::Cache={staging / 'cache'}",
            "-o", f"Dir::Cache::archives={archives}",
            "-o", "Debug::NoLocking=true",
        ]
        run(["apt-get", *options, "update"])
        run(["apt-get", *options, "--yes", "--download-only", "--no-install-recommends", "install", *packages])
        root = runtime / "root"
        root.mkdir(parents=True, exist_ok=True)
        for archive in sorted(archives.glob("*.deb")):
            run(["dpkg-deb", "--extract", str(archive), str(root)])
    font_dir = xml.sax.saxutils.escape(str(root / "usr/share/fonts"))
    font_cache = xml.sax.saxutils.escape(str(runtime / "font-cache"))
    (runtime / "fonts.conf").write_text(
        '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n'
        f'<fontconfig><dir>/usr/share/fonts</dir><dir>{font_dir}</dir>'
        f'<cachedir>{font_cache}</cachedir><alias><family>sans-serif</family>'
        '<prefer><family>Liberation Sans</family><family>DejaVu Sans</family></prefer></alias>'
        '<alias><family>monospace</family><prefer><family>Liberation Mono</family>'
        '</prefer></alias></fontconfig>\n'
    )
    (runtime / "installed").write_text("Debian 12 Chromium dependencies\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="Refresh libraries from configured signed Debian repositories")
    cache_home = Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache")))
    parser.add_argument("--cache", type=Path, default=Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH", str(cache_home / "ms-playwright"))))
    args = parser.parse_args()
    release = Path("/etc/os-release").read_text()
    if 'ID=debian\n' not in release or 'VERSION_ID="12"' not in release:
        raise RuntimeError("This repair targets Debian 12 containers. Elsewhere use: npx playwright install --with-deps chromium")
    browsers = list(browser_paths(args.cache))
    if not browsers:
        raise RuntimeError("No Chromium installation found. Run npx playwright install chromium, then repeat setup with --cache pointing to its browser cache.")
    runtime = cache_home / "paseo-browser-runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    manifest = Path(__file__).resolve().parent.parent / "docker/base/chromium-packages.txt"
    if not manifest.is_file():
        manifest = Path(__file__).resolve().with_name("chromium-packages.txt")
    packages = manifest.read_text().split()
    with (runtime / "setup.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if args.refresh or not (runtime / "installed").is_file():
            install_runtime(runtime, packages)
        for browser in browsers:
            wrap_browser(browser, runtime)
    print(f"Ready: {len(browsers)} Chromium launchers use shared libraries and fonts at {runtime}")


if __name__ == "__main__":
    main()
