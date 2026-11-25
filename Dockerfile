# syntax=docker/dockerfile:1.7
ARG DENO_VERSION=2.1.9

FROM denoland/deno:${DENO_VERSION} AS builder
WORKDIR /app
COPY deno.json server.ts main.ts ./
RUN deno check server.ts main.ts

FROM denoland/deno:${DENO_VERSION}

ARG VERSION=1.3.2
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="ciao-cors" \
      org.opencontainers.image.description="High performance CORS proxy server with advanced security and bounded LRU cache" \
      org.opencontainers.image.source="https://github.com/Silentely/ciao-cors" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.licenses="LicenseRef-Anti-Capitalist-Software-License"

WORKDIR /app

ENV PORT=3000 \
    HOST=0.0.0.0 \
    DENO_DIR=/deno-dir \
    DENO_NO_UPDATE_CHECK=1 \
    NO_COLOR=1

RUN mkdir -p /deno-dir && chown -R deno:deno /deno-dir /app

COPY --from=builder --chown=deno:deno /app/deno.json /app/server.ts /app/main.ts ./
COPY --chown=deno:deno LICENSE* ./

USER deno

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["deno", "eval", "const p=Deno.env.get('PORT')||'3000';const r=await fetch('http://127.0.0.1:'+p+'/health');if(!r.ok)Deno.exit(1);"]

ENTRYPOINT ["deno", "run", "--allow-net", "--allow-env", "--allow-read=/app", "--no-prompt", "/app/main.ts"]
