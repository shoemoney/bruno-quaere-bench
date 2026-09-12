# Bruno QUAERE: seeded, deterministic media API + ladder harness. Zero runtime deps, so the
# image needs nothing but Node itself.
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY bin ./bin
COPY docs ./docs

ENV SEED=1
ENV PORT=8080
ENV ADMIN_PORT=8081
ENV ADMIN_BIND=0.0.0.0

EXPOSE 8080 8081

CMD ["sh", "-c", "node bin/quaere.js serve --seed $SEED --port $PORT --admin-port $ADMIN_PORT"]
