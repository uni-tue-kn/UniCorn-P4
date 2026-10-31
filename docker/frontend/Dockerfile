FROM node:24-alpine AS build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY VERSION /app/VERSION
COPY frontend/ ./
RUN npm run build

FROM nginx:1.30.6-alpine
ENV BACKEND_URL=http://host.docker.internal:5000 NETSIM_URL=http://host.docker.internal:5001
COPY frontend/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 3000
