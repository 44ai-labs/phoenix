"""add pg_trgm GIN indexes on spans output.value and input.value

Revision ID: a3f8e1d2c7b5
Revises: d4e5f6a7b8c9
Create Date: 2026-07-31 00:00:00.000000

Enables the pg_trgm extension and creates GIN indexes on
spans.attributes->>'{output,value}' and spans.attributes->>'{input,value}'
so that the TextContains filter (which now emits LIKE '%term%') can use
trigram index scans instead of a full sequential scan.

Without these indexes, filtering traces by output.value or input.value
performs a sequential scan of the entire spans table on every request,
taking 500ms+ once a few thousand traces are stored.

CONCURRENTLY support (opt-in via PHOENIX_MIGRATE_INDEX_CONCURRENTLY=true):

  CREATE INDEX CONCURRENTLY cannot run inside a transaction. The workaround
  is identical to the one used in f1a6b2f0c9d5: commit the current
  transaction and enable autocommit at the DBAPI level before issuing the
  DDL, then restore transactional mode afterward.

  Tradeoffs:
  - CONCURRENTLY avoids table locks during the build, suitable for
    rolling deployments where an existing instance is still ingesting spans.
  - CONCURRENTLY is ~2-3x slower (two heap passes) and breaks transactional
    migration guarantees (a failed build leaves a partial INVALID index that
    must be dropped manually).
  - For very large tables, operators can pre-create the index before
    upgrading so the migration is instant:

    1. While the old version is still running:
       CREATE EXTENSION IF NOT EXISTS pg_trgm;
       CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_spans_output_value_trgm
         ON spans USING GIN ((attributes #>> '{output,value}') gin_trgm_ops);
       CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_spans_input_value_trgm
         ON spans USING GIN ((attributes #>> '{input,value}') gin_trgm_ops);
    2. Upgrade Phoenix (migration sees the names, skips via IF NOT EXISTS).
"""

import os
from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

# revision identifiers, used by Alembic.
revision: str = "a3f8e1d2c7b5"
down_revision: Union[str, None] = "d4e5f6a7b8c9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _is_postgresql() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def _use_concurrently() -> bool:
    if not _is_postgresql():
        return False
    return os.environ.get("PHOENIX_MIGRATE_INDEX_CONCURRENTLY", "").lower() == "true"


def _enable_autocommit() -> None:
    dbapi_conn = op.get_bind().connection.dbapi_connection
    assert dbapi_conn is not None
    dbapi_conn.commit()
    dbapi_conn.autocommit = True


def _disable_autocommit() -> None:
    dbapi_conn = op.get_bind().connection.dbapi_connection
    assert dbapi_conn is not None
    dbapi_conn.autocommit = False


def upgrade() -> None:
    if not _is_postgresql():
        return

    concurrently = _use_concurrently()
    if concurrently:
        _enable_autocommit()

    c = "CONCURRENTLY " if concurrently else ""

    try:
        op.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
        op.execute(text(
            f"CREATE INDEX {c}IF NOT EXISTS ix_spans_output_value_trgm "
            f"ON spans USING GIN ((attributes #>> '{{output,value}}') gin_trgm_ops)"
        ))
        op.execute(text(
            f"CREATE INDEX {c}IF NOT EXISTS ix_spans_input_value_trgm "
            f"ON spans USING GIN ((attributes #>> '{{input,value}}') gin_trgm_ops)"
        ))
    finally:
        if concurrently:
            _disable_autocommit()


def downgrade() -> None:
    if not _is_postgresql():
        return

    concurrently = _use_concurrently()
    if concurrently:
        _enable_autocommit()

    c = "CONCURRENTLY " if concurrently else ""

    try:
        op.execute(text(f"DROP INDEX {c}IF EXISTS ix_spans_output_value_trgm"))
        op.execute(text(f"DROP INDEX {c}IF EXISTS ix_spans_input_value_trgm"))
    finally:
        if concurrently:
            _disable_autocommit()
