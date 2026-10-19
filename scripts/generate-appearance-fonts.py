#!/usr/bin/env python3
"""Reproduce the pinned native font assets from verified upstream source files."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil

import fontTools
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


MANIFEST = Path(__file__).resolve().parent.parent / "packages/app/assets/appearance-fonts/manifest.json"
STYLES = {300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold"}


def verify(path, entry):
    data = path.read_bytes()
    if len(data) != entry["bytes"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
        raise ValueError(f"Pinned font checksum mismatch: {path.name}")


def static_face(source, destination, family, weight):
    font = TTFont(source, recalcTimestamp=False)
    instantiateVariableFont(font, {"wght": weight}, inplace=True, updateFontNames=False)
    style = STYLES[weight]
    prefix = family.replace(" ", "")
    names = {
        1: family if weight in (400, 700) else f"{family} {style}",
        2: "Bold" if weight == 700 else "Regular",
        3: f"{prefix}-{style}-Static",
        4: f"{family} {style}",
        6: f"{prefix}-{style}",
        16: family,
        17: style,
    }
    # The source STAT tables do not name every requested weight. Name the
    # static faces explicitly so native family/weight matching is unambiguous.
    for record in font["name"].names:
        if record.nameID in names:
            record.string = names[record.nameID].encode(record.getEncoding())
    font["OS/2"].fsSelection = (font["OS/2"].fsSelection & ~96) | (32 if weight == 700 else 64)
    font["head"].macStyle = (font["head"].macStyle & ~3) | (1 if weight == 700 else 0)
    font.save(destination)
    font.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_directory", type=Path)
    parser.add_argument("output_directory", type=Path, help="A new directory, never the checked-in assets")
    args = parser.parse_args()
    if fontTools.__version__ != "4.60.1":
        raise ValueError("Use fonttools==4.60.1 to reproduce the pinned binary assets")
    manifest = json.loads(MANIFEST.read_text())
    for entry in manifest["files"]:
        verify(args.source_directory / entry["file"], entry)
    args.output_directory.mkdir(parents=True, exist_ok=False)
    for entry in manifest["nativeFonts"]:
        source = args.source_directory / entry["sourceFile"]
        destination = args.output_directory / entry["file"]
        if "[wght]" in entry["sourceFile"]:
            static_face(source, destination, entry["family"], entry["weight"])
        else:
            shutil.copyfile(source, destination)
        verify(destination, entry)
        with TTFont(destination) as font:
            if font["name"].getBestFamilyName() != entry["family"]:
                raise ValueError(f"Incorrect native family: {entry['file']}")
            if font["OS/2"].usWeightClass != entry["weight"] or "fvar" in font:
                raise ValueError(f"Incorrect static weight: {entry['file']}")
    for entry in manifest["files"]:
        if entry["file"].endswith("OFL.txt"):
            shutil.copyfile(args.source_directory / entry["file"], args.output_directory / entry["file"])
    print(f"Reproduced and verified {len(manifest['nativeFonts'])} fonts and their licenses")


if __name__ == "__main__":
    main()
