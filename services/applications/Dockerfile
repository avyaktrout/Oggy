FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including devDependencies for dev mode)
RUN npm install

# Copy source code
COPY . .

# Expose ports (gateway=3001, payments=3010, general=3011, diet=3012)
EXPOSE 3001 3010 3011 3012

# Health check (uses PORT env var, defaults to 3001 for gateway)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||3001;require('http').get('http://localhost:'+p+'/health',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Start the service
CMD ["npm", "start"]
