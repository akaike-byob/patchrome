#!/usr/bin/env python3
"""Two pages of Hacker News stories, over one `patchrome pipe`."""

import itertools
import json
import os
import subprocess


class PatchromeError(Exception):
    def __init__(self, error):
        super().__init__(f"{error['code']}: {error['message']}")
        self.code = error["code"]
        self.hint = error.get("hint")


class Patchrome:
    """Sends CLI words to `patchrome pipe` and returns the `data` of each response."""

    def __init__(self, session):
        env = {**os.environ, "PATCHROME_SESSION": session}
        self._process = subprocess.Popen(["patchrome", "pipe"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
        self._ids = itertools.count(1)

    def run(self, *words):
        request_id = next(self._ids)
        self._process.stdin.write(json.dumps({"id": request_id, "argv": list(words)}) + "\n")
        self._process.stdin.flush()
        for line in self._process.stdout:
            message = json.loads(line)
            # Stream events from `watch` carry the same id and come before the response.
            if message["id"] != request_id or "stream" in message:
                continue
            if not message["ok"]:
                raise PatchromeError(message["error"])
            return message["data"]
        raise PatchromeError({"code": "daemon_unreachable", "message": "patchrome pipe exited"})

    def close(self):
        self.run("session", "close")
        self._process.stdin.close()
        self._process.wait()


browser = Patchrome(session=f"hn-py-{os.getpid()}")
try:
    browser.run("open", "https://news.ycombinator.com/")
    schema = json.dumps({"rows": "tr.athing", "fields": {"rank": ".rank", "title": ".titleline > a"}})
    for page in (1, 2):
        if page > 1:
            browser.run("click", "--role", "link", "--name", "More", "--exact")
            browser.run("wait", "--url", f"*?p={page}")
        for story in browser.run("extract", schema, "--inline")["rows"]:
            print(story["rank"], story["title"])
finally:
    browser.close()
