#!/bin/sh
# Native libraries stay in separate processes/environments.
set -eu
cd "$(dirname "$0")/.."
CAD_REPO=$(cd ../.. && pwd)
CAD_PYTHON=${CAD_SETUP_PYTHON:-python3.13}
if [ "$#" -eq 0 ]; then set -- occt step-mesher dxf acis; fi
for CAD_RUNTIME in "$@"; do
    CAD_ENV="$CAD_REPO/.cad-work/$CAD_RUNTIME"
    if [ ! -x "$CAD_ENV/bin/python" ]; then "$CAD_PYTHON" -m venv "$CAD_ENV"; fi
    case "$CAD_RUNTIME" in
        occt) "$CAD_ENV/bin/python" -m pip install --only-binary=:all: --no-deps -r requirements-step.txt ;;
        step-mesher) "$CAD_ENV/bin/python" -m pip install --only-binary=:all: --no-deps -r requirements-step-mesher.txt ;;
        acis)
            "$CAD_ENV/bin/python" -m pip install --only-binary=:all: --no-deps -r requirements-step.txt -r requirements-dwg.txt -r requirements-acis.txt
            PYTHONPATH=core/vendor/ezdxf/src "$CAD_ENV/bin/python" -c 'import cq_acis, cadquery'
            ;;
        dxf)
            "$CAD_ENV/bin/python" -m pip install -r requirements-dxf-build.txt
            "$CAD_ENV/bin/python" -m pip install --no-build-isolation -r requirements-dxf.txt
            PYTHONPATH=core "$CAD_ENV/bin/python" -c 'from unified.dxf_runtime import require_engine; e=require_engine(); print(e.__file__)'
            ;;
        *) echo "Unknown runtime: $CAD_RUNTIME" >&2; exit 2 ;;
    esac
done
