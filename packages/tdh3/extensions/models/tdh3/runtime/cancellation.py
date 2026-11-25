"""Cooperative cancellation; the parent separately enforces hard containment."""
import asyncio
import signal

_requested = False
_task = None


class OperationCancelled(Exception):
    pass


def install():
    """Main-process only, before reading stdin. Never installed during import."""
    def stop(_signum, _frame):
        global _requested
        if _requested:
            return
        _requested = True
        if _task is not None and not _task.done():
            _task.get_loop().call_soon_threadsafe(_task.cancel)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)


def check():
    if _requested:
        raise OperationCancelled("operation_cancelled")


def run(awaitable, timeout):
    async def bounded():
        global _task
        _task = asyncio.current_task()
        try:
            check()
            result = await asyncio.wait_for(awaitable, timeout)
            check()
            return result
        except asyncio.CancelledError as error:
            raise OperationCancelled("operation_cancelled") from error
        finally:
            _task = None
            # A signal before wait_for must not leak an unawaited coroutine.
            awaitable.close()
    return asyncio.run(bounded())
