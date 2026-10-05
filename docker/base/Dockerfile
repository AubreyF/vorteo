# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:22-bookworm-slim
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS source-pack

ARG PASEO_VERSION
ARG PASEO_BUILD_COMMIT
ENV PASEO_BUILD_COMMIT=${PASEO_BUILD_COMMIT}

ENV ONNXRUNTIME_NODE_INSTALL=skip

WORKDIR /tmp/paseo-src
COPY . .

RUN set -eux; \
    if [ -n "${PASEO_VERSION:-}" ]; then \
      test "$(node -p "require('./package.json').version")" = "${PASEO_VERSION}"; \
    fi; \
    node -e 'const fs=require("node:fs"); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); delete pkg.scripts.prepare; fs.writeFileSync("package.json", `${JSON.stringify(pkg)}\n`);'; \
    npm ci

RUN set -eux; \
    mkdir -p /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/highlight --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/relay --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/protocol --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/client --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/plugin --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/server --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/cli --pack-destination /tmp/paseo-packs

FROM ${NODE_IMAGE}

ENV HOME=/home/paseo \
    PASEO_HOME=/home/paseo/.paseo \
    PASEO_LISTEN=127.0.0.1:6767 \
    PASEO_WEB_UI_ENABLED=true \
    PASEO_LOG_FORMAT=json \
    PASEO_LOG_LEVEL=info \
    CLAUDE_CONFIG_DIR=/home/paseo/.claude \
    CODEX_HOME=/home/paseo/.codex \
    XDG_CONFIG_HOME=/home/paseo/.config \
    XDG_DATA_HOME=/home/paseo/.local/share \
    XDG_STATE_HOME=/home/paseo/.local/state \
    XDG_CACHE_HOME=/home/paseo/.cache \
    ONNXRUNTIME_NODE_INSTALL=skip

COPY docker/base/chromium-packages.txt /opt/paseo/chromium-packages.txt

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      gh \
      git \
      gosu \
      lbzip2 \
      openssh-client \
      procps \
      tini; \
    xargs apt-get install -y --no-install-recommends < /opt/paseo/chromium-packages.txt; \
    rm -rf /var/lib/apt/lists/*; \
    gh --version

COPY --from=source-pack /tmp/paseo-packs /tmp/paseo-packs
RUN set -eux; \
	npm install -g /tmp/paseo-packs/*.tgz; \
    rm -rf /tmp/paseo-packs; \
    npm cache clean --force; \
    server_entry="$(npm root -g)/@getpaseo/server/dist/scripts/supervisor-entrypoint.js"; \
    test -f "$server_entry"; \
    printf '%s\n' "$server_entry" > /etc/paseo-server-entry; \
    node --check "$server_entry"

# Fork and downstream images can add one agent package without copying this
# Dockerfile or baking provider credentials into an image layer.
ARG PASEO_EXTRA_NPM_PACKAGE="@openai/codex@0.153.4"
ARG PASEO_CLAUDE_PACKAGE="@anthropic-ai/claude-code@2.1.246"
ARG PASEO_PI_PACKAGE="@earendil-works/pi-coding-agent@0.84.4"
RUN set -eux; \
    if [ -n "$PASEO_EXTRA_NPM_PACKAGE" ]; then \
      npm install -g "$PASEO_EXTRA_NPM_PACKAGE"; \
      npm cache clean --force; \
    fi

RUN set -eux; \
    if [ -n "$PASEO_CLAUDE_PACKAGE" ]; then \
      npm install -g "$PASEO_CLAUDE_PACKAGE"; \
      npm cache clean --force; \
    fi

RUN set -eux; \
    if [ -n "$PASEO_PI_PACKAGE" ]; then \
      npm install -g "$PASEO_PI_PACKAGE"; \
      npm cache clean --force; \
    fi

RUN set -eux; \
    existing_group="$(getent group 1000 | cut -d: -f1 || true)"; \
    if [ -n "$existing_group" ] && [ "$existing_group" != "paseo" ]; then \
      groupmod --new-name paseo "$existing_group"; \
    elif [ -z "$existing_group" ]; then \
      groupadd --gid 1000 paseo; \
    fi; \
    existing_user="$(getent passwd 1000 | cut -d: -f1 || true)"; \
    if [ -n "$existing_user" ] && [ "$existing_user" != "paseo" ]; then \
      usermod --login paseo --gid paseo --home /home/paseo --shell /bin/bash "$existing_user"; \
    elif [ -z "$existing_user" ]; then \
      useradd --uid 1000 --gid paseo --create-home --home-dir /home/paseo --shell /bin/bash paseo; \
    fi; \
    mkdir -p \
      /workspace \
      "$PASEO_HOME" \
      "$CLAUDE_CONFIG_DIR" \
      "$CODEX_HOME" \
      "$XDG_CONFIG_HOME" \
      "$XDG_DATA_HOME" \
      "$XDG_STATE_HOME" \
      "$XDG_CACHE_HOME"; \
    chown -R paseo:paseo /home/paseo /workspace

COPY docker/base/rootfs/ /
RUN chmod +x /usr/local/bin/paseo-docker-entrypoint

WORKDIR /workspace

EXPOSE 6767
VOLUME ["/home/paseo"]

# One runtime for both Paseo and Vorton. Tailscale state is never an image layer.
ARG TARGETARCH
ARG TAILSCALE_VERSION=1.102.4
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) checksum=50748df1045e60b5b695f19f4c56b0da36c019948b440fb456b6584a50f0d8b9 ;; \
      arm64) checksum=9dd1e6a592a014bbaea0103167ffe299adeda4ba14e078ce9c2895364f6c4c3f ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends supervisor python3 util-linux iproute2 iptables; \
    curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_${TARGETARCH}.tgz" -o /tmp/tailscale.tgz; \
    echo "$checksum  /tmp/tailscale.tgz" | sha256sum -c -; \
    tar -xzf /tmp/tailscale.tgz -C /tmp; \
    install -m 0755 "/tmp/tailscale_${TAILSCALE_VERSION}_${TARGETARCH}/tailscale" /usr/local/bin/tailscale; \
    install -m 0755 "/tmp/tailscale_${TAILSCALE_VERSION}_${TARGETARCH}/tailscaled" /usr/local/sbin/tailscaled; \
    rm -rf /tmp/tailscale* /var/lib/apt/lists/*; \
    entry="$(cat /etc/paseo-server-entry)"; \
    test -s "$(dirname "$entry")/../server/web-ui/index.html"; \
    command -v setpriv

COPY --chown=root:root docker/tailscale/entrypoint docker/tailscale/start-paseo docker/tailscale/healthcheck docker/tailscale/initialize-web.mjs docker/tailscale/network.py /opt/personal-tailscale/
COPY --chown=root:root docker/tailscale/supervisord.conf /etc/personal-tailscale/supervisord.conf
COPY --chown=root:root docker/tailscale/paseo-preview.mjs /usr/local/bin/paseo-preview
COPY --chown=root:root docker/tailscale/preview-broker-client.mjs /usr/local/bin/preview-broker-client.mjs
RUN chmod 0755 /opt/personal-tailscale /opt/personal-tailscale/* /usr/local/bin/paseo-preview \
 && chmod 0755 /etc/personal-tailscale \
 && chmod 0644 /etc/personal-tailscale/supervisord.conf
ENV PASEO_WEB_UI_DIST_DIR=/home/paseo/.paseo/web-ui \
    PASEO_RELAY_ENABLED=false
LABEL sh.paseo.container-contract="tailscale-v1"
ENTRYPOINT ["/usr/bin/tini", "--", "/bin/bash", "/opt/personal-tailscale/entrypoint"]
HEALTHCHECK --interval=15s --timeout=10s --start-period=60s --retries=3 CMD ["/usr/bin/python3", "-I", "/opt/personal-tailscale/healthcheck"]
