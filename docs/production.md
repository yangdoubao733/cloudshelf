# CloudShelf 生产部署指南

这份指南面向自己的 Linux 服务器。推荐把 CloudShelf 放在 Docker Compose 里运行，再用 Nginx 或 Caddy 做 HTTPS 反向代理。

## 1. 准备目录

```bash
mkdir -p /opt/cloudshelf
cd /opt/cloudshelf
```

把项目代码放到这个目录后，创建环境文件：

```bash
cp .env.example .env
```

编辑 `.env`：

```env
ADMIN_PASSWORD=换成一个强密码
SESSION_SECRET=换成一段至少32位的随机字符串
NPM_REGISTRY=https://registry.npmmirror.com
HOST_PORT=8080
MAX_UPLOAD_MB=200
TRUST_PROXY=0
COOKIE_SECURE=0
```

生成随机 `SESSION_SECRET`：

```bash
openssl rand -hex 32
```

如果你使用 HTTPS 反向代理，把 `.env` 改成：

```env
TRUST_PROXY=1
COOKIE_SECURE=1
```

## 2. 启动

```bash
docker compose build --no-cache --progress=plain
docker compose up -d
```

查看状态：

```bash
docker compose ps
docker compose logs -f --tail=100
```

健康检查：

```bash
curl http://127.0.0.1:8080/api/health
```

返回：

```json
{"ok":true}
```

如果服务器上 `8080` 已经被其他服务占用，把 `.env` 里的 `HOST_PORT` 改成空闲端口，例如：

```env
HOST_PORT=18080
```

然后访问：

```bash
curl http://127.0.0.1:18080/api/health
```

## 3. Nginx 反向代理

参考 `deploy/nginx.conf.example`。

如果你用域名和 HTTPS，建议配合 Certbot：

```bash
apt update
apt install -y nginx certbot python3-certbot-nginx
cp deploy/nginx.conf.example /etc/nginx/sites-available/cloudshelf
ln -s /etc/nginx/sites-available/cloudshelf /etc/nginx/sites-enabled/cloudshelf
nginx -t
systemctl reload nginx
certbot --nginx -d reader.example.com
```

记得把 `reader.example.com` 换成你的域名。

## 4. Caddy 反向代理

参考 `deploy/Caddyfile.example`。Caddy 会自动申请 HTTPS 证书，适合个人服务器。

## 5. 备份

所有持久数据都在 `./data`：

```text
data/
  cloudshelf.db
  books/
  covers/
```

创建备份：

```bash
sh scripts/backup.sh
```

默认写入：

```text
backups/cloudshelf-YYYYMMDD-HHMMSS.tar.gz
```

建议把 `backups/` 同步到另一台机器或对象存储。

## 6. 恢复

先停止服务：

```bash
docker compose down
```

恢复：

```bash
sh scripts/restore.sh backups/cloudshelf-YYYYMMDD-HHMMSS.tar.gz
```

再启动：

```bash
docker compose up -d
```

## 7. 重置管理员密码

首次启动后，`ADMIN_PASSWORD` 会被写入数据库。之后只修改 `.env` 不会自动改变登录密码。
如果你已经登录过或服务已经初始化，实际登录密码以数据库中的哈希为准。

重置 `admin` 密码：

```bash
cd /opt/cloudshelf
docker compose -f docker-compose.runtime.yml down
ADMIN_PASSWORD='新的强密码' DATA_DIR=./data node --experimental-sqlite scripts/reset-admin-password.js
docker compose -f docker-compose.runtime.yml up -d
```

如果使用标准构建部署，把 compose 文件名换成 `docker-compose.yml` 即可。

## 8. npm 构建卡住

如果卡在 `npm ping` 或 `npm ci`，先测服务器网络：

```bash
curl -I https://registry.npmmirror.com/adm-zip
curl -I https://registry.npmjs.org/adm-zip
```

哪个快就用哪个：

```bash
docker compose build --no-cache --progress=plain --build-arg NPM_REGISTRY=https://registry.npmmirror.com
docker compose build --no-cache --progress=plain --build-arg NPM_REGISTRY=https://registry.npmjs.org
```

如果 Docker 容器内 DNS 有问题：

```bash
docker run --rm node:22-bookworm-slim npm ping --registry=https://registry.npmmirror.com
```

这条也卡住时，需要检查服务器 Docker DNS、IPv6 或防火墙。

如果服务器已经有 `node:22-bookworm-slim` 镜像，但 Docker 构建阶段无法访问 npm，可以使用免构建运行方式：

```bash
docker compose -f docker-compose.runtime.yml up -d
```

这种方式要求项目目录里已经包含 `node_modules`。适合内网、弱网络或 npm registry 被阻断的服务器。
