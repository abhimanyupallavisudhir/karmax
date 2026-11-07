Write a small spreadsheet engine in Python 3 (standard library only) as a module `sheet.py` with a class `Sheet`:

- `Sheet().set(cell, text)` sets a cell's content; `get(cell)` returns its current value. Cell names are a column letter A–Z followed by a row number 1–99, case-insensitive (`b3` is `B3`). `set(cell, "")` clears a cell.
- Content that parses as a number (e.g. `3`, `-2.5`) is a number; content starting with `=` is a formula; anything else is text, returned as the string itself. An empty cell's value is `None`.
- Formulas support numbers, cell references, `+ - * /`, unary minus, parentheses with the usual precedence, and the functions `SUM`, `MIN`, `MAX` and `AVERAGE` (case-insensitive). Function arguments are separated by commas and each is an expression or a range like `A1:B3` (any two corners).
- In arithmetic an empty cell counts as 0, and text is an error. Functions skip empty and text cells in ranges; `MIN`/`MAX` of nothing is 0.
- Number results are returned as floats (or ints — either is fine) and formulas always see the latest values of the cells they use, however deep the chain.
- Errors are values, returned as these strings: `#DIV/0!` (division by zero, or `AVERAGE` of no numbers), `#VALUE!` (text used in arithmetic), `#NAME?` (unknown function), `#ERROR!` (a formula that does not parse, including a bad cell name), `#CYCLE!` (every cell on a reference cycle, and every cell whose formula depends on one). Any other formula that uses a cell holding an error has that same error; if several operands hold errors, the leftmost one in the formula wins.

Add tests.
