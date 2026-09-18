# syntax=docker/dockerfile:1

# 依赖层：完整依赖（含 devDependencies）用于编译
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# 编译层：TypeScript → dist/
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 运行层：仅生产依赖 + 编译产物 + 迁移脚本
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
EXPOSE 8080
USER node
CMD ["node", "dist/server.js"]
