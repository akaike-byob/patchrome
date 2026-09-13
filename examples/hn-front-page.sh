#!/bin/sh
# Top stories on Hacker News as JSON rows, one patchrome command per step.
# Needs patchrome on PATH and jq for reading --json output.
set -eu
export PATCHROME_SESSION="${PATCHROME_SESSION:-hn-sh-$$}"
trap 'patchrome session close >/dev/null' EXIT

patchrome open https://news.ycombinator.com/ >/dev/null
patchrome wait --selector 'tr.athing' >/dev/null
patchrome --json extract '{
  "rows": "tr.athing",
  "fields": {
    "rank": ".rank",
    "title": ".titleline > a",
    "url": {"selector": ".titleline > a", "attr": "href"}
  },
  "limit": 10
}' --inline | jq -c '.data.rows[]'
