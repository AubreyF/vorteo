# syntax=docker/dockerfile:1
# The gate image holds one static binary and nothing else: no shell, no
# package manager, no agent code. The build stage needs no Go on the Host.
ARG GO_IMAGE=golang:1.26-bookworm
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS build
ARG TARGETARCH
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH go test ./... \
 && CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH go build -trimpath -ldflags='-s -w -buildid=' -o /gate .

FROM scratch
COPY --from=build /gate /gate
USER 65534:65534
ENTRYPOINT ["/gate"]
