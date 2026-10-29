# Local base for this recording sandbox only:
#  1. official node:22-alpine
#  2. the sandbox's TLS-inspection CA, so npm/Prisma/Next downloads inside builds verify (the sandbox
#     re-signs outbound TLS with its own CA; real machines do not need this)
#  3. Alpine's own su-exec 0.3-r0 package (binary + apk db record) from the official rabbitmq:alpine
#     image (same Alpine 3.24.3), because the sandbox blocks dl-cdn.alpinelinux.org
# usage: docker build -t node:22-alpine -f Dockerfile <context>   (the local tag replaces node:22-alpine for ProxMate's builds)
#   <context> is a scratch folder OUTSIDE the repo holding sandbox-ca.crt, su-exec and su-exec.installed (README.md).
FROM docker.io/library/node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
COPY sandbox-ca.crt /usr/local/share/ca-certificates/sandbox-ca.crt
RUN cat /usr/local/share/ca-certificates/sandbox-ca.crt >> /etc/ssl/certs/ca-certificates.crt
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
COPY su-exec /sbin/su-exec
COPY su-exec.installed /tmp/su-exec.installed
RUN cat /tmp/su-exec.installed >> /lib/apk/db/installed && rm /tmp/su-exec.installed && apk info -e su-exec
