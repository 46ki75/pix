# Container example

Read [CONTRIBUTING.md](../CONTRIBUTING.md) before making changes.

Using Apple's `container` CLI, build the image from the repository root with the
[example Dockerfile](Dockerfile):

```sh
container build -t pi ./container-example
```

Run Pi interactively as `vscode`, forwarding your terminal settings for color
support. The container is removed when Pi exits.

```sh
container run -it --rm -e TERM -e COLORTERM pi
```

Without a persistent mount, changes made inside the container are lost when it
is removed.

## Codex credentials

After signing into Codex through Pi's `/login` command on the host, mount Pi's
credential file at runtime:

```sh
container run -it --rm \
  -e TERM -e COLORTERM \
  -v "$HOME/.pi/agent/auth.json:/home/vscode/.pi/agent/auth.json" \
  pi
```

The mount is read-write by default. Keep it writable so Pi can save refreshed
OAuth tokens back to the host file; do not add `:ro`.

- The container can read and modify every credential in this file, not just Codex.
  Prefer a dedicated Codex-only auth file for narrower access.
- Avoid simultaneous host/container use of the same OAuth credentials because
  token refreshes can conflict.
- Never commit credentials or copy them into the image.
