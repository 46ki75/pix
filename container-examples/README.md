# Container example

Read [CONTRIBUTING.md](../CONTRIBUTING.md) before making changes.

Using Apple's `container` CLI, build the image from the repository root with the
[example Dockerfile](../container-example/Dockerfile):

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
