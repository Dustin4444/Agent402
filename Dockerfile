# SECURITY REVIEW / VERIFY-BEFORE-DEPLOY — this Dockerfile is part of the infra
# hardening PR (audit A402-01/06 + mutable-artifacts). It could not be
# build-tested in the authoring sandbox (no Docker) and changes the runtime
# user, so it MUST be built and verified on a Railway preview before it reaches
# the deploy path. See docs/security-infra-hardening.md for the verification
# checklist and the platform-level follow-ups this does NOT cover.
#
# Base image pinned by DIGEST for reproducible builds and CVE traceability
# (audit: "mutable deployment artifacts"). node:22-slim as of 2026-07-18. Re-pin
# after a deliberate base bump with:
#   docker pull node:22-slim
#   docker inspect --format='{{index .RepoDigests 0}}' node:22-slim
FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
# ffmpeg powers the audio tools (normalize/convert/info); installed alongside
# Chromium's deps in one layer. Both need root and run BEFORE the USER switch.
RUN npm ci --omit=dev && npx playwright install --with-deps chromium \
  && apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  # A402-06 / CVE-2026-8461 (FFmpeg MagicYUV): record the exact ffmpeg build and
  # whether the vulnerable decoder is even present, so the live image is
  # auditable without guessing. scripts/check-ffmpeg-cve.sh reads this.
  && (ffmpeg -version | head -1 > /app/.ffmpeg-version || true) \
  && (ffmpeg -hide_banner -decoders 2>/dev/null | grep -i magicyuv >> /app/.ffmpeg-version || echo "magicyuv-decoder: absent" >> /app/.ffmpeg-version)

COPY src ./src
# scripts/demo-payment.js is served at /demo.js (the runnable buyer demo)
COPY scripts ./scripts
# wiki/ is the source of truth for /docs (server-rendered) and is CI-synced
# to the GitHub wiki. Must be in the image or /docs is empty.
COPY wiki ./wiki
# assets/fonts is embedded into the brand images at boot — a missing file is
# a boot crash, not a degraded render.
COPY assets ./assets

# A402-01: run as the unprivileged `node` user (UID 1000, ships with the node
# image) instead of root. A renderer or media-parser compromise then lands as
# UID 1000 — unable to touch root-owned files or escalate — instead of as root
# inside the app container. This is the safe, in-place first step.
#
# NOTE 1 (--no-sandbox stays): src/tools/render.js still launches Chromium with
# --no-sandbox because this container has no user-namespace / seccomp profile
# for Chromium's own sandbox. Removing --no-sandbox REQUIRES enabling that at
# the platform level first (see the doc) — do NOT drop it here blindly or
# Chromium fails to launch and every browser tool 503s. Non-root already removes
# the "escape == root" impact that made A402-01 High.
#
# NOTE 2 (/data): the Railway persistent volume mounts at /data at RUNTIME and
# MUST be writable by UID 1000. If not, the memory/stats SQLite boot check fails
# LOUD on deploy (a safe, immediate failure — not silent corruption), so a
# permission miss is caught before buyers are affected. Verify on the preview.
#
# NOTE 3 (full isolation is a follow-up): the browser and media parsers still
# share this container with the payment/DB/operator env. True A402-01/02/06
# isolation is a separate browser/media worker service with no secrets — see
# the design in docs/security-infra-hardening.md. This PR does not implement it.
RUN chown -R node:node /app
USER node

EXPOSE 3000
CMD ["node", "src/server.js"]
