import sys
front = [(int(t), app) for t, app in (l.split(" ", 1) for l in open(sys.argv[1]).read().splitlines() if " " in l)]
marks = [(int(t), rest) for t, rest in (l.split(" ", 1) for l in open(sys.argv[2]).read().splitlines())]
spells = []
for (t, app), nxt in zip(front, front[1:] + [(front[-1][0], "end")]):
    if app == "com.google.Chrome":
        spells.append((t, nxt[0] - t))
print(f"chrome_front_spells={len(spells)} total_ms={sum(d for _, d in spells)}")
for t, d in spells:
    running = [rest for mt, rest in marks if mt <= t]
    last = running[-1] if running else "before first test"
    print(f"  {d:6d} ms  during: {last}")
