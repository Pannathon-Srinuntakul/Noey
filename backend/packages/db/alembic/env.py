"""Alembic environment — wired to our Settings and SQLAlchemy Base."""

from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool

from alembic import context

from packages.core.settings import get_settings
from packages.db.base import Base
import packages.db.models  # noqa: F401  (registers all models on Base.metadata)

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Use our sync URL (Alembic runs synchronously).
config.set_main_option("sqlalchemy.url", get_settings().sync_database_url)

target_metadata = Base.metadata


_MANAGED_SCHEMAS = {"public", "core", "tenant_default"}


def _include_object(object, name: str, type_: str, reflected: bool, compare_to) -> bool:  # noqa: A002
    """Filter for autogenerate: exclude runtime-managed tables and foreign schemas.

    - Exclude ``udt_*`` tables (user-created dynamic tables managed via DDL at runtime).
    - Exclude ``alembic_version`` from non-public schemas (search_path artefact).
    - Only include schemas that Alembic manages.
    """
    if type_ == "schema":
        return name in _MANAGED_SCHEMAS or name is None

    schema = getattr(object, "schema", None) or "public"

    # Exclude udt_* everywhere.
    if type_ == "table" and name.startswith("udt_"):
        return False

    # Only track tables in managed schemas.
    if type_ == "table" and schema not in _MANAGED_SCHEMAS:
        return False

    # Exclude alembic_version from reflection noise.
    if type_ == "table" and name == "alembic_version" and schema != "public":
        return False

    return True


_AUTOGENERATE_OPTS = {
    "target_metadata": target_metadata,
    "compare_type": True,
    "include_schemas": True,  # see core.* tables
    "include_object": _include_object,
    "version_table_schema": "public",  # keep alembic_version in public
}


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        **_AUTOGENERATE_OPTS,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, **_AUTOGENERATE_OPTS)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
