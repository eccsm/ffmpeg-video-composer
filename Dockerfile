FROM node:18-slim

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y ffmpeg fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/* \
  && ffmpeg -version

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
