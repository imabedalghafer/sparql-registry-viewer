FROM python:3.12-alpine

LABEL org.opencontainers.image.title="SPARQL Scope" \
      org.opencontainers.image.description="Read-only graph explorer for any SPARQL 1.1 endpoint" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.source="https://github.com/imabedalghafer/sparql-registry-viewer"

WORKDIR /app
COPY server.py .
COPY web/ web/
COPY LICENSE THIRD-PARTY-NOTICES.md ./

# Run unprivileged: the process only reads its own files and makes outbound
# HTTP requests, so it never needs root.
RUN adduser -D -H -u 10001 scope && chown -R scope:scope /app
USER scope

ENV SCOPE_PORT=8080
EXPOSE 8080
# Probe the port the server actually listens on: hardcoding 8080 marks the
# container permanently unhealthy whenever SCOPE_PORT is set. 127.0.0.1 avoids
# an IPv6-first resolution stall on 'localhost'.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('SCOPE_PORT','8080')+'/health')"
CMD ["python", "server.py"]
