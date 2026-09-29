"""Running Alembic inside the API must not switch uvicorn's loggers off.

`main._alembic_upgrade` runs `command.upgrade` in-process at startup. env.py
used to call `fileConfig(alembic.ini)` with the default
`disable_existing_loggers=True`, which disabled `uvicorn.error` and
`uvicorn.access` for the life of the process: no access log, and no
"Exception in ASGI application" traceback, after every deploy.
"""
import logging
import logging.config

from alembic import command
from uvicorn.config import LOGGING_CONFIG

from services.api import main


def test_in_process_alembic_leaves_uvicorn_loggers_enabled():
    logging.config.dictConfig(LOGGING_CONFIG)
    names = ("uvicorn", "uvicorn.error", "uvicorn.access")
    try:
        # `current` loads env.py exactly like `upgrade`, without changing the schema.
        command.current(main._alembic_config())
        assert [logging.getLogger(n).disabled for n in names] == [False, False, False]
    finally:
        for n in names:
            logging.getLogger(n).disabled = False
