FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV DATA_DIR=/data PORT=3000
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
HEALTHCHECK CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.js"]
