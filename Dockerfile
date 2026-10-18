FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js index.html login.html config.example.json ./

ENV PORT=80
EXPOSE 80
CMD ["npm", "start"]

