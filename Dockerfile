# ---- 构建阶段：编译 TypeScript 并运行测试（无数据库时集成测试自动 skip） ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY test ./test
COPY contracts ./contracts
COPY migrations ./migrations
RUN npm test

# ---- 运行阶段 ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY contracts ./contracts
EXPOSE 8080
# 默认入口为应用；迁移任务在 compose 中以 command 覆盖为 dist/migrate.js
CMD ["node", "dist/main.js"]
