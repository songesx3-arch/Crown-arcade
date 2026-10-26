FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV DATA_DIR=/data PORT=3000
VOLUME /data
EXPOSE 3000
USER node
CMD ["node","server.js"]
