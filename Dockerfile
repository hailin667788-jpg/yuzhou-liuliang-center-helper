FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY index.html ./
COPY server.mjs ./
COPY login.html ./

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "run", "start"]
