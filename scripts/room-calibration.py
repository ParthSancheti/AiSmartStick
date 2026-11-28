"""Capture a spoken, timed room trial on Windows. Raw data stays on this PC."""
import json
import os
import subprocess
import argparse
import time
from datetime import datetime
from pathlib import Path
from urllib.request import ProxyHandler, build_opener

client = build_opener(ProxyHandler({}))


def read(endpoint):
    with client.open("http://192.168.4.1/api/v1/" + endpoint, timeout=3) as response:
        return response.read()


def speak(words):
    print(words, flush=True)
    subprocess.run(["powershell.exe", "-NoProfile", "-Command",
                    "(New-Object -ComObject SAPI.SpVoice).Speak($env:STICK_PROMPT) | Out-Null"],
                   env={**os.environ, "STICK_PROMPT": words}, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--walk", action="store_true", help="Record a guided walking trial")
    args = parser.parse_args()
    print(read("device").decode(), flush=True)
    folder = Path.home() / "SmartStick-tests" / datetime.now().strftime("%Y%m%d-%H%M%S")
    folder.mkdir(parents=True)
    print(folder, flush=True)
    steps = [
        ("upright", "Hold the stick upright in its normal position. Hold still.", 8),
        ("forward", "Tilt the top forward twenty degrees, away from you. Hold.", 8),
        ("right", "Return upright. Tilt the top to your right twenty degrees. Hold.", 8),
        ("upright_again", "Return upright and hold still.", 8),
        ("scene", "Keep the stick upright. Stand eight feet in front of the camera.", 16),
    ]
    if args.walk:
        steps = [
            ("hold", "Hold the stick still at your usual walking angle.", 5),
            ("walk", "In a clear familiar path, walk a few normal steps with your usual sweep. Stop when you reach the end.", 8),
            ("stop", "Stop now. Hold the stick still in your usual position.", 4),
            ("set_down", "Gently lay just the stick on the bed. Leave it still.", 6),
            ("recover", "Pick up the stick and hold it at your usual walking angle again.", 6),
        ]
    (folder / "config.json").write_bytes(read("config"))
    with (folder / "samples.jsonl").open("x", encoding="utf8") as log:
        for stage, cue, preparation in steps:
            speak(cue)
            start = time.monotonic()
            while time.monotonic() - start < preparation + 5:
                elapsed = time.monotonic() - start
                record = dict(stage=stage, seconds=elapsed, time=time.time(), settled=elapsed >= preparation)
                try:
                    record["packet"] = json.loads(read("telemetry"))
                except OSError as exc:
                    record["error"] = str(exc)
                print(json.dumps(record), file=log, flush=True)
                time.sleep(0.2)
            try:
                (folder / (stage + ".jpg")).write_bytes(read("capture"))
            except OSError as exc:
                print(exc, flush=True)
    speak("Room measurements finished. You may put the stick down.")


if __name__ == "__main__":
    main()
