import os

workers = 2
worker_class = os.environ.get("WORKER_CLASS", "sync")
