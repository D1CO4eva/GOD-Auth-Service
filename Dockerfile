FROM node:22-slim

ENV NODE_ENV=production

WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy app source
COPY . .

# Cloud Run sets $PORT; app defaults to 8080.
EXPOSE 8080

CMD ["node", "index.js"]

