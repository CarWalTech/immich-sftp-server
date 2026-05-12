FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package metadata first for better layer caching
COPY package*.json ./

# Install ALL dependencies
RUN npm install --loglevel=error --no-audit --no-fund 

RUN npm install -g ts-node ts-node-dev

# Copy source files
COPY . .

# Expose SFTP + debug ports
EXPOSE 22
EXPOSE 21
EXPOSE 1900
EXPOSE 9229

# Default command for debugging with ts-node
CMD ["ts-node", "src/server.ts"]