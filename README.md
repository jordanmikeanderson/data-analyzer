# Data Analyzer

Open a spreadsheet, pick two number columns, and see how they move together and which rows don't fit. Everything runs in your browser, so your file never gets uploaded anywhere.

This started as a scatter plot lab in my Master of Accounting analytics class. I kept adding to it until it turned into a real tool, with a lot of help from AI coding tools. If you use it or fork it, I'd love to hear about it!

Try it on my site: [jo-schmo.com](https://jo-schmo.com) (it's the Data Analyzer icon on the desktop), or download this repo and open `index.html`. It works offline too.

![Data Analyzer showing Utah home values against square footage](docs/screenshot.png)

## What it does

**Clean your file first**

- Keep only the columns you need (the Suggested button skips ID columns, mostly blank columns and long text)
- Drop rows with blanks in the columns you care about
- Filter rows (equals, contains, greater than, between, before/after a date...)
- Set allowed ranges, like "amount has to be above zero"
- Flag or remove unusual values
- Shrink a huge file down to a random sample that Excel can actually open
- Download the cleaned CSV plus a log of every step you took

**Then analyze it**

- Scatter plot with a trend line and a confidence band
- A plain English summary: how strong the link is, if it's probably just chance, and what the slope means
- The full regression numbers if you want them (slope, p-value, R², and the rest)
- **Rows to investigate:** the rows that sit furthest from the line, with a download
- "Strongest links to Y" ranks every number column against the one you picked
- Group comparisons and color coded dots by any column
- A leftovers (residual) view to check if a straight line even fits
- Save the chart as a PNG or download every row with its prediction

There's an About tab inside the app that explains what each number means.

## Good for

- **Accounting and audit:** set an expectation, like expenses vs. revenue across months or locations, and look into the items that miss it. That's the whole idea behind analytical procedures.
- **Real estate:** how price tracks size, age or lot size, and which homes look high or low for their size.
- **Business stuff:** sales vs. ad spend, hours vs. output, cost vs. volume.

## Try the sample

Click **Try sample data** to load 1,000 Utah homes, or add `?sample` to the end of the address.

It reads CSV files (comma, semicolon, tab or pipe). Money like `$1,250.00` and `(500)`, Excel's accounting format, percents and the usual date formats all get read correctly. Row numbers match Excel, so row 1 is the header.

## Limits

One X column at a time and straight lines only (simple linear regression). A strong pattern doesn't prove one thing causes the other. The chart shows up to 5,000 dots so it stays fast, but the math uses every row. Big files are slow: an 89 MB file with about 390,000 rows takes around 15 seconds to open. The max is 250 MB.

## How it's built

Plain HTML, CSS and JavaScript with no build step. The chart uses [D3](https://d3js.org) (included in `vendor/`) and the stats math is written from scratch in `js/stats.js` and checked against SciPy. Run the tests with Node 20+: `node --test`

It hides its own title bar when it runs inside another page, which is how it fits into a window on my Windows 95 site.

## Credits

Sample data: [Utah Housing Unit Inventory](https://gis.utah.gov/products/sgid/planning/housing-unit-inventory), State of Utah (SGID). 1,000 random single family homes in Davis, Salt Lake and Weber counties.

MIT license (see `LICENSE`). D3 is included under its own ISC license.
