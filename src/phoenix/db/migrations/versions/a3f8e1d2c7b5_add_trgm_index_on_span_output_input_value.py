"""add pg_trgm GIN indexes on spans output.value and input.value

Revision ID: a3f8e1d2c7b5
Revises: d4e5f6a7b8c9
Create Date: 2026-07-31 00:00:00.000000

Enables the pg_trgm extension and creates GIN indexes on
spans.attributes->>'{output,value}' and spans.attributes->>'{input,value}'
so that the TextContains filter (which emits LIKE '%term%') can use
trigram index scans instead of a full sequential scan.

Without these indexes, filtering traces by output.value or input.value
performs a sequential scan of the entire spans table on every request,
taking 500ms+ once a few thousand traces are stored. On a production
installation with 100K spans and ~7 GB of trace data, searches take 45+
seconds.

Activation
----------
This migration is opt-in. It only creates the indexes when

    PHOENIX_ACTIVATE_FAST_FULL_TEXT_SEARCH_PSQL=true

is set in the environment. Without it the migration is a no-op. The flag
exists because the indexes consume significant disk space — roughly 15–30%
of the total size of the indexed text — which on a large installation with
long LLM responses can be several hundred megabytes to over a gigabyte.

Build time
----------
GIN trigram indexes are expensive to build on large tables because every
character in every stored value is decomposed into trigrams. LLM output
and input values can be several kilobytes each. Because Alembic runs
synchronously before Phoenix starts accepting connections, a long build
means Phoenix is unavailable for that duration.

Rough wall-clock estimates (Postgres 16, 8-core VM, default settings):

  rows     avg value size   build time
  -------  ---------------  ----------
  100 K    2 KB             ~1-5 min
    1 M    2 KB             ~10-30 min
   10 M    2 KB             ~2-4 h

Operators upgrading a large installation can pre-create the indexes
manually before upgrading (the migration skips via IF NOT EXISTS):

  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS ix_spans_output_value_trgm
    ON spans USING GIN ((attributes #>> '{output,value}') gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS ix_spans_input_value_trgm
    ON spans USING GIN ((attributes #>> '{input,value}') gin_trgm_ops);
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

def _is_active() -> bool:
    return (
        op.get_bind().dialect.name == "postgresql"
        and os.environ.get("PHOENIX_ACTIVATE_FAST_FULL_TEXT_SEARCH_PSQL", "").lower() == "true"
    )


def upgrade() -> None:
    if not _is_active():
        return

    op.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
    op.execute(text(
        "CREATE INDEX IF NOT EXISTS ix_spans_output_value_trgm "
        "ON spans USING GIN ((attributes #>> '{output,value}') gin_trgm_ops)"
    ))
    op.execute(text(
        "CREATE INDEX IF NOT EXISTS ix_spans_input_value_trgm "
        "ON spans USING GIN ((attributes #>> '{input,value}') gin_trgm_ops)"
    ))


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return

    op.execute(text("DROP INDEX IF EXISTS ix_spans_output_value_trgm"))
    op.execute(text("DROP INDEX IF EXISTS ix_spans_input_value_trgm"))
