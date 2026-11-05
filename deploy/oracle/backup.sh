#!/bin/bash
# A copy of Statiku's database every night (statiku-backup.timer), in /opt/statiku-backups; the last 14 are kept.
# Copy one to your Mac now and then:  scp ubuntu@<server>:/opt/statiku-backups/<file> .
# Restore into an empty database:     pg_restore --clean --if-exists -d <database> <file>
set -euo pipefail
mkdir -p /opt/statiku-backups
cd /opt/statiku
docker compose -f deploy/oracle/compose.yaml --env-file deploy/oracle/.env exec -T db pg_dump -U statiku -Fc statiku > "/opt/statiku-backups/statiku-$(date +%F).dump"
ls -1t /opt/statiku-backups/statiku-*.dump | tail -n +15 | xargs -r rm --
