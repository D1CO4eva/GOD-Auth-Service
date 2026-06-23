FROM node:22-slim

ENV NODE_ENV=production

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

# Install deps first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY requirements-context-search.txt ./
RUN pip3 install --no-cache-dir -r requirements-context-search.txt

# Copy app source
COPY . .

# Cloud Run sets $PORT; app defaults to 8080.
EXPOSE 8080

CMD ["node", "bootstrap.js"]
