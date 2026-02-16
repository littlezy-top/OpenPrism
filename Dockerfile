# syntax=docker/dockerfile:1

############################
# 1) Build stage (Node)
############################
FROM node:18-bullseye AS builder
WORKDIR /app

# 1) 先拷贝清单文件以利用缓存
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json

# 2) 装全量依赖（需要 dev 依赖来 build 前端）
RUN npm ci

# 3) 拷贝源码并构建前端
COPY . .
RUN npm run build

# 4) 构建完成后，把 dev 依赖剔除，只保留 production node_modules
#    （会在当前 workspace 依赖树里做 pruned）
RUN npm prune --omit=dev


############################
# 2) Runtime stage (TeXLive base)
############################
FROM texlive/texlive:latest AS runtime
WORKDIR /app

# 安装 Node.js（用 Debian/Ubuntu 的 apt）
# 如果你想严格锁 Node 版本（更推荐），可以改用 NodeSource；这里先给通用版。
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     nodejs npm ca-certificates fontconfig \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=8787
ENV OPENPRISM_DATA_DIR=/var/openprism/data

# 只拷“运行必需”的内容（精简拷贝）
COPY --from=builder /app/apps/backend/src ./apps/backend/src
COPY --from=builder /app/apps/backend/package.json ./apps/backend/package.json

COPY --from=builder /app/apps/frontend/dist ./apps/frontend/dist

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json

EXPOSE 8787
VOLUME ["/var/openprism/data"]

CMD ["node", "apps/backend/src/index.js"]
