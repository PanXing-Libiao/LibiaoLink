# syntax=docker/dockerfile:1
FROM mirror.gcr.io/library/python:3.13.13-slim-bookworm@sha256:355bfa66770995d7e9a0da4b3473b44d0cb451f6b56f5615ad9c39e3c4eca03f AS native
COPY server/cad-engine/requirements-step.txt server/cad-engine/requirements-step-mesher.txt /tmp/
# OCP 7.9.3 uses the pinned proxy and upstream VTK cp313 wheels.
# Keep these explicit because this runtime is installed with --no-deps.
RUN python -m venv /opt/ocp \
 && /opt/ocp/bin/pip install --no-cache-dir --only-binary=:all: --no-deps -r /tmp/requirements-step.txt \
 && python -m venv /opt/mesher \
 && /opt/mesher/bin/pip install --no-cache-dir --only-binary=:all: --no-deps -r /tmp/requirements-step-mesher.txt

FROM native AS drawing
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*
COPY server/cad-engine/requirements-dxf*.txt /tmp/
COPY server/cad-engine/core/vendor/ezdxf /tmp/ezdxf
RUN python -m venv /opt/dxf \
 && /opt/dxf/bin/pip install --no-cache-dir --only-binary=:all: --no-deps -r /tmp/requirements-dxf-build.txt \
 && sed '/^-e /d' /tmp/requirements-dxf.txt > /tmp/dxf-runtime.txt \
 && /opt/dxf/bin/pip install --no-cache-dir --only-binary=:all: --no-deps -r /tmp/dxf-runtime.txt \
 && /opt/dxf/bin/pip install --no-cache-dir --no-build-isolation --no-deps /tmp/ezdxf

FROM mirror.gcr.io/library/python:3.13.13-slim-bookworm@sha256:355bfa66770995d7e9a0da4b3473b44d0cb451f6b56f5615ad9c39e3c4eca03f AS dwg-reader
RUN apt-get update && apt-get install -y --no-install-recommends build-essential ca-certificates && rm -rf /var/lib/apt/lists/*
COPY server/cad-engine/core/vendor/libredwg/build-reader.py /tmp/build-reader.py
COPY server/cad-engine/core/unified/dwg-reader.json /tmp/dwg-reader.json
RUN python /tmp/build-reader.py /tmp/dwg-reader.json /opt/dwg


FROM mcr.microsoft.com/dotnet/sdk:10.0.403-noble@sha256:de4fe90a98845d75910b9769662465c84de1a934665c431279d1382b2bddc02b AS dotnet-sdk
FROM mirror.gcr.io/library/python:3.13.13-slim-bookworm@sha256:355bfa66770995d7e9a0da4b3473b44d0cb451f6b56f5615ad9c39e3c4eca03f AS native-dwg
COPY --from=dotnet-sdk /usr/share/dotnet /opt/dotnet
RUN apt-get update && apt-get install -y --no-install-recommends libicu72 && rm -rf /var/lib/apt/lists/*
COPY server/cad-engine/dwg-reader /src/dwg-reader
RUN python /src/dwg-reader/build.py --work /build/dwg --dotnet /opt/dotnet/dotnet

FROM mirror.gcr.io/library/python:3.13.13-slim-bookworm@sha256:355bfa66770995d7e9a0da4b3473b44d0cb451f6b56f5615ad9c39e3c4eca03f
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglu1-mesa libglib2.0-0 libxrender1 libxext6 libsm6 libxcursor1 libxinerama1 libxft2 libxi6 libxrandr2 libgomp1 libicu72 procps \
 && rm -rf /var/lib/apt/lists/*
COPY --from=native /opt/ocp /opt/ocp
COPY --from=native /opt/mesher /opt/mesher
COPY --from=drawing /opt/dxf /opt/dxf
COPY --from=dwg-reader /opt/dwg /opt/dwg
COPY --from=native-dwg /opt/dotnet/dotnet /opt/dotnet/dotnet
COPY --from=native-dwg /opt/dotnet/host /opt/dotnet/host
COPY --from=native-dwg /opt/dotnet/shared/Microsoft.NETCore.App /opt/dotnet/shared/Microsoft.NETCore.App
COPY --from=native-dwg /build/dwg/reader/bin/Reader/release /opt/dwg-native
RUN /opt/dotnet/dotnet --list-runtimes
RUN /opt/ocp/bin/python -c 'from OCP.STEPCAFControl import STEPCAFControl_Reader' \
 && /opt/mesher/bin/python -c 'import gmsh, numpy'
WORKDIR /opt/cad
COPY server/cad-engine/core ./core
COPY server/cad-engine/dwg-reader ./dwg-reader
COPY server/cad-engine/bridge.py server/cad-engine/result_cache.py server/cad-engine/source.json server/cad-engine/service.py server/cad-engine/sandbox.py server/cad-engine/edge.py server/cad-engine/release.py ./
COPY server/cad-engine/requirements-*.txt ./
COPY deploy/cad/healthcheck.py ./healthcheck.py
RUN CAD_DXF_IMPORT_MODE=installed PYTHONPATH=/opt/cad/core /opt/dxf/bin/python -c 'from unified.dxf_runtime import require_engine; require_engine(); from unified.dxf_dwg import reader; reader("/opt/dwg/bin/dwgread")'
RUN mkdir -p /run/cad /var/lib/cad && chown 1000:1000 /run/cad /var/lib/cad
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 CAD_DXF_IMPORT_MODE=installed CAD_DXF_DWG_READER=/opt/dwg/bin/dwgread CAD_DWG_READER=/opt/dwg-native/LibiaoLink.DwgReader.dll CAD_DWG_DOTNET=/opt/dotnet/dotnet CAD_DWG_PYTHON=/opt/dxf/bin/python
USER 1000:1000
STOPSIGNAL SIGTERM
ENTRYPOINT ["/opt/ocp/bin/python", "/opt/cad/service.py"]
