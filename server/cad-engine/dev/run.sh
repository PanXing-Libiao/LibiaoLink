#!/bin/sh
set -eu
cd "$(dirname "$0")/../../.."
CAD_WORK="$PWD/.cad-work"
export PYTHONDONTWRITEBYTECODE=1
export CAD_OCCT_PYTHON="$CAD_WORK/occt/bin/python"
export CAD_DXF_PYTHON="$CAD_WORK/dxf/bin/python"
export CAD_STEP_MESHER_PYTHON="$CAD_WORK/step-mesher/bin/python"
if [ ! -x "$CAD_OCCT_PYTHON" ] || [ ! -x "$CAD_DXF_PYTHON" ] || [ ! -x "$CAD_STEP_MESHER_PYTHON" ]; then
    echo 'Run sh server/cad-engine/dev/setup-runtime.sh first.' >&2
    exit 1
fi
exec "$CAD_OCCT_PYTHON" server/cad-engine/dev/server.py "${@:-8795}"
