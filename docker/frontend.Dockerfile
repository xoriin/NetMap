FROM node:22-alpine AS builder

WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend ./
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

USER root
RUN apk add --no-cache gettext

ENV BACKEND_URL=http://backend:8000

COPY --from=builder /app/dist /usr/share/nginx/html
COPY docker/frontend-nginx.conf.template /etc/nginx/templates/netmap.conf.template
COPY docker/frontend-entrypoint.sh /frontend-entrypoint.sh
RUN chmod +x /frontend-entrypoint.sh

USER 101
EXPOSE 8080
ENTRYPOINT ["/frontend-entrypoint.sh"]
