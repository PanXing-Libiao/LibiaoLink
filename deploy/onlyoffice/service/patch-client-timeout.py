#!/usr/bin/env python3
"""Raise the DocServer editor bootstrap watchdog above the host viewer timeout.

The upstream editor pages hard-code a 30 second RequireJS watchdog. On a cold
mobile browser that fires before the mobile UI asset graph finishes, then the
page alerts and reloads. The host viewer already owns timeout, retry and
download fallback, so the embedded watchdog must not pre-empt it.
"""
from pathlib import Path
import sys

TIMEOUT_SECONDS = 120
EDITORS = (
    "documenteditor/main/index.html",
    "spreadsheeteditor/main/index.html",
    "presentationeditor/main/index.html",
    "pdfeditor/main/index.html",
)
DEFAULT_ROOT = Path("/var/www/onlyoffice/documentserver/web-apps/apps")


def main() -> None:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_ROOT
    wait_from = "waitSeconds: 30"
    wait_to = "waitSeconds: " + str(TIMEOUT_SECONDS)
    timer_from = "}, 30000);"
    timer_to = "}, " + str(TIMEOUT_SECONDS * 1000) + ");"
    for relative in EDITORS:
        path = root / relative
        text = path.read_text(encoding="utf-8")
        if wait_to in text and timer_to in text:
            print("already patched: " + relative)
            continue
        if text.count(wait_from) != 1 or text.count(timer_from) != 1:
            raise RuntimeError("unexpected watchdog shape: " + relative)
        text = text.replace(wait_from, wait_to, 1).replace(timer_from, timer_to, 1)
        path.write_text(text, encoding="utf-8")
        print("patched: " + relative)


if __name__ == "__main__":
    main()
