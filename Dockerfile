# tripcurve as a container image: `docker run --rm -v "$PWD:/repo:ro" ghcr.io/naren-ambati/tripcurve`.
# Two stages from the same pinned base (node:22-alpine, digest looked up 2026-11-15, docs/lookups-b29.txt):
# the first builds dist/ from src/, the second installs only the runtime dependencies from the shrinkwrap
# (so the minimatch override applies and the tree is the checked one) and runs as the unprivileged `node` user.
# The image never needs the network at run time; the checked repository is mounted read-only at /repo.
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS build
WORKDIR /app
COPY package.json npm-shrinkwrap.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm ci --ignore-scripts && npm run build

FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
LABEL org.opencontainers.image.source="https://github.com/naren-ambati/TripCurve" \
      org.opencontainers.image.description="Checks that timeouts between infrastructure layers are ordered correctly."
ENV NODE_ENV=production
WORKDIR /app
COPY package.json npm-shrinkwrap.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
WORKDIR /repo
ENTRYPOINT ["node", "/app/dist/cli/main.js"]
CMD ["/repo"]
