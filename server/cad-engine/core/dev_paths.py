"""Paths for optional source verification tools, never imported by converters."""
from pathlib import Path
CORE = Path(__file__).resolve().parent
REPO = CORE.parents[2]
DATA = REPO / '.cad-work/research'
BROWSER = REPO / 'frontend/public/cad-viewer/core'
