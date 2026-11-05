"""Local research fixtures are outside the shared source tree."""
from pathlib import Path
import os
import sys

CORE = Path(__file__).resolve().parents[1]
ENGINE = CORE.parent
REPO = ENGINE.parents[1]
DATA = Path(os.environ.get('CAD_TEST_DATA', str(REPO / '.cad-work/research')))
WORK = REPO / '.cad-work'
BROWSER = REPO / 'frontend/public/cad-viewer/core'
SAMPLE_ROOT = DATA / 'viewer/samples'
sys.path[:0] = [str(CORE), str(ENGINE / 'dev')]
