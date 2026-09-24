# Use official Node.js 20 base image
FROM node:20-bookworm-slim

# Install Python 3, pip, and system build libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1. Install Node.js frontend and server packages
COPY package*.json ./
RUN npm install

# 2. Install Python quantitative packages
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# 3. Copy full project code
COPY . .

# 4. Compile React frontend and bundle server.ts
RUN npm run build

# 5. Expose port and start unified server + bot engine
EXPOSE 3000
CMD ["npm", "start"]