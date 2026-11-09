# The Bazaar keeper as a container.
#
#     docker build -t bazaar-keeper .
#     mkdir -p keeper
#     docker run --rm -it --user "$(id -u):$(id -g)" -v "$PWD/keeper:/config" bazaar-keeper keeper init   # once
#     docker run -d --restart unless-stopped --user "$(id -u):$(id -g)" -v "$PWD/keeper:/config" bazaar-keeper
#
# Everything the keeper keeps lives in the directory mounted at /config, so nothing is lost when a
# container is removed. `keeper init`, run in the container as above, writes bazaar-keeper.yaml and .env
# there, a new keystore under /config/keys/, and `state: {dir: /config/state}` for the snapshot, the
# earnings ledger and the status file. HOME is /config too, so a config that keeps the ~/.bazaar
# defaults keeps them on the mount as well. Let init store the keystore password in .env: a detached
# container cannot ask for it at start. `--user` runs the keeper as you, so it can write to the
# directory and you own what it writes; without it, the directory must be writable by uid 10001.
# SIGTERM (docker stop) stops the keeper cleanly.

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/sdk/package.json packages/sdk/tsconfig.json packages/sdk/
COPY packages/keeper/package.json packages/keeper/tsconfig.json packages/keeper/
RUN npm ci --ignore-scripts
COPY packages/sdk/src packages/sdk/src
COPY packages/keeper/src packages/keeper/src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/sdk/package.json packages/sdk/
COPY --from=build /app/packages/sdk/dist packages/sdk/dist
COPY --from=build /app/packages/keeper/package.json packages/keeper/
COPY --from=build /app/packages/keeper/dist packages/keeper/dist
COPY LICENSE README.md ./
# Hot keys live in /config: run as an unprivileged user that owns nothing else.
RUN useradd --create-home --uid 10001 keeper && mkdir -p /config && chown keeper /config
USER keeper
# A `~/...` path (the default state.dir, ~/.bazaar; `bazaar wallet new`'s ~/.bazaar/keys) lands on the mount.
ENV HOME=/config
WORKDIR /config
ENTRYPOINT ["node", "/app/packages/keeper/dist/cli/main.js"]
CMD ["keeper", "start"]
