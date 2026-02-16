FROM texlive/texlive:latest

WORKDIR /app

# 1) 装 Node / npm（单阶段里必须装）
#    如果你的 texlive tag 不是 Debian/Ubuntu 系导致 apt-get 不存在，再告诉我你用的 tag，我给你换命令。
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     nodejs npm ca-certificates fontconfig git \
  && rm -rf /var/lib/apt/lists/*

# 2) 先复制依赖清单以利用缓存
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json

# 3) 安装依赖（需要 dev 依赖来 build 前端）
RUN npm ci

# 4) 复制全部源码（单阶段：一锅端）
COPY . .

# 5) 构建前端（生成 apps/frontend/dist，后端会自动托管它）
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8787
ENV OPENPRISM_DATA_DIR=/var/openprism/data

EXPOSE 8787
VOLUME ["/var/openprism/data"]

# 6) 直接启动后端
CMD ["node", "apps/backend/src/index.js"]
