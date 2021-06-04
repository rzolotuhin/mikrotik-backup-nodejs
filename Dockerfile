FROM node:alpine
ENV dst /opt/nodejs/mikrotik
RUN mkdir -p $dst
WORKDIR $dst
COPY . .
ENTRYPOINT ["nodejs", "backup.js"]