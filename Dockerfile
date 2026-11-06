FROM node:24-bookworm-slim AS frontend
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
COPY docs/usage.md /src/docs/usage.md
COPY deploy/glances-tunnel.sh /src/deploy/glances-tunnel.sh
RUN npm run build

FROM golang:1.27-bookworm AS backend
WORKDIR /src
COPY . .
COPY --from=frontend /src/web/dist ./web/dist
RUN CGO_ENABLED=0 go build -trimpath -o /jet-supermicro .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=backend /jet-supermicro /jet-supermicro
ENV LISTEN_ADDR=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/jet-supermicro"]
