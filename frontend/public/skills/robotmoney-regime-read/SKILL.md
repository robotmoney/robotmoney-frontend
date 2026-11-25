---
name: robotmoney-regime-read
description: Write a plain-language qualitative read of the Robot Money regime from its raw snapshot data, with web research on the news behind the moves. Use when asked to explain, read, interpret, summarize or narrate the regime, the composite, the panels (macro, on-chain, equity factor) or the indicators; when asked "why is the composite low/high", "what is driving the regime", "is it really that bad", "give me a qualitative read on the indicators", "what do the indicators say", "what's behind the numbers", "regime commentary", "market read", "regime narrative" or "daily regime note"; or when given a regime-snapshots response from the Robot Money API and asked what it means.
compatibility: Needs the Bun runtime (bun 1.2 or later) to run scripts/regime-read.ts, and a web search tool for step 2. Network access to read the live API.
metadata:
  owner: Robot Money
  source: https://robotmoney.network/skills/robotmoney-regime-read/SKILL.md
---

# Regime read

Turn one regime snapshot into a short qualitative read: what the composite says, which indicators drive it, what is
happening in markets behind those moves, and what it adds up to. The script produces every model number. Web search
supplies the reasons. You write the prose.

## 1. Get the facts

Run the script on the data you were given. It needs nothing but Bun. If you have only this file, fetch the script
and its references first:

```sh
base=https://robotmoney.network/skills/robotmoney-regime-read
mkdir -p scripts references
curl -fsSL $base/scripts/regime-read.ts -o scripts/regime-read.ts
curl -fsSL $base/references/indicators.md -o references/indicators.md
curl -fsSL $base/references/example-read.md -o references/example-read.md
```

```sh
bun scripts/regime-read.ts                      # live production API (range=400): the regime the site shows
bun scripts/regime-read.ts --methodology v5     # one methodology's line from the live API
bun scripts/regime-read.ts <file.json>          # a saved response
bun scripts/regime-read.ts <url>                # any URL that returns the same response
bun scripts/regime-read.ts <source> --json      # the same facts as JSON
bun scripts/regime-read.ts --guide              # the indicator guide (also in references/indicators.md)
```

The input is the response of `GET /api/dashboards/regime-snapshots` (`{ latest, history, staleness }`). The live API's
`range=400` has 400 days, so its history comparisons cover only those days. The fact sheet opens with a **Source**
line. Anything other than the live production API is not the published regime: put "not production" and the source in
the headline of the read, and never describe it as the current regime. A line read with `--methodology` may be
published beside the regime the site shows: name its methodology in the headline.

If the script fails or the data says it is stale, report that and stop. Do not write a read from memory. If the
fact sheet says the response has no staleness check (a saved file), state the as-of date in the headline. The
script also stops when it cannot tell which panels the composite averages: report that error, do not guess.

## 2. Research the moves

The fact sheet ends with a **Research brief**: the date window, the drivers to explain (the indicators pulling the
composite down and holding it up, and any indicator at the top or bottom of its 3-year range) and the panels that
moved over 30 days. It says what to explain. It does not say what to search. You write the questions.

1. **Write your questions first.** For each driver, write 2 to 4 questions you need answered to explain it. Cover:
   - what changed and when (did the level move inside the window, or has it been there for months?)
   - what event, data release or decision came with the move
   - who was buying or selling, or which part of the market moved most
   - whether the same cause shows up in other drivers.

   Then write 1 or 2 questions across all drivers, for example whether one event links the stock, credit and crypto
   moves. Write them down before searching.
2. **Turn each question into searches.** Use the words a news headline or a data provider would use, and add the
   month and year. One question can need several searches.
3. **Follow the answers.** When a result names a cause (a central bank decision, an earnings report, a fund
   outflow), ask the next question about that cause and check it in a second source. Stop on a driver when you have
   a sourced explanation, or after about three searches with nothing. Then write "no clear cause found" for it.
4. **Keep notes** as `driver → question → finding → source, date`. The read uses only findings that have a source.

If you have no web search tool, say so in the read and skip this step.

Source rules:
- **Prefer primary data and major outlets:** central banks (federalreserve.gov), statistics agencies (BLS, Treasury),
  FRED, on-chain data firms (Glassnode, DefiLlama, Coin Metrics, CryptoQuant), and major news outlets (Reuters,
  Bloomberg, CNBC, WSJ, FT, CoinDesk, The Block). A claim found only on a blog, a content farm or a self-published
  page must be checked against one of these before you use it; if you can't check it, leave it out.
- **Dates:** use events from the 30 days up to the as-of date. An event after the as-of date can be mentioned only if
  you label it as later than the data.
- **Conflicts:** when sources give different figures for the same thing, use the primary source, or leave the figure
  out and describe the event without it.
- **Model numbers stay the model's:** never replace an indicator value from the fact sheet with an outside figure
  for the same series. Outside numbers (a price, a fund flow, an index move) are allowed only with a citation.
- **Cause, carefully:** write "came as" or "after" when a source reports a link; write "because" only when a source
  says so.

## 3. Write the read

Structure:

1. **Headline line:** date, model, source and label with the composite. Example: "Regime read, November 20, 2026
   (model v3, live API): risk-off, composite 0.32".
2. **Summary (2 or 3 sentences):** where the pressure comes from and what is holding up. Name themes, not every
   indicator.
3. **How the composite got here (2 or 3 sentences):** the panel values, how the composite is built (use the fact
   sheet's composite rule), where today sits in the history provided, and the 30- and 90-day path.
4. **One section per panel:** a bold heading naming the panel and what it shows overall, then 3 to 6 bullets. Lead
   with the indicators in "Pulling the composite down" and "Holding it up". Each bullet: name, level, model reading
   percentile, the meaning in plain words, then the news behind it with a numbered citation `[n]` when research found
   one. Say "holding it up" or "pointing the other way" for indicators against the trend.
5. **What it adds up to (2 or 3 sentences):** which forces dominate, what offsets them, and how this compares with
   the history provided.
6. **Sources:** a numbered list: outlet, headline, date, URL.

See `references/example-read.md` for a full example of structure, tone and citations.

## Rules

- **Numbers:** every model number comes from the fact sheet, rounded as the sheet rounds it. Do not compute new
  statistics (differences, averages, ratios). Outside numbers need a citation.
- **Percentiles:** the "model reading" is the percentile after the sign flip: low is always risk-off. The "level"
  percentile is where the raw value sits in its own last 3 years. Use the model reading in bullets, and use the
  level to describe the raw value ("at the top of its 3-year range").
- **Model:** the API names the methodology on every row. `v*` names are production methodologies: v3, v4 and v5,
  each with its own composite rule, which the fact sheet states. Every other model is an experiment named
  `experiment-<name>`. For an experiment, put "experimental, not
  deployed" and its name in the headline, and never call it the regime or give it a version number. An experiment's
  composite may not be the plain average of its panels: when the sheet's 1/n mean and the composite differ a lot,
  say so. The script stops on any other model name: report that error, do not guess, and get the latest skill from
  https://robotmoney.network/skills/robotmoney-regime-read/SKILL.md.
- **Panels outside the composite:** if a panel is "context only", say so and keep it out of "what it adds up to".
- **Language:** 10th-grade reading level, short sentences, common words. Keep industry terms (credit spread, real
  yield, VIX, TVL, MVRV, DeFi, stablecoin, percentile, correction) and explain each in plain words the first time.
- **Tone:** state facts. No hyperbole, slogans, metaphors or predictions, including predictions quoted from analysts.
  Do not say what will happen next.
- **No advice:** this is a description of the data and the news, not investment advice. Do not recommend buying,
  selling or sizing any position.
- **Length:** 300 to 500 words plus sources, unless asked for more or less.

## Files

- `scripts/regime-read.ts`: reads the response and prints the facts and the research brief (markdown or `--json`).
  The indicator guide lives in this file (`GUIDE`), so the meanings stay the same in every read.
- `references/indicators.md`: the guide as a table (`--guide` output).
- `references/example-read.md`: an example read with cited context.
