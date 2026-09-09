from __future__ import annotations

import functools
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

from release import (  # noqa: E402
    DEFAULT_SONG_IDS,
    ReleaseError,
    activate_release,
    install_release,
    prepare_release,
    probe_urls,
    release_probe_paths,
    rollback_release,
    run_build,
    verify_release,
)


JPEG = b"\xff\xd8\xff\xe0fixture-jpeg\xff\xd9"
M4A = b"\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00M4A isom"
MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x00\x00isommp42"
XML = b'<?xml version="1.0"?><score-partwise version="4.0"></score-partwise>'
BEATS = json.dumps(
    {
        "version": 1,
        "bpm": 100,
        "anchors": [{"m": 1, "t": 0.0}, {"m": 2, "t": 1.0}],
        "beatAnchors": [{"q": 0, "t": 0.0}, {"q": 1, "t": 0.6}],
    }
).encode()


def write(path: Path, data: bytes | str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data.encode() if isinstance(data, str) else data)


def manifest(song_id: str) -> dict[str, object]:
    base = f"/songs/{song_id}"
    return {
        "id": song_id,
        "title": song_id,
        "composer": "Fixture",
        "difficulty": 2,
        "scoreUrl": f"{base}/score.musicxml",
        "pianoScoreUrl": f"{base}/piano.musicxml",
        "beatsUrl": f"{base}/beats.json",
        "accompanimentUrl": f"{base}/accompaniment.mp3",
        "coverUrl": f"{base}/cover.jpg",
        "backgroundVideoUrl": f"{base}/background.mp4",
        "hoverVideoUrl": f"{base}/hover-square.mp4",
        "accent": "#ffffff",
        "backgroundTheme": "aurora",
    }


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return


class ReleaseFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.media_temp = tempfile.TemporaryDirectory()
        media_root = Path(cls.media_temp.name)
        cls.valid_m4a = media_root / "valid.m4a"
        cls.valid_mp4 = media_root / "valid.mp4"
        cls.valid_mp3 = media_root / "valid.mp3"
        commands = (
            ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "0.1", "-c:a", "aac", "-y", str(cls.valid_m4a)],
            ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=16x16:r=1", "-t", "1", "-c:v", "mpeg4", "-y", str(cls.valid_mp4)],
            ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "0.1", "-c:a", "libmp3lame", "-y", str(cls.valid_mp3)],
        )
        try:
            for command in commands:
                subprocess.run(command, check=True, capture_output=True)
        except (OSError, subprocess.CalledProcessError) as exc:
            raise unittest.SkipTest(f"ffmpeg is required for release media tests: {exc}")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.media_temp.cleanup()

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.app = self.root / "app"
        self.dist = self.root / "dist"
        self.snapshot = self.root / "snapshot"
        self.output = self.root / "staging"
        self.release_id = "20260909T120000Z-deadbee-a1b2c3d4"
        self.song_ids = ("alpha", "beta")

        write(self.dist / "index.html", f'<script src="/releases/{self.release_id}/assets/app.js"></script>')
        write(self.dist / "assets" / "app.js", "console.log('fixture')")
        write(self.dist / "songs" / "private-song" / "secret.mp3", b"private")
        write(self.dist / "brand" / "syrinx-logo-white.jpg", JPEG + b"raw")
        write(self.dist / "favicon.png", b"\x89PNG\r\n\x1a\nfixture")

        for name in ("flute.jpg", "syrinx-logo-dark.jpg", "syrinx-logo-white.jpg"):
            write(self.snapshot / "brand" / name, JPEG + name.encode())

        for song_id in self.song_ids:
            data = manifest(song_id)
            source = self.app / "public" / "songs" / song_id
            write(source / "manifest.json", json.dumps(data))
            write(source / "score.musicxml", XML)
            write(source / "piano.musicxml", XML)
            write(source / "beats.json", BEATS)
            write(source / "accompaniment.mp3", self.valid_mp3.read_bytes())
            write(source / "cover.jpg", JPEG)
            write(source / "background.mp4", self.valid_mp4.read_bytes())
            write(source / "hover-square.mp4", self.valid_mp4.read_bytes())

            optimized = self.snapshot / "songs" / song_id
            write(optimized / "score.musicxml", XML)
            write(optimized / "piano.musicxml", XML)
            write(optimized / "beats.json", BEATS)
            write(optimized / "accompaniment.m4a", self.valid_m4a.read_bytes())
            write(optimized / "cover.jpg", JPEG + b"optimized")
            write(optimized / "background.mp4", self.valid_mp4.read_bytes())
            write(optimized / "hover-square.mp4", self.valid_mp4.read_bytes())

    def tearDown(self) -> None:
        self.temp.cleanup()

    def prepare(self, release_id: str | None = None) -> Path:
        return prepare_release(
            app_dir=self.app,
            media_snapshot=self.snapshot,
            output_root=self.output,
            song_ids=self.song_ids,
            release_id=release_id or self.release_id,
            dist_dir=self.dist,
        )

    def test_prepare_stages_only_allowlisted_optimized_song_media(self) -> None:
        release = self.prepare()

        self.assertFalse((release / "songs" / "private-song").exists())
        self.assertFalse(any(release.glob("songs/**/*.mp3")))
        self.assertEqual((release / "songs/alpha/accompaniment.m4a").read_bytes(), self.valid_m4a.read_bytes())
        self.assertEqual(
            json.loads((release / "songs/alpha/manifest.json").read_text())["accompanimentUrl"],
            "/songs/alpha/accompaniment.m4a",
        )
        self.assertEqual(
            (release / "brand/syrinx-logo-white.jpg").read_bytes(),
            JPEG + b"syrinx-logo-white.jpg",
        )
        self.assertEqual(
            (self.app / "public/songs/alpha/accompaniment.mp3").read_bytes(),
            self.valid_mp3.read_bytes(),
        )

        report = verify_release(release)
        self.assertEqual(report.release_id, self.release_id)
        self.assertEqual(report.song_ids, self.song_ids)
        release_manifest = json.loads((release / "release-manifest.json").read_text())
        self.assertEqual(
            release_manifest["sourceManifestSha256"]["alpha"],
            hashlib.sha256((self.app / "public/songs/alpha/manifest.json").read_bytes()).hexdigest(),
        )
        audio = next(item for item in release_manifest["resources"] if item["path"].endswith(".m4a"))
        self.assertEqual(audio["contentType"], "audio/mp4")
        self.assertEqual(audio["sha256"], hashlib.sha256(self.valid_m4a.read_bytes()).hexdigest())

    def test_prepare_rejects_snapshot_timeline_that_diverged_from_source(self) -> None:
        changed = json.loads(BEATS)
        changed["beatAnchors"][1]["t"] = 0.7
        write(self.snapshot / "songs/alpha/beats.json", json.dumps(changed))

        with self.assertRaisesRegex(ReleaseError, "differs from source"):
            self.prepare()

    def test_prepare_rejects_m4a_header_when_media_is_not_decodable(self) -> None:
        write(self.snapshot / "songs/alpha/accompaniment.m4a", M4A)

        with self.assertRaisesRegex(ReleaseError, "ffprobe"):
            self.prepare()

    def test_prepare_validates_source_manifest_before_running_build(self) -> None:
        (self.app / "public/songs/alpha/score.musicxml").unlink()
        marker = self.root / "build-ran"
        build_script = self.root / "fake_build.py"
        write(build_script, f"from pathlib import Path\nPath({str(marker)!r}).write_text('ran')\n")

        with self.assertRaisesRegex(ReleaseError, "score.musicxml"):
            prepare_release(
                app_dir=self.app,
                media_snapshot=self.snapshot,
                output_root=self.output,
                song_ids=self.song_ids,
                release_id=self.release_id,
                build_command=[sys.executable, str(build_script)],
            )

        self.assertFalse(marker.exists(), "invalid song resources must stop before build")

    def test_prepare_rejects_fake_m4a_and_keeps_destination_absent(self) -> None:
        write(self.snapshot / "songs/alpha/accompaniment.m4a", b"this is not an m4a")

        with self.assertRaisesRegex(ReleaseError, "audio/mp4"):
            self.prepare()

        self.assertFalse((self.output / self.release_id).exists())

    def test_prepare_never_overwrites_an_existing_release_id(self) -> None:
        first = self.prepare()
        sentinel = first / "sentinel"
        write(sentinel, "keep")

        with self.assertRaisesRegex(ReleaseError, "already exists"):
            self.prepare()

        self.assertEqual(sentinel.read_text(), "keep")

    def test_run_build_exports_release_song_and_audio_environment(self) -> None:
        capture = self.root / "env.json"
        build_script = self.root / "capture_env.py"
        write(
            build_script,
            "import json, os, pathlib\n"
            f"pathlib.Path({str(capture)!r}).write_text(json.dumps({{k: os.environ.get(k) for k in "
            "['SYRINX_RELEASE_ID', 'VITE_SONG_IDS', 'VITE_AUDIO_FORMAT']}))\n",
        )

        run_build(
            self.app,
            self.release_id,
            self.song_ids,
            command=[sys.executable, str(build_script)],
        )

        self.assertEqual(
            json.loads(capture.read_text()),
            {
                "SYRINX_RELEASE_ID": self.release_id,
                "VITE_SONG_IDS": "alpha,beta",
                "VITE_AUDIO_FORMAT": "m4a",
            },
        )

    def test_install_verifies_checksums_and_never_replaces_a_release(self) -> None:
        candidate = self.prepare()
        release_root = self.root / "server/releases"
        installed = install_release(candidate, release_root)
        self.assertEqual(installed, release_root / self.release_id)
        self.assertTrue((installed / "checksums.sha256").is_file())

        write(candidate / "assets/app.js", "tampered")
        with self.assertRaisesRegex(ReleaseError, "checksum"):
            install_release(candidate, self.root / "other-releases")

        with self.assertRaisesRegex(ReleaseError, "already exists"):
            install_release(installed, release_root)

    def test_verify_cross_checks_resource_hashes_inside_release_manifest(self) -> None:
        release = self.prepare()
        manifest_path = release / "release-manifest.json"
        data = json.loads(manifest_path.read_text())
        data["resources"][0]["sha256"] = "0" * 64
        manifest_path.write_text(json.dumps(data), encoding="utf-8")
        checksum_path = release / "checksums.sha256"
        lines = checksum_path.read_text().splitlines()
        replacement = f"{hashlib.sha256(manifest_path.read_bytes()).hexdigest()}  release-manifest.json"
        checksum_path.write_text("\n".join(replacement if line.endswith("  release-manifest.json") else line for line in lines) + "\n")

        with self.assertRaisesRegex(ReleaseError, "resource metadata"):
            verify_release(release)

    def test_verify_blocks_a_release_with_missing_song_resources(self) -> None:
        release = self.prepare()
        shutil.rmtree(release / "songs")

        with self.assertRaisesRegex(ReleaseError, "checksum inventory mismatch"):
            verify_release(release)

    def test_switch_retains_previous_index_and_rollback_is_atomic(self) -> None:
        first = self.prepare()
        release_root = self.root / "server/releases"
        first = install_release(first, release_root)
        live_root = self.root / "server/live"
        write(live_root / "index.html", "legacy-index")

        activation = activate_release(first, live_root)
        self.assertIn(self.release_id, (live_root / "index.html").read_text())
        self.assertEqual(activation.previous_index.read_text(), "legacy-index")

        second_id = "20260909T120100Z-feedbee-e5f6a7b8"
        (self.dist / "index.html").write_text(f'<script src="/releases/{second_id}/assets/app.js"></script>')
        second = self.prepare(second_id)
        second = install_release(second, release_root)
        activate_release(second, live_root)
        self.assertIn(second_id, (live_root / "index.html").read_text())

        rollback_release(self.release_id, release_root, live_root)
        self.assertIn(self.release_id, (live_root / "index.html").read_text())
        self.assertFalse(any(live_root.glob("*.tmp")))

    def test_failed_post_switch_http_probe_restores_previous_index(self) -> None:
        candidate = self.prepare()
        shutil.copytree(candidate, self.root / "releases" / self.release_id)
        live_root = self.root / "server/live"
        write(live_root / "index.html", "known-good-index")

        with self.serve(self.root, status=200, root_status=404) as base_url:
            with self.assertRaisesRegex(ReleaseError, "HTTP probe failed"):
                activate_release(candidate, live_root, probe_base_url=base_url)

        self.assertEqual((live_root / "index.html").read_text(), "known-good-index")
        backups = list((live_root / ".index-history").glob("*.html"))
        self.assertEqual(len(backups), 1, "the post-switch branch must retain the previous entry")
        self.assertEqual(backups[0].read_text(), "known-good-index")

    def test_http_probe_treats_404_as_failure(self) -> None:
        with self.serve(self.root, status=404) as base_url:
            with self.assertRaisesRegex(ReleaseError, "HTTP probe failed"):
                probe_urls([f"{base_url}/missing"])

    def test_http_probe_enforces_a_maximum_duration(self) -> None:
        started = time.monotonic()
        with self.serve(self.root, status=200, delay=2.0) as base_url:
            with self.assertRaisesRegex(ReleaseError, "HTTP probe failed"):
                probe_urls([f"{base_url}/slow"], connect_timeout=0.2, max_time=0.2)
        self.assertLess(time.monotonic() - started, 1.5)

    def test_release_probe_paths_include_built_javascript_and_css(self) -> None:
        write(self.dist / "assets/app.css", "body{}")
        release = self.prepare()

        paths = release_probe_paths(release)

        self.assertIn(f"/releases/{self.release_id}/assets/app.js", paths)
        self.assertIn(f"/releases/{self.release_id}/assets/app.css", paths)

    def test_every_probe_origin_must_pass_before_entry_switch(self) -> None:
        candidate = self.prepare()
        shutil.copytree(candidate, self.root / "releases" / self.release_id)
        live_root = self.root / "server/live"
        write(live_root / "index.html", "known-good-index")

        with self.serve(self.root, status=200) as internal_url, self.serve(self.root, status=404) as public_url:
            with self.assertRaisesRegex(ReleaseError, "HTTP probe failed"):
                activate_release(candidate, live_root, probe_base_url=[internal_url, public_url])

        self.assertEqual((live_root / "index.html").read_text(), "known-good-index")
        self.assertFalse((live_root / ".index-history").exists())

    class serve:
        def __init__(self, root: Path, status: int = 200, delay: float = 0, root_status: int | None = None):
            self.root = root
            self.status = status
            self.delay = delay
            self.root_status = root_status

        def __enter__(self) -> str:
            status = self.status
            delay = self.delay
            root_status = self.root_status

            class Handler(QuietHandler):
                def do_GET(self) -> None:
                    if delay:
                        time.sleep(delay)
                        return
                    if self.path == "/" and root_status is not None:
                        self.send_error(root_status)
                        return
                    if status != 200:
                        self.send_error(status)
                        return
                    super().do_GET()

            handler = functools.partial(Handler, directory=str(self.root))
            self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            self.server.daemon_threads = True
            self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
            self.thread.start()
            return f"http://127.0.0.1:{self.server.server_port}"

        def __exit__(self, *_args: object) -> None:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=5)


class DefaultsTest(unittest.TestCase):
    def test_production_song_allowlist_is_explicit(self) -> None:
        self.assertEqual(
            DEFAULT_SONG_IDS,
            ("luv-letter", "flower-dance", "expedition-33", "interstellar"),
        )


if __name__ == "__main__":
    unittest.main()
