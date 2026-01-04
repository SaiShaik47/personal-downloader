FROM node:20-bookworm-slim

# Install tools needed by yt-dlp
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp \
  && yt-dlp --version

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
