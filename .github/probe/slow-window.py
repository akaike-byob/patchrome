import re, sys
from datetime import datetime
lines = open(sys.argv[1], errors="replace").read().splitlines()
stamp = lambda l: datetime.fromisoformat(l[:24].replace("Z", "+00:00"))
for i, l in enumerate(lines):
    if "pw:api => locator.isVisible started" in l or "pw:api => page.title started" in l:
        name = "isVisible" if "isVisible" in l else "page.title"
        for j in range(i + 1, len(lines)):
            if f"pw:api <= {'locator.isVisible' if name == 'isVisible' else 'page.title'} succeeded" in lines[j]:
                ms = (stamp(lines[j]) - stamp(l)).total_seconds() * 1000
                if ms > 800:
                    print(f"--- slow {name} {ms:.0f} ms")
                    for k in lines[max(0, i - 3): j + 2]:
                        print(k[:260])
                break
