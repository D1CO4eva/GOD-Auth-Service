FROM node:22-slim

ENV NODE_ENV=production \
    VIRTUAL_ENV=/opt/venv \
    PATH="/opt/venv/bin:$PATH" \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
 && python3 -m venv "$VIRTUAL_ENV" \
 && rm -rf /var/lib/apt/lists/*

# Install deps first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY requirements-context-search.txt ./
RUN pip install --no-cache-dir -r requirements-context-search.txt

# Copy app source
COPY . .

# Cloud Run sets $PORT; app defaults to 8080.
EXPOSE 8080

CMD ["node", "bootstrap.js"]
