# videosyncd in a container. No dependencies to fetch: the module has no
# `require` block, so the build needs only the Go toolchain.
#
#   docker build -t videosyncd server/
#   docker compose -f deploy/docker-compose.yml up
#
# Not exercised by the test suite (the project does not run docker in CI or in
# agent sessions); the binary it builds is the one `go test ./cmd/videosyncd`
# starts.
ARG GO_VERSION=1.27
FROM golang:${GO_VERSION}-alpine AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /videosyncd ./cmd/videosyncd

FROM scratch
COPY --from=build /videosyncd /videosyncd
# Unprivileged; a mounted providers directory only needs to be readable.
USER 65534:65534
EXPOSE 8787
ENTRYPOINT ["/videosyncd"]
CMD ["-addr", ":8787"]
