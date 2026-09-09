#!/usr/bin/env python3
"""Prepare, verify, install, activate, and roll back immutable Syrinx releases.

The release directory is self-contained and immutable.  The live web root keeps
only the entry point; versioned application and song resources remain under the
release root so sessions opened before a deployment keep working.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import subprocess
import sys
from typing import Iterable, Sequence
from urllib.parse import urljoin
import xml.etree.ElementTree as ET


DEFAULT_SONG_IDS = ("luv-letter", "flower-dance", "expedition-33", "interstellar")
RELEASE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$")
URL_FIELDS = (
    "scoreUrl",
    "pianoScoreUrl",
    "beatsUrl",
    "accompanimentUrl",
    "coverUrl",
    "backgroundVideoUrl",
    "previewVideoUrl",
    "hoverVideoUrl",
)
REQUIRED_FIELDS = ("scoreUrl", "beatsUrl", "accompanimentUrl")
REQUIRED_BRAND_FILES = ("flute.jpg", "syrinx-logo-dark.jpg", "syrinx-logo-white.jpg")


class ReleaseError(RuntimeError):
    """A release invariant failed; callers must stop before switching traffic."""


@dataclass(frozen=True)
class VerificationReport:
    release_id: str
    song_ids: tuple[str, ...]
    file_count: int


@dataclass(frozen=True)
class ActivationResult:
    release_id: str
    previous_index: Path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def generate_release_id(repo_dir: Path) -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    try:
        git_sha = subprocess.run(
            ["git", "-C", str(repo_dir), "rev-parse", "--short=8", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        git_sha = "nogit000"
    return f"{timestamp}-{git_sha}-{secrets.token_hex(4)}"


def validate_release_id(release_id: str) -> None:
    if not RELEASE_ID_RE.fullmatch(release_id) or ".." in release_id:
        raise ReleaseError(f"invalid release id: {release_id!r}")


def local_resource_path(root: Path, url: object, field: str, song_id: str) -> Path:
    if not isinstance(url, str) or not url.startswith("/"):
        raise ReleaseError(f"{song_id} {field} must be a root-relative URL")
    relative = PurePosixPath(url.removeprefix("/"))
    if ".." in relative.parts or not relative.parts:
        raise ReleaseError(f"{song_id} {field} contains an unsafe path: {url}")
    expected_prefix = ("songs", song_id)
    if relative.parts[:2] != expected_prefix:
        raise ReleaseError(f"{song_id} {field} must stay inside /songs/{song_id}/")
    return root.joinpath(*relative.parts)


def load_source_manifests(app_dir: Path, song_ids: Sequence[str]) -> dict[str, dict[str, object]]:
    songs_root = app_dir / "public" / "songs"
    manifests: dict[str, dict[str, object]] = {}
    for song_id in song_ids:
        manifest_path = songs_root / song_id / "manifest.json"
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise ReleaseError(f"missing source manifest: {manifest_path}") from exc
        except (OSError, json.JSONDecodeError) as exc:
            raise ReleaseError(f"invalid source manifest {manifest_path}: {exc}") from exc
        if data.get("id") != song_id:
            raise ReleaseError(f"manifest id mismatch for {song_id}: {data.get('id')!r}")
        for field in REQUIRED_FIELDS:
            if field not in data:
                raise ReleaseError(f"{song_id} manifest is missing required {field}")
        for field in URL_FIELDS:
            if field not in data:
                continue
            resource = local_resource_path(app_dir / "public", data[field], field, song_id)
            if not resource.is_file():
                raise ReleaseError(f"missing source resource for {song_id} {field}: {resource}")
            validate_resource(resource)
        validate_timeline(
            local_resource_path(app_dir / "public", data["scoreUrl"], "scoreUrl", song_id),
            local_resource_path(app_dir / "public", data["beatsUrl"], "beatsUrl", song_id),
        )
        manifests[song_id] = data
    return manifests


def validate_timeline(score_path: Path, beats_path: Path) -> None:
    try:
        root = ET.parse(score_path).getroot()
    except (OSError, ET.ParseError) as exc:
        raise ReleaseError(f"invalid MusicXML {score_path}: {exc}") from exc
    if not root.tag.endswith("score-partwise") and not root.tag.endswith("score-timewise"):
        raise ReleaseError(f"invalid MusicXML root in {score_path}: {root.tag}")
    try:
        beats = json.loads(beats_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReleaseError(f"invalid beats timeline {beats_path}: {exc}") from exc
    anchors = beats.get("beatAnchors") or beats.get("anchors")
    if not isinstance(anchors, list) or len(anchors) < 2:
        raise ReleaseError(f"beats timeline needs at least two anchors: {beats_path}")
    times = [item.get("t") for item in anchors if isinstance(item, dict)]
    if len(times) != len(anchors) or any(not isinstance(value, (int, float)) for value in times):
        raise ReleaseError(f"beats timeline contains invalid anchor times: {beats_path}")
    if any(later <= earlier for earlier, later in zip(times, times[1:])):
        raise ReleaseError(f"beats timeline anchor times are not strictly increasing: {beats_path}")


def sniff_content_type(path: Path) -> str:
    suffix = path.suffix.lower()
    head = path.read_bytes()[:32]
    if suffix in (".m4a", ".mp4"):
        if len(head) < 12 or head[4:8] != b"ftyp":
            expected = "audio/mp4" if suffix == ".m4a" else "video/mp4"
            raise ReleaseError(f"{path} does not contain real {expected} data")
        return "audio/mp4" if suffix == ".m4a" else "video/mp4"
    if suffix == ".mp3":
        if not (head.startswith(b"ID3") or (len(head) >= 2 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0)):
            raise ReleaseError(f"{path} does not contain real audio/mpeg data")
        return "audio/mpeg"
    if suffix in (".jpg", ".jpeg"):
        if not head.startswith(b"\xff\xd8\xff"):
            raise ReleaseError(f"{path} does not contain real image/jpeg data")
        return "image/jpeg"
    if suffix == ".png":
        if not head.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ReleaseError(f"{path} does not contain real image/png data")
        return "image/png"
    return {
        ".css": "text/css",
        ".html": "text/html",
        ".js": "text/javascript",
        ".json": "application/json",
        ".musicxml": "application/vnd.recordare.musicxml+xml",
        ".svg": "image/svg+xml",
        ".txt": "text/plain",
        ".webp": "image/webp",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
    }.get(suffix, "application/octet-stream")


def validate_resource(path: Path) -> str:
    content_type = sniff_content_type(path)
    try:
        if path.suffix.lower() == ".json":
            json.loads(path.read_text(encoding="utf-8"))
        elif path.suffix.lower() == ".svg":
            ET.parse(path)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ET.ParseError) as exc:
        raise ReleaseError(f"invalid {content_type} resource {path}: {exc}") from exc
    if path.suffix.lower() in {".m4a", ".mp3", ".mp4"}:
        try:
            result = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "format=format_name",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    str(path),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
        except OSError as exc:
            raise ReleaseError("ffprobe is required to verify release media") from exc
        except subprocess.CalledProcessError as exc:
            detail = (exc.stderr or exc.stdout or "unrecognized media").strip()
            raise ReleaseError(f"ffprobe could not decode {path}: {detail}") from exc
        format_name = result.stdout.strip().lower()
        expected = "mp3" if path.suffix.lower() == ".mp3" else "mov,mp4,m4a,3gp,3g2,mj2"
        if expected not in format_name:
            raise ReleaseError(f"ffprobe reported {format_name!r} for {path}, expected {expected}")
    return content_type


def run_build(
    app_dir: Path,
    release_id: str,
    song_ids: Sequence[str],
    *,
    command: Sequence[str] | None = None,
) -> None:
    validate_release_id(release_id)
    build_command = list(command or (["npm.cmd", "run", "build"] if os.name == "nt" else ["npm", "run", "build"]))
    env = os.environ.copy()
    env.update(
        {
            "SYRINX_RELEASE_ID": release_id,
            "VITE_SONG_IDS": ",".join(song_ids),
            "VITE_AUDIO_FORMAT": "m4a",
        }
    )
    try:
        subprocess.run(build_command, cwd=app_dir, env=env, check=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ReleaseError(f"build failed: {exc}") from exc


def copy_tree_without_private_songs(dist_dir: Path, destination: Path) -> None:
    for child in dist_dir.iterdir():
        if child.name in {"songs", "brand"}:
            continue
        target = destination / child.name
        if child.is_dir():
            shutil.copytree(child, target)
        elif child.is_file():
            shutil.copy2(child, target)


def stage_song(
    destination: Path,
    snapshot: Path,
    source_public: Path,
    song_id: str,
    source_manifest: dict[str, object],
) -> tuple[dict[str, object], list[dict[str, object]]]:
    deployed = dict(source_manifest)
    deployed["accompanimentUrl"] = str(source_manifest["accompanimentUrl"]).removesuffix(".mp3") + ".m4a"
    resources: list[dict[str, object]] = []
    for field in URL_FIELDS:
        if field not in deployed:
            continue
        url = deployed[field]
        source = local_resource_path(snapshot, url, field, song_id)
        if not source.is_file():
            raise ReleaseError(f"optimized snapshot is missing {song_id} {field}: {source}")
        if field in {"scoreUrl", "pianoScoreUrl", "beatsUrl"}:
            original = local_resource_path(source_public, url, field, song_id)
            if sha256_file(source) != sha256_file(original):
                raise ReleaseError(f"optimized snapshot {song_id} {field} differs from source: {source}")
        content_type = validate_resource(source)
        target = local_resource_path(destination, url, field, song_id)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        resources.append(
            {
                "songId": song_id,
                "field": field,
                "path": str(PurePosixPath(*target.relative_to(destination).parts)),
                "bytes": target.stat().st_size,
                "sha256": sha256_file(target),
                "contentType": content_type,
            }
        )
    target_manifest = destination / "songs" / song_id / "manifest.json"
    target_manifest.write_text(json.dumps(deployed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    validate_timeline(
        local_resource_path(destination, deployed["scoreUrl"], "scoreUrl", song_id),
        local_resource_path(destination, deployed["beatsUrl"], "beatsUrl", song_id),
    )
    return deployed, resources


def write_integrity_files(
    release_dir: Path,
    release_id: str,
    song_ids: Sequence[str],
    source_manifest_hashes: dict[str, str],
    resources: list[dict[str, object]],
) -> None:
    created_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    release_manifest = {
        "schemaVersion": 1,
        "releaseId": release_id,
        "createdAt": created_at,
        "songIds": list(song_ids),
        "buildEnv": {
            "SYRINX_RELEASE_ID": release_id,
            "VITE_SONG_IDS": ",".join(song_ids),
            "VITE_AUDIO_FORMAT": "m4a",
        },
        "sourceManifestSha256": source_manifest_hashes,
        "resources": resources,
    }
    (release_dir / "release-manifest.json").write_text(
        json.dumps(release_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    files = sorted(path for path in release_dir.rglob("*") if path.is_file() and path.name != "checksums.sha256")
    lines = [f"{sha256_file(path)}  {PurePosixPath(*path.relative_to(release_dir).parts)}" for path in files]
    (release_dir / "checksums.sha256").write_text("\n".join(lines) + "\n", encoding="utf-8")


def prepare_release(
    *,
    app_dir: Path,
    media_snapshot: Path,
    output_root: Path,
    song_ids: Sequence[str] = DEFAULT_SONG_IDS,
    release_id: str | None = None,
    dist_dir: Path | None = None,
    build_command: Sequence[str] | None = None,
) -> Path:
    app_dir = Path(app_dir).resolve()
    media_snapshot = Path(media_snapshot).resolve()
    output_root = Path(output_root).resolve()
    release_id = release_id or generate_release_id(app_dir)
    validate_release_id(release_id)
    if len(set(song_ids)) != len(song_ids) or not song_ids:
        raise ReleaseError("song allowlist must contain unique song ids")
    destination = output_root / release_id
    if destination.exists():
        raise ReleaseError(f"release already exists and is immutable: {destination}")

    manifests = load_source_manifests(app_dir, song_ids)
    for brand_file in REQUIRED_BRAND_FILES:
        validate_resource(media_snapshot / "brand" / brand_file)
    if dist_dir is None:
        run_build(app_dir, release_id, song_ids, command=build_command)
        dist_dir = app_dir / "dist"
    dist_dir = Path(dist_dir).resolve()
    index = dist_dir / "index.html"
    if not index.is_file():
        raise ReleaseError(f"build output is missing index.html: {index}")
    index_text = index.read_text(encoding="utf-8")
    expected_base = f"/releases/{release_id}/"
    if expected_base not in index_text:
        raise ReleaseError(f"build index does not reference immutable base {expected_base}")

    output_root.mkdir(parents=True, exist_ok=True)
    incoming = output_root / f".{release_id}.incoming-{secrets.token_hex(4)}"
    incoming.mkdir()
    try:
        copy_tree_without_private_songs(dist_dir, incoming)
        shutil.copytree(media_snapshot / "brand", incoming / "brand")
        resources: list[dict[str, object]] = []
        for song_id in song_ids:
            _, song_resources = stage_song(
                incoming,
                media_snapshot,
                app_dir / "public",
                song_id,
                manifests[song_id],
            )
            resources.extend(song_resources)
        source_manifest_hashes = {
            song_id: sha256_file(app_dir / "public" / "songs" / song_id / "manifest.json")
            for song_id in song_ids
        }
        write_integrity_files(
            incoming,
            release_id,
            song_ids,
            source_manifest_hashes,
            resources,
        )
        verify_release(incoming, require_directory_name=False)
        os.replace(incoming, destination)
    except Exception:
        # A failed candidate is deliberately retained for diagnosis; it is never activated.
        raise
    return destination


def parse_checksums(path: Path) -> dict[str, str]:
    checksums: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise ReleaseError(f"cannot read checksums: {exc}") from exc
    for line in lines:
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        if not match:
            raise ReleaseError(f"invalid checksum line: {line!r}")
        relative = PurePosixPath(match.group(2))
        if relative.is_absolute() or ".." in relative.parts or str(relative) in checksums:
            raise ReleaseError(f"unsafe or duplicate checksum path: {relative}")
        checksums[str(relative)] = match.group(1)
    return checksums


def verify_release(release_dir: Path, *, require_directory_name: bool = True) -> VerificationReport:
    release_dir = Path(release_dir).resolve()
    if not release_dir.is_dir():
        raise ReleaseError(f"release directory does not exist: {release_dir}")
    if any(path.is_symlink() for path in release_dir.rglob("*")):
        raise ReleaseError(f"release contains symlinks: {release_dir}")
    try:
        manifest = json.loads((release_dir / "release-manifest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReleaseError(f"invalid release-manifest.json: {exc}") from exc
    release_id = manifest.get("releaseId")
    if not isinstance(release_id, str):
        raise ReleaseError("release manifest has no releaseId")
    validate_release_id(release_id)
    if require_directory_name and release_dir.name != release_id:
        raise ReleaseError(f"release directory name {release_dir.name!r} does not match {release_id!r}")
    song_ids_value = manifest.get("songIds")
    if not isinstance(song_ids_value, list) or not all(isinstance(item, str) for item in song_ids_value):
        raise ReleaseError("release manifest has invalid songIds")
    song_ids = tuple(song_ids_value)

    index_path = release_dir / "index.html"
    try:
        index_text = index_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ReleaseError(f"release is missing index.html: {exc}") from exc
    if f"/releases/{release_id}/" not in index_text:
        raise ReleaseError(f"index.html does not use /releases/{release_id}/")

    expected = parse_checksums(release_dir / "checksums.sha256")
    actual_paths = {
        str(PurePosixPath(*path.relative_to(release_dir).parts)): path
        for path in release_dir.rglob("*")
        if path.is_file() and path.name != "checksums.sha256"
    }
    if set(expected) != set(actual_paths):
        missing = sorted(set(expected) - set(actual_paths))
        extra = sorted(set(actual_paths) - set(expected))
        raise ReleaseError(f"checksum inventory mismatch; missing={missing}, extra={extra}")
    for relative, path in actual_paths.items():
        if sha256_file(path) != expected[relative]:
            raise ReleaseError(f"checksum mismatch: {relative}")
        validate_resource(path)

    resources = manifest.get("resources")
    if not isinstance(resources, list):
        raise ReleaseError("release manifest has invalid resources")
    resource_paths: set[str] = set()
    for item in resources:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise ReleaseError("release manifest has invalid resource metadata")
        relative = item["path"]
        if relative in resource_paths or relative not in actual_paths:
            raise ReleaseError(f"release manifest has invalid resource metadata for {relative}")
        resource_paths.add(relative)
        path = actual_paths[relative]
        if (
            item.get("sha256") != expected[relative]
            or item.get("bytes") != path.stat().st_size
            or item.get("contentType") != sniff_content_type(path)
        ):
            raise ReleaseError(f"release manifest resource metadata mismatch: {relative}")

    song_dirs = {path.name for path in (release_dir / "songs").iterdir() if path.is_dir()}
    if song_dirs != set(song_ids):
        raise ReleaseError(f"song directory allowlist mismatch: {sorted(song_dirs)}")
    if any((release_dir / "songs").rglob("*.mp3")):
        raise ReleaseError("release contains raw MP3 song media")
    for song_id in song_ids:
        deployed_path = release_dir / "songs" / song_id / "manifest.json"
        try:
            deployed = json.loads(deployed_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ReleaseError(f"invalid deployed manifest for {song_id}: {exc}") from exc
        if not str(deployed.get("accompanimentUrl", "")).endswith(".m4a"):
            raise ReleaseError(f"deployed manifest for {song_id} does not point to AAC m4a")
        for field in URL_FIELDS:
            if field in deployed:
                resource = local_resource_path(release_dir, deployed[field], field, song_id)
                if not resource.is_file():
                    raise ReleaseError(f"deployed resource missing for {song_id} {field}: {resource}")
        validate_timeline(
            local_resource_path(release_dir, deployed["scoreUrl"], "scoreUrl", song_id),
            local_resource_path(release_dir, deployed["beatsUrl"], "beatsUrl", song_id),
        )
    return VerificationReport(release_id=release_id, song_ids=song_ids, file_count=len(actual_paths))


def install_release(candidate: Path, release_root: Path) -> Path:
    candidate = Path(candidate).resolve()
    report = verify_release(candidate)
    release_root = Path(release_root).resolve()
    release_root.mkdir(parents=True, exist_ok=True)
    destination = release_root / report.release_id
    if destination.exists():
        raise ReleaseError(f"release already exists and is immutable: {destination}")
    incoming = release_root / f".{report.release_id}.incoming-{secrets.token_hex(4)}"
    shutil.copytree(candidate, incoming)
    verify_release(incoming, require_directory_name=False)
    os.replace(incoming, destination)
    return destination


def release_probe_paths(release_dir: Path) -> list[str]:
    report = verify_release(release_dir)
    manifest = json.loads((release_dir / "release-manifest.json").read_text(encoding="utf-8"))
    paths = [f"/releases/{report.release_id}/index.html"]
    assets = release_dir / "assets"
    if assets.is_dir():
        paths.extend(
            f"/releases/{report.release_id}/{PurePosixPath(*path.relative_to(release_dir).parts)}"
            for path in sorted(assets.rglob("*"))
            if path.is_file()
        )
    paths.extend(f"/releases/{report.release_id}/{item['path']}" for item in manifest["resources"])
    return paths


def probe_urls(
    urls: Iterable[str],
    *,
    resolve: str | None = None,
    curl_bin: str = "curl",
    connect_timeout: float = 10,
    max_time: float = 45,
) -> None:
    for url in urls:
        command = [
            curl_bin,
            "--fail",
            "--show-error",
            "--silent",
            "--connect-timeout",
            str(connect_timeout),
            "--max-time",
            str(max_time),
            "--output",
            os.devnull,
        ]
        if resolve:
            command.extend(["--resolve", resolve])
        command.append(url)
        try:
            subprocess.run(command, check=True, capture_output=True, text=True)
        except (OSError, subprocess.CalledProcessError) as exc:
            detail = getattr(exc, "stderr", "") or str(exc)
            raise ReleaseError(f"HTTP probe failed for {url}: {detail.strip()}") from exc


def atomic_copy(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.parent / f".{target.name}.tmp-{secrets.token_hex(4)}"
    shutil.copy2(source, temporary)
    # Windows only exposes a flushable OS handle for fsync when the file is
    # opened writable; Linux accepts this mode as well.
    with temporary.open("r+b") as stream:
        os.fsync(stream.fileno())
    os.replace(temporary, target)


def activate_release(
    release_dir: Path,
    live_root: Path,
    *,
    probe_base_url: str | Sequence[str] | None = None,
    resolve: str | None = None,
    curl_bin: str = "curl",
) -> ActivationResult:
    release_dir = Path(release_dir).resolve()
    report = verify_release(release_dir)
    live_root = Path(live_root).resolve()
    live_root.mkdir(parents=True, exist_ok=True)
    current_index = live_root / "index.html"
    if not current_index.is_file():
        raise ReleaseError(f"live entry point is missing: {current_index}")

    release_paths = release_probe_paths(release_dir)
    probe_origins = (
        (probe_base_url,)
        if isinstance(probe_base_url, str)
        else tuple(probe_base_url or ())
    )
    if probe_origins:
        preflight = [
            urljoin(origin.rstrip("/") + "/", path.lstrip("/"))
            for origin in probe_origins
            for path in release_paths
        ]
        probe_urls(preflight, resolve=resolve, curl_bin=curl_bin)

    history = live_root / ".index-history"
    history.mkdir(exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    previous_index = history / f"{timestamp}-before-{report.release_id}.html"
    shutil.copy2(current_index, previous_index)
    atomic_copy(release_dir / "index.html", current_index)

    if probe_origins:
        post_urls = [origin.rstrip("/") + "/" for origin in probe_origins] + [
            urljoin(origin.rstrip("/") + "/", path.lstrip("/"))
            for origin in probe_origins
            for path in release_paths
        ]
        try:
            probe_urls(post_urls, resolve=resolve, curl_bin=curl_bin)
        except ReleaseError:
            atomic_copy(previous_index, current_index)
            raise
    return ActivationResult(release_id=report.release_id, previous_index=previous_index)


def rollback_release(
    release_id: str,
    release_root: Path,
    live_root: Path,
    *,
    probe_base_url: str | Sequence[str] | None = None,
    resolve: str | None = None,
    curl_bin: str = "curl",
) -> ActivationResult:
    validate_release_id(release_id)
    release_root = Path(release_root).resolve()
    target = (release_root / release_id).resolve()
    if target.parent != release_root:
        raise ReleaseError("rollback target escapes release root")
    return activate_release(
        target,
        live_root,
        probe_base_url=probe_base_url,
        resolve=resolve,
        curl_bin=curl_bin,
    )


def publish_release(
    candidate: Path,
    release_root: Path,
    live_root: Path,
    *,
    probe_base_url: str | Sequence[str],
    resolve: str | None = None,
    curl_bin: str = "curl",
) -> ActivationResult:
    installed = install_release(candidate, release_root)
    return activate_release(
        installed,
        live_root,
        probe_base_url=probe_base_url,
        resolve=resolve,
        curl_bin=curl_bin,
    )


def csv_song_ids(value: str) -> tuple[str, ...]:
    result = tuple(item.strip() for item in value.split(",") if item.strip())
    if not result:
        raise argparse.ArgumentTypeError("song list cannot be empty")
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare = subparsers.add_parser("prepare", help="build and stage an immutable release")
    prepare.add_argument("--app-dir", type=Path, default=Path("app"))
    prepare.add_argument("--media-snapshot", type=Path, required=True)
    prepare.add_argument("--output-root", type=Path, required=True)
    prepare.add_argument("--release-id")
    prepare.add_argument("--song-ids", type=csv_song_ids, default=DEFAULT_SONG_IDS)
    prepare.add_argument("--dist-dir", type=Path, help="use an existing build output (fixture/recovery only)")

    verify = subparsers.add_parser("verify", help="verify checksums, media, and allowlisted resources")
    verify.add_argument("--release-dir", type=Path, required=True)

    install = subparsers.add_parser("install", help="copy a verified candidate into the release root")
    install.add_argument("--candidate", type=Path, required=True)
    install.add_argument("--release-root", type=Path, required=True)

    publish = subparsers.add_parser("publish", help="install, HTTP probe, and atomically activate")
    publish.add_argument("--candidate", type=Path, required=True)
    publish.add_argument("--release-root", type=Path, default=Path("/var/www/syrinx-releases"))
    publish.add_argument("--live-root", type=Path, default=Path("/var/www/syrinx"))
    publish.add_argument("--probe-base-url", action="append", required=True)
    publish.add_argument("--resolve")
    publish.add_argument("--curl-bin", default="curl")

    rollback = subparsers.add_parser("rollback", help="atomically reactivate an existing release")
    rollback.add_argument("--release-id", required=True)
    rollback.add_argument("--release-root", type=Path, default=Path("/var/www/syrinx-releases"))
    rollback.add_argument("--live-root", type=Path, default=Path("/var/www/syrinx"))
    rollback.add_argument("--probe-base-url", action="append")
    rollback.add_argument("--resolve")
    rollback.add_argument("--curl-bin", default="curl")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "prepare":
            result = prepare_release(
                app_dir=args.app_dir,
                media_snapshot=args.media_snapshot,
                output_root=args.output_root,
                song_ids=args.song_ids,
                release_id=args.release_id,
                dist_dir=args.dist_dir,
            )
            print(result)
        elif args.command == "verify":
            report = verify_release(args.release_dir)
            print(json.dumps(report.__dict__, ensure_ascii=False))
        elif args.command == "install":
            print(install_release(args.candidate, args.release_root))
        elif args.command == "publish":
            result = publish_release(
                args.candidate,
                args.release_root,
                args.live_root,
                probe_base_url=args.probe_base_url,
                resolve=args.resolve,
                curl_bin=args.curl_bin,
            )
            print(json.dumps({"releaseId": result.release_id, "previousIndex": str(result.previous_index)}))
        elif args.command == "rollback":
            result = rollback_release(
                args.release_id,
                args.release_root,
                args.live_root,
                probe_base_url=args.probe_base_url,
                resolve=args.resolve,
                curl_bin=args.curl_bin,
            )
            print(json.dumps({"releaseId": result.release_id, "previousIndex": str(result.previous_index)}))
        return 0
    except ReleaseError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
