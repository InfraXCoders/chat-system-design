FROM node:22-alpine

WORKDIR /app

# Install server deps first (better layer caching)
COPY server/package*.json ./server/
RUN cd server && npm install --omit=dev

# Copy application code
COPY server ./server
COPY client ./client

# Point the server at the client files baked into the image
ENV CLIENT_DIR=/app/client
ENV PORT=3001

WORKDIR /app/server
EXPOSE 3001

CMD ["node", "src/index.js"]
