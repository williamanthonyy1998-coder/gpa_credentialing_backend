# Migration workflow

The schema is in `../schema.prisma`. On first local setup, run `npx prisma migrate dev --name init` to generate and apply the initial migration, then commit the generated `migrations/<timestamp>_init/migration.sql` file. For a deployed environment, use only reviewed, committed migrations with `npx prisma migrate deploy`; do not run `migrate dev` against production.
