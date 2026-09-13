import sys
rows = [line.split(" ", 1) for line in open(sys.argv[1]).read().splitlines() if " " in line]
rows = [(int(t), app) for t, app in rows]
spells = []
for (t, app), nxt in zip(rows, rows[1:] + [(rows[-1][0], "end")]):
    if app == "com.google.Chrome":
        spells.append(nxt[0] - t)
print(f"chrome_front_spells={len(spells)} total_ms={sum(spells)} max_ms={max(spells, default=0)} spells_ms={sorted(spells)}")
print("apps:", sorted({app for _, app in rows}))
