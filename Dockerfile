FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY test ./test
RUN npm test

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/server.js"]
