# Hard pages: iframes, shadow roots, CAPTCHAs, bot walls

## iframes

Snapshots include iframes, cross-site ones too; their refs carry a different frame prefix, like
`@f2e4`. Locators need the frame: `click --role checkbox --name Verify --frame 'iframe[title*=widget]'`.

## Closed shadow roots

A widget inside a closed shadow root shows up empty in the snapshot. CSS selectors pierce it:

```bash
patchrome click --selector '#cb' --frame 'iframe[src*="challenges"]'
patchrome fill --selector 'input#code' --frame 'iframe' 123456
```

## Canvas and anything without an element

Take a screenshot, read the pixel position, then:

```bash
patchrome click --at 120,340     # trusted click at viewport pixels, into whatever iframe is under it
patchrome type "hello"           # trusted keystrokes into the focused element
```

## CAPTCHAs

Never solve one yourself: not by clicking its checkbox, reading its images or typing its characters.

```bash
patchrome challenge              # none | pending | solved, with vendor and box
patchrome challenge --handoff    # raises the tab for the user, waits up to 10 min
```

When `challenge` reports `pending`, tell the user, run `challenge --handoff`, and carry on once it
prints `solved` or `none`.

## Bot-wall interstitials

"Just a moment", "Prove your humanity" and similar pages often clear by themselves within seconds. One
early read reports a block that is not there:

```bash
patchrome open https://www.reddit.com/r/programming/
patchrome wait --title "Prove your humanity" --gone --timeout-ms 20000
patchrome snapshot
```

Only a wait that times out means blocked. Then run `challenge`, and hand off if it reports `pending`.
