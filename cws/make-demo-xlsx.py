#!/usr/bin/env python3
"""
Build a demo spreadsheet for screenshots and manual testing.

    python3 cws/make-demo-xlsx.py

WHY A GENERATED FILE. The obvious thing to attach in a screenshot is a real
spreadsheet off the machine, and the real one to hand was SPACInsider customer
data. A public listing screenshot is forever and is indexed; nothing with a
client's name in it can go there.

So this is entirely invented — no real company, product or person — while still
being the SHAPE of a real work file: four regions, twelve months, four product
lines, plausible unit economics, and one segment quietly going wrong so that
asking about it has an answer worth reading.

DELIBERATELY BIGGER THAN THE PREVIEW, and arranged so the preview MISLEADS.
192 rows is 7,300 characters; the 1,500 the message carries reach row 40. Rows
run month-first, so EMEA field sensors look healthy all the way through the
visible part and only go negative in October, at row 146. A model answering
from the preview says the business is fine, confidently and wrongly — so this
file demonstrates `read_attachment` rather than merely requiring it.

Written by hand rather than with a library because this package has no
dependencies and an .xlsx is a zip of XML we already know the shape of: the
reader in `packages/extension/src/panel/ooxml.ts` parses exactly these parts.
"""

import zipfile
from pathlib import Path

OUT = Path(__file__).parent / "demo-regional-sales-2026.xlsx"

REGIONS = ["EMEA", "APAC", "Americas", "LATAM"]
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
LINES = ["Field Sensors", "Gateway Units", "Analytics Seats", "Support Plans"]

# Unit price and baseline margin per product line. Field Sensors is the story:
# it ships the most units and earns the least, and in EMEA the margin goes
# negative by Q3 — a finding a summary of the first page would miss entirely.
BASE = {
    "Field Sensors":   (42, 11),
    "Gateway Units":   (310, 28),
    "Analytics Seats": (95, 71),
    "Support Plans":   (140, 63),
}
# ROWS RUN MONTH-FIRST, so a trend that develops over the year is only visible
# by reading to the END of the file. The EMEA sensor margin goes negative in
# October — row 150-odd, far past the 1,500 characters the message carries — so
# the preview alone gives you the wrong answer with total confidence. That is
# the whole point of the screenshot.
def sensor_units(region, m):
    base = {"EMEA": 600, "APAC": 410, "Americas": 330, "LATAM": 140}[region]
    return base + m * (34 if region == "EMEA" else 9)


def sensor_margin(region, m):
    if region == "EMEA":
        return 12 - m * 2          # 12% in January, -10% in December
    if region == "APAC":
        return 11 - m // 3
    return 11


def rows():
    out = [["Month", "Region", "Product line", "Units", "Revenue (USD)", "Margin %"]]
    for m, month in enumerate(MONTHS):
        for region in REGIONS:
            for line in LINES:
                price, margin = BASE[line]
                if line == "Field Sensors":
                    n = sensor_units(region, m)
                    margin = sensor_margin(region, m)
                else:
                    seed = (len(region) * 37 + len(line) * 53 + m * 11) % 90
                    n = 180 + seed * 5 + m * 12
                    margin += (m % 3) - 1
                out.append([month, region, line, n, n * price, margin])
    return out


def col(i: int) -> str:
    s = ""
    while i >= 0:
        s = chr(ord("A") + i % 26) + s
        i = i // 26 - 1
    return s


def build() -> None:
    data = rows()

    strings, index = [], {}
    for row in data:
        for cell in row:
            if isinstance(cell, str) and cell not in index:
                index[cell] = len(strings)
                strings.append(cell)

    body = []
    for r, row in enumerate(data, start=1):
        cells = []
        for c, cell in enumerate(row):
            ref = f"{col(c)}{r}"
            if isinstance(cell, str):
                cells.append(f'<c r="{ref}" t="s"><v>{index[cell]}</v></c>')
            else:
                cells.append(f'<c r="{ref}"><v>{cell}</v></c>')
        body.append(f'<row r="{r}">{"".join(cells)}</row>')

    sst = "".join(f"<si><t>{s}</t></si>" for s in strings)

    parts = {
        "[Content_Types].xml":
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
            '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
            "</Types>",
        "_rels/.rels":
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
            '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
            "</Relationships>",
        "xl/workbook.xml":
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets><sheet name="Regional sales" sheetId="1" r:id="rId1"/></sheets>'
            "</workbook>",
        "xl/_rels/workbook.xml.rels":
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
            '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            "</Relationships>",
        "xl/worksheets/sheet1.xml":
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f'<dimension ref="A1:F{len(data)}"/>'
            '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
            '<sheetFormatPr defaultRowHeight="15"/>'
            '<cols><col min="1" max="1" width="8"/><col min="2" max="2" width="11"/>'
            '<col min="3" max="3" width="17"/><col min="4" max="6" width="14"/></cols>'
            f'<sheetData>{"".join(body)}</sheetData></worksheet>',
        "xl/sharedStrings.xml":
            '<?xml version="1.0" encoding="UTF-8"?>'
            f'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            f'count="{sum(1 for row in data for c in row if isinstance(c, str))}" '
            f'uniqueCount="{len(strings)}">{sst}</sst>',
        "xl/styles.xml":
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
            '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
            '<borders count="1"><border/></borders>'
            '<cellStyleXfs count="1"><xf/></cellStyleXfs>'
            '<cellXfs count="1"><xf xfId="0"/></cellXfs>'
            "</styleSheet>",
        "docProps/core.xml":
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<cp:coreProperties '
            'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/">'
            "<dc:title>Regional sales 2026</dc:title>"
            "<dc:creator>Atlarix demo</dc:creator>"
            "</cp:coreProperties>",
        "docProps/app.xml":
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
            "<Application>Atlarix</Application></Properties>",
    }

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for name, content in parts.items():
            z.writestr(name, content)

    print(f"{OUT}  {OUT.stat().st_size:,} bytes, {len(data) - 1} data rows")


if __name__ == "__main__":
    build()
