# syntax=docker/dockerfile:1

FROM node:24-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS fonts
ARG FONTS_NOTO_CJK_VERSION=1:20240730+repack1-1
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends fontconfig "fonts-noto-cjk=${FONTS_NOTO_CJK_VERSION}" \
 && fc-match -f '%{family}\n' 'Noto Sans CJK SC' | grep -qx 'Noto Sans CJK SC' \
 && mkdir -p /fonts \
 && cp /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc /fonts/ \
 && cp /usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc /fonts/ \
 && cp /usr/share/doc/fonts-noto-cjk/copyright /fonts/NOTO-CJK-LICENSE.txt \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

FROM node:24-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe
ARG PIPELINE_VERSION=2.0.0
ARG BUILD_REVISION=unknown
LABEL org.opencontainers.image.title="libiaolink-svg-preview" \
      org.opencontainers.image.description="H1 SVG PNG rasterization sandbox (ADR-034)" \
      org.opencontainers.image.version="${PIPELINE_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REVISION}"
ENV NODE_ENV=production \
    HOME=/tmp \
    TMPDIR=/tmp \
    PORT=9900 \
    PIPELINE_VERSION=${PIPELINE_VERSION} \
    FONTS_DIR=/app/fonts \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8
WORKDIR /app
COPY --from=dependencies /app/node_modules /app/node_modules
COPY --from=fonts /fonts /app/fonts
COPY service /app/service
RUN chown -R 1000:1000 /app
USER 1000:1000
EXPOSE 9900
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:9900/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "--disable-proto=throw", "/app/service/server.mjs"]