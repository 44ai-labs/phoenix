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

Build time and blocking behaviour
----------------------------------
GIN trigram indexes are expensive to build on large tables because every
character in every stored value is decomposed into trigrams. LLM output
and input values can be several kilobytes each, which makes the per-row
cost significantly higher than a typical text column.

Rough wall-clock estimates (Postgres 16, 8-core VM, default settings):

  rows     avg value size   non-CONCURRENTLY   CONCURRENTLY
  -------  ---------------  -----------------  ------------
  100 K    2 KB             ~1 min             ~2 min
    1 M    2 KB             ~10-20 min         ~25-40 min
   10 M    2 KB             ~2-4 h             ~5-8 h

Because Alembic runs synchronously before Phoenix starts accepting
connections, a long build means Phoenix is unavailable for the entire
duration. Operators upgrading an installation with >500 K spans should
use the pre-create approach described below.

maintenance_work_mem
--------------------
The migration raises maintenance_work_mem to 512 MB for the session
before building each index. This reduces the number of in-memory sort
passes Postgres must make and typically cuts build time by 30-50 % on
tables where the default 128 MB causes multiple merge passes. The
setting is restored afterward and has no effect on normal queries.

CONCURRENTLY support (opt-in via PHOENIX_MIGRATE_INDEX_CONCURRENTLY=true)
--------------------------------------------------------------------------
CREATE INDEX CONCURRENTLY cannot run inside a transaction. The workaround
is identical to the one used in f1a6b2f0c9d5: commit the current
transaction and enable autocommit at the DBAPI level before issuing the
DDL, then restore transactional mode afterward.

Tradeoffs:
- CONCURRENTLY avoids an exclusive write lock during the build, which
  matters for rolling deployments where an existing Phoenix instance is
  still ingesting spans.
- CONCURRENTLY is ~2-3x slower (two heap passes) and breaks transactional
  migration guarantees: if the build fails, a partial INVALID index is
  left behind and must be dropped manually before retrying.
- maintenance_work_mem is still applied with CONCURRENTLY and still helps.

Pre-create pattern for large installations (recommended for >500 K spans)
--------------------------------------------------------------------------
Pre-creating the indexes while the old Phoenix version is running lets the
migration complete instantly (IF NOT EXISTS detects the names and skips):

  1. While the old version is still running:

       CREATE EXTENSION IF NOT EXISTS pg_trgm;

       -- run each in a separate psql session; they can overlap
       CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_spans_output_value_trgm
         ON spans USING GIN ((attributes #>> '{output,value}') gin_trgm_ops);

       CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_spans_input_value_trgm
         ON spans USING GIN ((attributes #>> '{input,value}') gin_trgm_ops);

     Tip: SET maintenance_work_mem = '1 GB' in each session first to
     speed up the build.

  2. Upgrade Phoenix. The migration sees the index names and skips.
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

# Raised from the Postgres default (128 MB) to reduce sort passes during the
# GIN trigram build. LLM output/input values can be several KB each, so the
# default is often insufficient for a single-pass build on moderate tables.
_MAINTENANCE_WORK_MEM = "512 MB"


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
        # SET (not SET LOCAL) so the value survives in autocommit mode too.
        # RESET restores the original value afterward so subsequent migrations
        # on the same connection are not affected.
        op.execute(text(f"SET maintenance_work_mem = '{_MAINTENANCE_WORK_MEM}'"))
        try:
            op.execute(text(
                f"CREATE INDEX {c}IF NOT EXISTS ix_spans_output_value_trgm "
                f"ON spans USING GIN ((attributes #>> '{{output,value}}') gin_trgm_ops)"
            ))
            op.execute(text(
                f"CREATE INDEX {c}IF NOT EXISTS ix_spans_input_value_trgm "
                f"ON spans USING GIN ((attributes #>> '{{input,value}}') gin_trgm_ops)"
            ))
        finally:
            op.execute(text("RESET maintenance_work_mem"))
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
