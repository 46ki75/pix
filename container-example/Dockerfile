FROM mcr.microsoft.com/devcontainers/base:ubuntu

RUN curl -fsSL https://mise.run -o /tmp/install-mise.sh \
    && MISE_VERSION=2026.9.13 sh /tmp/install-mise.sh \
    && rm /tmp/install-mise.sh

# Shims work in noninteractive build shells and the exec-form entrypoint.
ENV PATH="/root/.local/bin:/root/.local/share/mise/shims:${PATH}"

COPY container.mise.toml /root/.config/mise/config.toml
RUN mise install

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.87.1 \
    && mise reshim

RUN for package in \
    npm:@ikuma.cloud/pix-bg \
    npm:@ikuma.cloud/pix-mcp \
    npm:@ikuma.cloud/pix-statusline \
    npm:@ikuma.cloud/pix-theme-inspector \
    npm:@ikuma.cloud/pix-usage \
    npm:@ikuma.cloud/pix-webfetch \
    npm:@ikuma.cloud/pix-websearch; do \
        pi install "$package" || exit 1; \
    done

ENTRYPOINT ["pi"]
