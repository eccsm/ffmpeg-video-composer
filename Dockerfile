FROM node:18-slim

# Install FFmpeg with progress
RUN echo "Installing FFmpeg..." && \
    apt-get update && \
    apt-get install -y ffmpeg fonts-dejavu-core && \
    rm -rf /var/lib/apt/lists/* && \
    ffmpeg -version && \
    echo "FFmpeg installed successfully"

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY server.js .

# Health check
HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "require('http').get('http://localhost:3000/', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

EXPOSE 3000

CMD ["node", "server.js"]
