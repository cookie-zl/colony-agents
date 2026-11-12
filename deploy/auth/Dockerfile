# 账号服务的镜像：零依赖（只用 node 内置模块），所以没有 npm install 这一步。
FROM node:22-alpine

WORKDIR /app
COPY --chown=node:node server.mjs ./

USER node
EXPOSE 9000
CMD ["node", "server.mjs"]
