# Scraping

## Read the API response first

Most shops and apps render from JSON. The response the page already fetched beats parsing HTML:

```bash
patchrome open https://shop.example/product/42 --wait networkidle
patchrome network list --type xhr,fetch        # n17 t2 200 fetch GET https://shop.example/api/product/42 88ms
patchrome network get n17 --body               # JSON inline, or a file path past 2 KB
patchrome network get --url '*/api/product/*' --body --inline   # by URL: the newest match
```

A response body lives only as long as its page. Read it before navigating away, or `tab_gone` follows.

## Rows from HTML

```bash
patchrome extract '{"rows": "li.product", "fields": {"name": "h2", "url": {"selector": "a", "attr": "href"}, "tags": {"selector": ".tag", "all": true}}, "limit": 50}'
```

- A field is a selector string (its visible text), or `{selector, attr, all}`.
- No `selector` means the row itself. `href` and `src` come back absolute. A missing element is `null`.
- Pass a file path instead of inline JSON for long schemas.
- `--role`, `--selector` or `--ref` limits rows to inside one element.

## Globs

Globs match the whole URL: `*` is any run of characters, `?` one character. `*/api/items` does not
match `/api/items?page=2`; write `*/api/items*`. Quote them in the shell.

## Recording and shaping traffic

```bash
patchrome network har start
# ... browse ...
patchrome network har stop --out traffic.har     # your session's requests, with text bodies
patchrome route block '*/analytics/*'
patchrome route mock '*/api/flags*' flags.json
patchrome route clear
```

Routes intercept every request on your tabs while any rule exists, which turns off the cache. Clear
them when done.

## Pages that change after load

- `click` returns once the click lands; `wait --url` or `wait --text` for the next page before reading.
- Paginate with a locator: `click --role link --name Next --exact`, then `wait --url '*page=2*'`.
- Keep volume low on protected sites: one page at a time, no tight `goto` loops.
- For a scrape the user will rerun, pass `--inline` or `--out <file>` so output keeps one shape.
