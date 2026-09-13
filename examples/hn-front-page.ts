// Top stories on Hacker News with the Node library. Run with `node hn-front-page.ts` after
// `npm i patchrome` in your project, or from a checkout after `npm run build`.
import { CommandError, connect } from "patchrome";

const browser = connect({ session: `hn-ts-${process.pid}` });
try {
  await browser.run("open", "https://news.ycombinator.com/");
  const { rows } = await browser.run("extract", JSON.stringify({
    rows: "tr.athing",
    fields: { rank: ".rank", title: ".titleline > a", url: { selector: ".titleline > a", attr: "href" } },
    limit: 10,
  }), "--inline") as { rows: Array<{ rank: string; title: string; url: string }> };
  for (const story of rows) console.log(story.rank, story.title, story.url);
} catch (err) {
  if (err instanceof CommandError) console.error(`patchrome ${err.code}: ${err.message}`);
  throw err;
} finally {
  await browser.run("session", "close");
  browser.close();
}
