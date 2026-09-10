FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
# npm only bootstraps the pinned package-manager executable; project dependencies use pnpm.
COPY build-support/bootstrap-pnpm.mjs /tmp/bootstrap-pnpm.mjs
RUN node /tmp/bootstrap-pnpm.mjs
ENV TZ=UTC CI=true
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY scripts ./scripts
COPY mise.toml tsconfig.json ./
ARG SOURCE_COMMIT=uncommitted
ENV SOURCE_COMMIT=$SOURCE_COMMIT
RUN pnpm package
CMD ["sh", "-c", "cp /build/dist/quarantine-*.zip /build/dist/SHA256SUMS /build/dist/build-info.json /out/"]
