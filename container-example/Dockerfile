FROM mcr.microsoft.com/devcontainers/base:ubuntu

USER vscode
ENV HOME="/home/vscode"
# Shims work in noninteractive build shells and the exec-form CMD.
ENV PATH="/home/vscode/.local/bin:/home/vscode/.local/share/mise/shims:${PATH}"
WORKDIR /home/vscode

RUN curl -fsSL https://mise.run -o /tmp/install-mise.sh \
    && MISE_VERSION=2026.9.13 sh /tmp/install-mise.sh \
    && rm /tmp/install-mise.sh

COPY --chown=vscode:vscode container.mise.toml /home/vscode/.config/mise/config.toml
RUN mise install

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.87.1 \
    && mise reshim

COPY --chown=vscode:vscode settings.json /home/vscode/.pi/agent/settings.json

RUN pi update --extensions

CMD ["pi"]
