"""Locate the editable DXF fork and identify parse-affecting source changes."""
from functools import lru_cache
import hashlib
import os
from pathlib import Path

ENGINE = '1.4.2'
SOURCE_ROOT = Path(__file__).resolve().parents[1] / 'vendor' / 'ezdxf' / 'src' / 'ezdxf'


@lru_cache(maxsize=1)
def require_engine():
    import ezdxf
    imported = Path(ezdxf.__file__).resolve().parent
    installed = os.environ.get('CAD_DXF_IMPORT_MODE') == 'installed'
    if (ezdxf.__version__ != ENGINE or (not installed and imported != SOURCE_ROOT)):
        raise ValueError('missing-dxf-runtime: install the repository ezdxf source with sh server/cad-engine/dev/setup-runtime.sh dxf')
    if installed:
        # Production uses a normal wheel build of this fork, never a same-version
        # PyPI substitute. Check the installed Python sources before parsing.
        for source in SOURCE_ROOT.rglob('*.py'):
            target = imported / source.relative_to(SOURCE_ROOT)
            if not target.is_file() or hashlib.sha256(target.read_bytes()).digest() != hashlib.sha256(source.read_bytes()).digest():
                raise ValueError('missing-dxf-runtime: installed fork source mismatch')
    return ezdxf


@lru_cache(maxsize=1)
def source_digest():
    # Like imported modules, this is fixed for a process; restart after source edits.
    if not (SOURCE_ROOT / '__init__.py').is_file():
        raise ValueError('missing-dxf-runtime: repository ezdxf source is missing')
    digest = hashlib.sha256()
    for path in sorted(SOURCE_ROOT.rglob('*')):
        if path.is_file() and (path.suffix in ('.py', '.pyx', '.pxd', '.h') or path.name == 'py.typed'):
            digest.update(path.relative_to(SOURCE_ROOT).as_posix().encode())
            digest.update(b'\0')
            digest.update(path.read_bytes())
            digest.update(b'\0')
    return digest.hexdigest()
