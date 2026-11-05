# Statiku as a container, for Koyeb or any host that builds a Dockerfile: the service with its location
# databases. Set DATABASE_URL (and DATABASE_CA), PUBLIC_URL and SECRET_KEY (see docs/OPERATIONS.md); migrations
# run before it starts.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 TRUST_PROXY=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# DB-IP's free country and city databases (CC BY 4.0), fetched while building. With GEO_CITY_DB=off the service
# runs on the country database alone, in less memory.
RUN npm run geo
EXPOSE 8080
CMD ["sh", "-c", "node db/migrate.ts && exec node ingest/server.ts"]
