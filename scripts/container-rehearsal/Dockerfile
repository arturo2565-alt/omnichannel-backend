# El contexto autorizado lo prepara build-context.mjs y copia este archivo a su raíz.
# Las rutas COPY son relativas a esa raíz. No hay frontend Docker sin digest.
# Digests leídos de registry-1.docker.io el 31 de octubre de 2026, sin descargar capas.
# PostgreSQL 18 usa PGDATA /var/lib/postgresql/18/docker y el volumen /var/lib/postgresql.
FROM postgres:18.6-bookworm@sha256:5c4783a8cc3f0074912164f94dfa1be4e043438f0f707cf968d7af9a0d31a2c8
COPY --from=node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da /usr/local/bin/node /usr/local/bin/node
COPY --chown=postgres:postgres scripts/container-rehearsal/contract.mjs /opt/pegazuz/scripts/container-rehearsal/contract.mjs
COPY --chown=postgres:postgres scripts/container-rehearsal/entrypoint.mjs /opt/pegazuz/scripts/container-rehearsal/entrypoint.mjs
COPY --chown=postgres:postgres scripts/container-rehearsal/synthetic-lab.mjs /opt/pegazuz/scripts/container-rehearsal/synthetic-lab.mjs
COPY --chown=postgres:postgres scripts/container-rehearsal/schema.sql /opt/pegazuz/scripts/container-rehearsal/schema.sql
COPY --chown=postgres:postgres scripts/staging-backup-seal.mjs /opt/pegazuz/scripts/staging-backup-seal.mjs
COPY --chown=postgres:postgres scripts/staging-backup-crypto.mjs /opt/pegazuz/scripts/staging-backup-crypto.mjs
COPY --chown=postgres:postgres scripts/staging-backup-envelope.mjs /opt/pegazuz/scripts/staging-backup-envelope.mjs
COPY --chown=postgres:postgres scripts/staging-backup-put-contract.mjs /opt/pegazuz/scripts/staging-backup-put-contract.mjs
COPY --chown=postgres:postgres scripts/staging-private-backup.mjs /opt/pegazuz/scripts/staging-private-backup.mjs
COPY --chown=postgres:postgres scripts/assert-staging-restore.mjs /opt/pegazuz/scripts/assert-staging-restore.mjs
COPY --chown=postgres:postgres scripts/staging-synthetic.sql /opt/pegazuz/scripts/staging-synthetic.sql
COPY --chown=postgres:postgres scripts/staging-backup-integrity.sql /opt/pegazuz/scripts/staging-backup-integrity.sql
RUN chmod 0400 /opt/pegazuz/scripts/container-rehearsal/contract.mjs /opt/pegazuz/scripts/container-rehearsal/entrypoint.mjs /opt/pegazuz/scripts/container-rehearsal/synthetic-lab.mjs /opt/pegazuz/scripts/container-rehearsal/schema.sql /opt/pegazuz/scripts/staging-backup-seal.mjs /opt/pegazuz/scripts/staging-backup-crypto.mjs /opt/pegazuz/scripts/staging-backup-envelope.mjs /opt/pegazuz/scripts/staging-backup-put-contract.mjs /opt/pegazuz/scripts/staging-private-backup.mjs /opt/pegazuz/scripts/assert-staging-restore.mjs /opt/pegazuz/scripts/staging-synthetic.sql /opt/pegazuz/scripts/staging-backup-integrity.sql
ENV PGDATA=/var/lib/postgresql/18/docker
ENV NODE_NO_WARNINGS=1
WORKDIR /opt/pegazuz/scripts/container-rehearsal
USER postgres
ENTRYPOINT ["/usr/local/bin/node", "/opt/pegazuz/scripts/container-rehearsal/entrypoint.mjs"]
